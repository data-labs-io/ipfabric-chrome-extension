// background.js - MCP client + extension orchestration
//
// Responsibilities:
//   - Persist + read user configuration (MCP URL, auth header, tool name)
//   - Speak MCP Streamable HTTP transport to the IP Fabric server:
//       1. initialize  -> server returns Mcp-Session-Id header
//       2. notifications/initialized
//       3. tools/list  -> discover the "global search" tool
//       4. tools/call  -> run the search with the user's query
//   - Parse JSON or SSE responses (the spec allows either)
//   - Inject the content overlay when the toolbar icon or shortcut fires
//   - Bridge messages between popup/content scripts and the MCP server

const DEFAULT_CONFIG = {
  mcpUrl: "https://demo2.eu.ipfabric.io/mcp",
  // No secret is bundled. The user supplies the IP Fabric MCP
  // Authorization header in Options; it is read from chrome.storage.sync.
  authHeader: "",
  // Optional overrides. When empty, the background script auto-discovers
  // a tool whose name looks like a global search (e.g. "global_search").
  toolName: "",
  argName: "",
  // LLM provider configuration. "claude" (default) uses the Anthropic
  // Messages API; "openai-compatible" uses any OpenAI /chat/completions
  // endpoint (OpenAI, Azure OpenAI, Together, Groq, Ollama, LM Studio,
  // vLLM, LocalAI, etc.). These mirror the Demo Advisor's provider model.
  llmProvider: "claude",
  llmModel: "",          // empty => provider default
  llmBaseUrl: "",        // OpenAI-compatible base URL, e.g. http://localhost:1234/v1
  openaiApiKey: "",      // key for the OpenAI-compatible endpoint (optional for local)
};

// Cached session state. The service worker can be evicted at any time,
// so this is best-effort; we re-initialize whenever we have no session.
let mcpState = {
  sessionId: null,
  protocolVersion: null,
  tools: null,
  requestId: 0,
};

function nextId() {
  mcpState.requestId += 1;
  return mcpState.requestId;
}

async function getConfig() {
  const stored = await chrome.storage.sync.get(DEFAULT_CONFIG);
  return { ...DEFAULT_CONFIG, ...stored };
}

/**
 * Send a single JSON-RPC request/notification to the MCP server.
 * Returns { json, sessionId } where json is the parsed JSON-RPC response
 * (or null for notifications) and sessionId is any session header the
 * server returned on this call.
 */
async function mcpFetch(payload, { config, sessionId, isNotification = false } = {}) {
  const headers = {
    "Content-Type": "application/json",
    // MCP Streamable HTTP requires the client to accept both formats.
    "Accept": "application/json, text/event-stream",
    "Authorization": config.authHeader,
  };
  if (sessionId) headers["Mcp-Session-Id"] = sessionId;
  if (mcpState.protocolVersion) headers["MCP-Protocol-Version"] = mcpState.protocolVersion;

  const res = await fetch(config.mcpUrl, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });

  const newSessionId = res.headers.get("Mcp-Session-Id") || sessionId || null;

  // Notifications return 202 Accepted with no body.
  if (isNotification || res.status === 202) {
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`MCP notification failed (${res.status}): ${text}`);
    }
    return { json: null, sessionId: newSessionId };
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`MCP request failed (${res.status}): ${text || res.statusText}`);
  }

  const contentType = res.headers.get("content-type") || "";
  const bodyText = await res.text();

  let json;
  if (contentType.includes("text/event-stream")) {
    json = parseSseForJsonRpc(bodyText, payload.id);
  } else {
    // Some servers return plain JSON or a JSON array.
    const parsed = JSON.parse(bodyText);
    json = Array.isArray(parsed)
      ? parsed.find((m) => m && m.id === payload.id) || parsed[0]
      : parsed;
  }

  if (json && json.error) {
    throw new Error(`MCP error ${json.error.code}: ${json.error.message}`);
  }
  return { json, sessionId: newSessionId };
}

/**
 * Pull the JSON-RPC response with the given id out of an SSE payload.
 * SSE frames look like:
 *   event: message
 *   data: {"jsonrpc":"2.0","id":1,"result":{...}}
 *   <blank line>
 */
function parseSseForJsonRpc(text, wantedId) {
  const events = text.split(/\r?\n\r?\n/);
  let fallback = null;
  for (const raw of events) {
    if (!raw.trim()) continue;
    const dataLines = raw
      .split(/\r?\n/)
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trimStart());
    if (!dataLines.length) continue;
    const payload = dataLines.join("\n");
    try {
      const obj = JSON.parse(payload);
      if (obj && obj.id === wantedId) return obj;
      if (!fallback && obj && obj.jsonrpc === "2.0") fallback = obj;
    } catch (_) {
      // Skip non-JSON SSE comments / keep-alive lines.
    }
  }
  return fallback;
}

async function ensureSession(config) {
  if (mcpState.sessionId && mcpState.tools) return;

  // Reset in case a partial session is hanging around.
  mcpState.sessionId = null;
  mcpState.tools = null;

  const initPayload = {
    jsonrpc: "2.0",
    id: nextId(),
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "ipfabric-global-search-extension", version: "1.0.0" },
    },
  };
  const initRes = await mcpFetch(initPayload, { config });
  if (!initRes.json || !initRes.json.result) {
    throw new Error("MCP initialize returned no result");
  }
  mcpState.sessionId = initRes.sessionId;
  mcpState.protocolVersion = initRes.json.result.protocolVersion || "2025-06-18";

  // Required handshake step: notify the server we're ready.
  await mcpFetch(
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { config, sessionId: mcpState.sessionId, isNotification: true }
  );

  // Discover tools so we can find the global-search one.
  const listRes = await mcpFetch(
    { jsonrpc: "2.0", id: nextId(), method: "tools/list" },
    { config, sessionId: mcpState.sessionId }
  );
  mcpState.tools = (listRes.json && listRes.json.result && listRes.json.result.tools) || [];
}

/**
 * Pick the best tool for "global search" given the user's configuration
 * and the tool list reported by the server. Preference order:
 *   1. Exact name match from config
 *   2. A tool literally named "global_search" / "globalSearch" / "global-search"
 *   3. A tool whose name contains both "global" and "search"
 *   4. A tool whose name contains "search"
 */
function chooseSearchTool(tools, configuredName) {
  if (!tools || !tools.length) return null;
  if (configuredName) {
    const exact = tools.find((t) => t.name === configuredName);
    if (exact) return exact;
  }
  const norm = (s) => (s || "").toLowerCase().replace(/[^a-z]/g, "");
  const named = tools.find((t) => ["globalsearch"].includes(norm(t.name)));
  if (named) return named;
  const both = tools.find(
    (t) => norm(t.name).includes("global") && norm(t.name).includes("search")
  );
  if (both) return both;
  const search = tools.find((t) => norm(t.name).includes("search"));
  if (search) return search;
  return null;
}

/**
 * Figure out which argument name to pass the query under. Inspects the
 * tool's JSON schema for required string properties, falling back to
 * common names like "query" / "search" / "term".
 */
function chooseArgName(tool, configuredArg) {
  if (configuredArg) return configuredArg;
  const schema = (tool && tool.inputSchema) || {};
  const props = schema.properties || {};
  const candidates = ["query", "search", "term", "text", "q", "keyword", "input"];
  for (const c of candidates) if (props[c]) return c;
  if (Array.isArray(schema.required) && schema.required.length) return schema.required[0];
  const first = Object.keys(props)[0];
  return first || "query";
}

/**
 * Run a global search against the MCP server. Re-initializes the session
 * once on failure (covers the case where the server has evicted us).
 */
async function runGlobalSearch(query) {
  const config = await getConfig();
  let attempt = 0;
  while (true) {
    attempt += 1;
    try {
      await ensureSession(config);
      const tool = chooseSearchTool(mcpState.tools, config.toolName);
      if (!tool) {
        throw new Error(
          "No suitable 'global search' tool was found on the MCP server. " +
            "Open the extension Options page and set a Tool name manually."
        );
      }
      const argName = chooseArgName(tool, config.argName);
      const callRes = await mcpFetch(
        {
          jsonrpc: "2.0",
          id: nextId(),
          method: "tools/call",
          params: { name: tool.name, arguments: { [argName]: query } },
        },
        { config, sessionId: mcpState.sessionId }
      );
      return {
        tool: { name: tool.name, description: tool.description || "", argName },
        result: (callRes.json && callRes.json.result) || null,
      };
    } catch (err) {
      // One retry: drop the cached session in case it expired.
      if (attempt === 1) {
        mcpState.sessionId = null;
        mcpState.tools = null;
        continue;
      }
      throw err;
    }
  }
}

async function listTools() {
  const config = await getConfig();
  mcpState.sessionId = null;
  mcpState.tools = null;
  await ensureSession(config);
  return mcpState.tools || [];
}

/**
 * Generic tool invocation against the IP Fabric MCP server. Used by
 * the LLM agentic loop to execute Claude's tool_use calls. Reuses the
 * existing session + auth machinery from runGlobalSearch.
 *
 * Returns the raw tools/call result on success; on error, returns
 * { _error: true, message: "..." } so the caller can surface the
 * failure back to Claude as a tool_result with is_error: true.
 */
async function callMcpTool(toolName, args) {
  const config = await getConfig();
  let attempt = 0;
  while (true) {
    attempt += 1;
    try {
      await ensureSession(config);
      const callRes = await mcpFetch(
        {
          jsonrpc: "2.0",
          id: nextId(),
          method: "tools/call",
          params: { name: toolName, arguments: args || {} },
        },
        { config, sessionId: mcpState.sessionId }
      );
      return (callRes.json && callRes.json.result) || null;
    } catch (err) {
      if (attempt === 1) {
        // Session may have expired — drop it and retry once.
        mcpState.sessionId = null;
        mcpState.tools = null;
        continue;
      }
      throw err;
    }
  }
}

/* ---------------------------------------------------------------------- */
/* Message routing                                                        */
/* ---------------------------------------------------------------------- */

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  // Wrap sendResponse so we (a) only call it once and (b) swallow the
  // "Attempting to use a disconnected port object" error that fires
  // when the sender already gave up (e.g. user pressed Esc, navigated
  // away, or the service worker was terminated and restarted). Without
  // this guard the unhandled exception bubbles up as the user-visible
  // "message channel closed before a response was received" warning.
  let responded = false;
  const respond = (payload) => {
    if (responded) return;
    responded = true;
    try { sendResponse(payload); }
    catch (e) { console.warn("[ipf-gs:bg] sendResponse failed (channel closed):", e?.message || e); }
  };

  (async () => {
    try {
      if (msg.type === "GLOBAL_SEARCH") {
        const data = await runGlobalSearch(msg.query);
        respond({ ok: true, data });
      } else if (msg.type === "LIST_TOOLS") {
        const tools = await listTools();
        respond({ ok: true, data: tools });
      } else if (msg.type === "RESET_SESSION") {
        mcpState = { sessionId: null, protocolVersion: null, tools: null, requestId: 0 };
        respond({ ok: true });
      } else if (msg.type === "OPEN_OPTIONS" || msg.type === "IPFSD_OPEN_OPTIONS") {
        // IPFSD_OPEN_OPTIONS is the Diff Dashboard's gear button (diff-content.js);
        // routed here so both features open the same combined Options page.
        chrome.runtime.openOptionsPage();
        respond({ ok: true });
      } else if (msg.type === "LLM_MCP_SEARCH") {
        const data = await runLlmMcpSearch(msg.query);
        respond({ ok: true, data });
      } else if (msg.type === "INTERACTIVE_PROMPT") {
        const data = await runInteractivePrompt(msg.prompt);
        respond({ ok: true, data });
      } else if (msg.type === "CVE_EVALUATE") {
        const data = await runCveEvaluation();
        respond({ ok: true, data });
      } else if (msg.type === "LLM_PROBE") {
        // Quick connectivity test: same headers, same model, NO MCP
        // connector. If this works but LLM_MCP_SEARCH hangs, the issue
        // is specifically the MCP connector reaching the IP Fabric server.
        const data = await runLlmProbe();
        respond({ ok: true, data });
      } else {
        respond({ ok: false, error: "Unknown message type" });
      }
    } catch (err) {
      // Log everything we can about the error so the user can see what
      // happened in the service-worker console. err.stack preserves the
      // origin file/line of the throw (not just where we caught it);
      // err.message is what we surface to the UI.
      console.error("[ipf-gs:bg] handler threw for msg.type=" + (msg && msg.type),
                    "\n  name:", err && err.name,
                    "\n  message:", err && err.message,
                    "\n  stack:", err && err.stack,
                    "\n  raw:", err);
      respond({ ok: false, error: err && err.message ? err.message : String(err) });
    }
  })();
  return true; // async response
});

/* ---------------------------------------------------------------------- */
/* LLM + MCP search                                                       */
/*                                                                        */
/* Agentic-loop architecture: we drive Claude via the standard Messages   */
/* API with `tools` enumerated from the IP Fabric MCP server. When Claude */
/* emits tool_use blocks, we execute them ourselves against the IPF MCP   */
/* server (reusing callMcpTool above) and send the results back as the    */
/* next user turn. This gives full visibility — every tool call is        */
/* logged and we can inspect/limit results.                               */
/*                                                                        */
/* This replaces the earlier mcp_servers (native connector) approach,     */
/* which hung indefinitely waiting for tool results from the IPF MCP      */
/* server. See git history if you need the diagnostic context.            */
/* ---------------------------------------------------------------------- */

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_MODEL = "claude-sonnet-4-5";

// Notify the active tab's content script of a progress update so the
// iframe UI can reflect what's happening. Best-effort; failures are
// silent because the user may have navigated away.
async function notifyLlmProgress(payload) {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.id != null) {
      await chrome.tabs.sendMessage(tab.id, { type: "LLM_PROGRESS", ...payload });
    }
  } catch (_) { /* swallow */ }
}

// Minimal probe of the Anthropic API: same model, same auth, NO MCP.
// Used by the Options "Test LLM connection" button to isolate whether
// the LLM call itself works (key valid, network reachable, model exists)
// from MCP-connector issues.
async function runLlmProbe() {
  const t0 = Date.now();
  const log = (...a) => console.log("[ipf-gs:probe]", `+${((Date.now() - t0) / 1000).toFixed(2)}s`, ...a);

  const cfg = await chrome.storage.sync.get({
    anthropicApiKey: "",
    llmProvider: "claude",
    llmModel: "",
    llmBaseUrl: "",
    openaiApiKey: "",
  });

  // OpenAI-compatible providers: probe the configured /chat/completions
  // endpoint with a tiny request.
  if (cfg.llmProvider === "openai-compatible") {
    if (!cfg.llmBaseUrl) throw new Error("No LLM base URL configured.");
    const baseUrl = cfg.llmBaseUrl.replace(/\/+$/, "");
    const model = cfg.llmModel || DEFAULT_OPENAI_MODEL;
    const url = `${baseUrl}/chat/completions`;
    await ensureOpenAiHostPermission(baseUrl);
    log("POSTing probe to", url);
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 20_000);
    const headers = { "Content-Type": "application/json" };
    if (cfg.openaiApiKey) headers["Authorization"] = `Bearer ${cfg.openaiApiKey}`;
    let res;
    try {
      res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model,
          max_tokens: 20,
          messages: [{ role: "user", content: "Say 'pong' and nothing else." }],
        }),
        signal: abort.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      if (err.name === "AbortError") {
        throw new Error(`Probe timed out after 20s — cannot reach ${url}.`);
      }
      throw new Error(`Probe network error: ${err.message}`);
    }
    clearTimeout(timer);
    const text = await res.text();
    log("status=", res.status);
    if (!res.ok) {
      let parsed; try { parsed = JSON.parse(text); } catch {}
      const m = parsed?.error?.message || text;
      throw new Error(`LLM API ${res.status}: ${m}`);
    }
    let json; try { json = JSON.parse(text); } catch { json = {}; }
    const reply = json?.choices?.[0]?.message?.content || "";
    return {
      ok: true,
      elapsedMs: Date.now() - t0,
      model: json?.model || model,
      reply: String(reply).trim() || "(no text reply)",
      usage: json?.usage || null,
    };
  }

  // Default: Anthropic Claude probe (unchanged behavior).
  if (!cfg.anthropicApiKey) throw new Error("No Anthropic API key configured.");

  log("POSTing probe (no MCP)…");
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 20_000);

  let res;
  try {
    res = await fetch(ANTHROPIC_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": cfg.anthropicApiKey,
        "anthropic-version": "2023-06-01",
        // Required for requests originating from a browser context (the
        // MV3 service-worker fetch to api.anthropic.com is treated as a
        // CORS/browser request). Without it Anthropic returns
        // "401 CORS requests must set 'anthropic-dangerous-direct-browser-access'".
        // If your org has CORS disabled you'll instead get
        // "401 CORS requests are not allowed for this Organization" —
        // that's an Anthropic Console setting (enable "Allow CORS requests").
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify({
        model: cfg.llmModel || ANTHROPIC_MODEL,
        max_tokens: 20,
        messages: [{ role: "user", content: "Say 'pong' and nothing else." }],
      }),
      signal: abort.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if (err.name === "AbortError") {
      throw new Error("Probe timed out after 20s — cannot reach api.anthropic.com from this browser.");
    }
    throw new Error(`Probe network error: ${err.message}`);
  }
  clearTimeout(timer);

  const text = await res.text();
  log("status=", res.status);
  if (!res.ok) {
    let parsed;
    try { parsed = JSON.parse(text); } catch {}
    const m = parsed?.error?.message || text;
    if (/CORS requests are not allowed/i.test(m)) {
      throw new Error(
        `Anthropic API ${res.status}: ${m}\n\n` +
        "This is an Anthropic organization setting, not an extension bug. " +
        "In the Anthropic Console go to Settings → enable 'Allow CORS requests' " +
        "(or use an API key from an org that permits them)."
      );
    }
    throw new Error(`Anthropic API ${res.status}: ${m}`);
  }
  const json = JSON.parse(text);
  const reply = (json?.content || []).filter(b => b.type === "text").map(b => b.text).join("");
  return {
    ok: true,
    elapsedMs: Date.now() - t0,
    model: json?.model || ANTHROPIC_MODEL,
    reply: reply.trim() || "(no text reply)",
    usage: json?.usage || null,
  };
}

/* ----------------------------------------------------------------------
 * runLlmMcpSearch — agentic-loop architecture (v1.7)
 *
 * Replaces the previous mcp_servers-based native-connector approach
 * after diagnostics confirmed Anthropic's MCP connector hangs on
 * tool execution against demo2.eu.ipfabric.io/mcp.
 *
 * Architecture:
 *   1. We discover IPF MCP tools ourselves (reusing ensureSession +
 *      mcpFetch), convert their schemas to Anthropic tool-definition
 *      shape, and pass them as a regular `tools` array on the
 *      Messages API call (NOT via mcp_servers).
 *   2. We stream Claude's response. When Claude emits tool_use blocks,
 *      we wait for the turn to complete, then execute each tool_use
 *      against the IPF MCP server ourselves via callMcpTool().
 *   3. We append the tool_use + tool_result blocks to the running
 *      conversation and call Claude again.
 *   4. We loop until Claude returns stop_reason="end_turn" with no
 *      pending tool calls, or until we hit MAX_TURNS as a safety cap.
 *   5. We parse the final assistant message for the structured JSON
 *      answer and return it.
 *
 * Visibility: every Claude turn and every MCP tool call is logged to
 * the service worker console with [ipf-gs:llm] timestamps. Tool
 * errors are surfaced back to Claude (is_error:true) so it can recover.
 * -------------------------------------------------------------------- */

const MAX_TURNS = 10;          // safety cap on the agentic loop
const TURN_TIMEOUT_MS = 60_000;// per-Claude-turn timeout
// The CVE evaluation enumerates the device + OS-version inventory and
// reasons over it, so a single turn (especially the first, with a cold
// MCP session) can legitimately run longer than a normal search turn.
// Give it more headroom so a slow first turn doesn't abort mid-stream.
const CVE_TURN_TIMEOUT_MS = 120_000;
// The CVE evaluation must return a single fenced JSON block as its answer,
// and that block can be large: a real deployment can have many distinct
// device / OS-version groups, each with its own CVE detail, PLUS a
// per-CVE "Configuration Specific" (configs) section. At the default
// 4096-token cap the model could run out of output budget partway through
// the JSON, so the block was emitted truncated (no closing brace / fence).
// A truncated block fails JSON parsing, which makes the results fall back
// to plain prose — losing the bucketed view and, with it, the
// "Configuration Specific" section. Giving the final answer more room lets
// the complete JSON come back so the structured renderer (and its
// Configuration Specific section) is used. Tool-call turns rarely need
// this much, but a uniform higher cap is simplest and harmless.
const CVE_MAX_TOKENS = 8192;

// Convert an MCP tool descriptor (from tools/list) to Anthropic's
// tool definition shape. The schemas are similar but Anthropic uses
// `input_schema` (snake_case) while MCP uses `inputSchema`.
function mcpToolToAnthropic(mcpTool) {
  const name = (mcpTool.name || "").slice(0, 64);
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name)) return null;
  const inputSchema = mcpTool.inputSchema || { type: "object", properties: {} };
  return {
    name,
    description: mcpTool.description || `IP Fabric MCP tool: ${name}`,
    input_schema: inputSchema,
  };
}

// Convert an MCP tool result (from tools/call) to the text Anthropic
// expects inside a tool_result block. MCP results have shape:
//   { content: [{ type: "text", text: "..." }, ...], isError?: bool }
// We flatten to a single string. If the result is structured JSON,
// we pretty-print it.
function mcpResultToText(result) {
  if (!result) return "(no result)";
  if (typeof result === "string") return result;
  if (Array.isArray(result.content)) {
    return result.content
      .map((c) => {
        if (!c) return "";
        if (typeof c === "string") return c;
        if (c.type === "text" && typeof c.text === "string") return c.text;
        return JSON.stringify(c);
      })
      .filter(Boolean)
      .join("\n");
  }
  try { return JSON.stringify(result, null, 2); } catch { return String(result); }
}

// Streaming-aware Anthropic Messages call. Sends `body` (already
// including model/system/messages/tools), reads SSE, and returns:
//   { contentBlocks, stopReason, usage, requestId }
// where contentBlocks is the assembled array of content blocks
// (text + tool_use) for the assistant turn.
async function callAnthropicTurn(apiKey, body, log, logErr) {
  // Per-turn timeout. Callers may override via body.turnTimeoutMs for
  // heavier tasks (e.g. the CVE evaluation, whose first turn can be slow
  // when the MCP session is cold). Falls back to the shared default. The
  // override is stripped from the request payload below so it is never
  // sent to the API.
  const turnTimeoutMs = (typeof body.turnTimeoutMs === "number" && body.turnTimeoutMs > 0)
    ? body.turnTimeoutMs
    : TURN_TIMEOUT_MS;
  // Track whether an abort we observe was triggered by our own timeout,
  // so a mid-stream abort surfaces as a clear timeout message rather than
  // the cryptic "BodyStreamBuffer was aborted" DOMException.
  let timedOut = false;
  const abort = new AbortController();
  const timer = setTimeout(() => { timedOut = true; abort.abort("turn-timeout"); }, turnTimeoutMs);

  // Don't forward our internal control field to the Anthropic API.
  const { turnTimeoutMs: _omit, ...apiBody } = body;

  let res;
  try {
    res = await fetch(ANTHROPIC_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        // Required for the browser/CORS-mode request (see runLlmProbe).
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify({ ...apiBody, stream: true }),
      signal: abort.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if (err.name === "AbortError") {
      throw new Error(`Anthropic turn timed out after ${turnTimeoutMs / 1000}s.`);
    }
    throw new Error(`Could not reach Anthropic: ${err.message}`);
  }

  const requestId = res.headers.get("request-id") || res.headers.get("anthropic-request-id") || "";
  log("turn response: status=", res.status, " request-id=", requestId);

  if (!res.ok) {
    clearTimeout(timer);
    const text = await res.text().catch(() => "");
    let parsed; try { parsed = JSON.parse(text); } catch {}
    const m = (parsed && (parsed.error?.message || parsed.message)) || text || res.statusText;
    if (/CORS requests are not allowed/i.test(m)) {
      throw new Error(
        `Anthropic API ${res.status}: ${m}\n\n` +
        "This is an Anthropic organization setting, not an extension bug. " +
        "Enable 'Allow CORS requests' in the Anthropic Console for the org that " +
        "owns this API key (Settings), or use a key from an org that permits them. " +
        "The extension already strips the browser Origin to avoid CORS mode where " +
        "possible, but some org policies still block it."
      );
    }
    throw new Error(`Anthropic API ${res.status}: ${m}`);
  }

  // Parse the SSE stream. Each turn assembles its own content blocks
  // (text and tool_use). Tool input JSON is delivered as deltas; we
  // accumulate the JSON strings and parse at content_block_stop.
  const decoder = new TextDecoder();
  const reader = res.body.getReader();
  let buffer = "";
  const blocks = new Map(); // index -> in-progress block
  const finalContent = [];   // ordered list of completed content blocks
  let stopReason = "";
  let usage = null;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let sep;
      while ((sep = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        if (!frame.trim()) continue;

        let eventType = "";
        const dataLines = [];
        for (const line of frame.split(/\r?\n/)) {
          if (line.startsWith("event:")) eventType = line.slice(6).trim();
          else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
        }
        const dataStr = dataLines.join("\n");
        let data; try { data = dataStr ? JSON.parse(dataStr) : null; } catch { data = null; }

        if (eventType === "ping") continue;
        if (eventType === "error") {
          throw new Error(`Anthropic stream error: ${data?.error?.message || "unknown"}`);
        }
        if (eventType === "message_start") {
          usage = data?.message?.usage || null;
          continue;
        }
        if (eventType === "content_block_start") {
          const idx = data?.index;
          const block = data?.content_block;
          if (typeof idx === "number" && block) {
            blocks.set(idx, { ...block, _text: "", _inputStr: "" });
          }
          continue;
        }
        if (eventType === "content_block_delta") {
          const block = blocks.get(data?.index);
          const delta = data?.delta;
          if (!block || !delta) continue;
          if (delta.type === "text_delta") block._text += delta.text || "";
          else if (delta.type === "input_json_delta") block._inputStr += delta.partial_json || "";
          continue;
        }
        if (eventType === "content_block_stop") {
          const block = blocks.get(data?.index);
          if (!block) continue;
          if (block.type === "text") {
            finalContent.push({ type: "text", text: block._text });
          } else if (block.type === "tool_use") {
            let input = {};
            try { input = block._inputStr ? JSON.parse(block._inputStr) : {}; } catch {}
            finalContent.push({
              type: "tool_use",
              id: block.id,
              name: block.name,
              input,
            });
          }
          blocks.delete(data?.index);
          continue;
        }
        if (eventType === "message_delta") {
          if (data?.delta?.stop_reason) stopReason = data.delta.stop_reason;
          if (data?.usage) usage = { ...(usage || {}), ...data.usage };
          continue;
        }
      }
    }
  } catch (err) {
    // If our timeout fired mid-stream, the in-flight reader.read() rejects
    // with "AbortError: BodyStreamBuffer was aborted". Translate that into
    // the same clear timeout message the pre-stream path uses, rather than
    // letting the cryptic DOMException bubble up to the user.
    if (timedOut || (err && err.name === "AbortError")) {
      throw new Error(
        `Anthropic turn timed out after ${turnTimeoutMs / 1000}s while ` +
        `streaming the response. This can happen on a slow first turn ` +
        `(e.g. a cold MCP session); please try again.`
      );
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }

  return { content: finalContent, stopReason, usage, requestId };
}

/* ----------------------------------------------------------------------
 * Multi-provider LLM support
 * ----------------------------------------------------------------------
 *
 * The agentic loop (runLlmMcpSearch / runInteractivePrompt) is written
 * against the Anthropic Messages "content block" shape — assistant turns
 * are arrays of { type:"text" } / { type:"tool_use" } blocks, and tool
 * results are { type:"tool_result", tool_use_id, content } blocks on a
 * user turn. To support OpenAI-compatible endpoints (OpenAI, Azure,
 * Together, Groq, Ollama, LM Studio, vLLM, LocalAI, …) WITHOUT changing
 * that loop, the OpenAI provider below translates:
 *   - Anthropic tool defs           → OpenAI `tools` (function) schema
 *   - the Anthropic-shaped messages  → OpenAI chat messages (incl.
 *     assistant tool_calls + role:"tool" results)
 *   - the OpenAI response            → the same { content, stopReason,
 *     usage, requestId } shape callAnthropicTurn returns.
 * So callLlmTurn() is a drop-in replacement for callAnthropicTurn() and
 * the loops stay identical regardless of provider.
 */

const DEFAULT_CLAUDE_MODEL = ANTHROPIC_MODEL;
const DEFAULT_OPENAI_MODEL = "gpt-4o-mini";
const DEFAULT_OPENAI_BASE_URL = "http://localhost:1234/v1";

// Convert an Anthropic tool definition ({name, description, input_schema})
// to the OpenAI "function" tool shape.
function anthropicToolToOpenAI(tool) {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description || "",
      parameters: tool.input_schema || { type: "object", properties: {} },
    },
  };
}

// Convert the Anthropic-shaped `messages` array (+ system string) into
// OpenAI chat-completions messages. Handles the three message shapes the
// loop produces: a plain-string user turn, an assistant turn whose
// content is an array of text/tool_use blocks, and a user turn whose
// content is an array of tool_result blocks.
function anthropicMessagesToOpenAI(system, messages) {
  const out = [];
  if (system) out.push({ role: "system", content: system });
  for (const msg of messages) {
    if (typeof msg.content === "string") {
      out.push({ role: msg.role, content: msg.content });
      continue;
    }
    if (!Array.isArray(msg.content)) continue;

    if (msg.role === "assistant") {
      const text = msg.content
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("\n\n");
      const toolCalls = msg.content
        .filter((b) => b.type === "tool_use")
        .map((b) => ({
          id: b.id,
          type: "function",
          function: { name: b.name, arguments: JSON.stringify(b.input || {}) },
        }));
      const m = { role: "assistant", content: text || null };
      if (toolCalls.length) m.tool_calls = toolCalls;
      out.push(m);
    } else {
      // user turn: either plain content or an array of tool_result blocks.
      const toolResults = msg.content.filter((b) => b.type === "tool_result");
      if (toolResults.length) {
        for (const tr of toolResults) {
          const text = Array.isArray(tr.content)
            ? tr.content.map((c) => (c && c.type === "text" ? c.text : "")).join("\n")
            : String(tr.content || "");
          out.push({ role: "tool", tool_call_id: tr.tool_use_id, content: text });
        }
      } else {
        const text = msg.content
          .map((b) => (b && b.type === "text" ? b.text : ""))
          .join("\n");
        out.push({ role: "user", content: text });
      }
    }
  }
  return out;
}

// Map an OpenAI finish_reason to the Anthropic stop_reason vocabulary the
// loop checks against (it only really distinguishes tool calls vs done).
function openAiFinishToStop(finish) {
  if (finish === "tool_calls") return "tool_use";
  if (finish === "length") return "max_tokens";
  return "end_turn";
}

// Ensure we have host permission to fetch the OpenAI-compatible endpoint.
// The endpoint host isn't in the static host_permissions (we can't know it
// ahead of time), so it's covered by optional_host_permissions and granted
// on demand. The grant is requested from the Options page (a user gesture);
// here we just check, and surface a clear error if it's missing.
async function ensureOpenAiHostPermission(baseUrl) {
  let origin;
  try {
    const u = new URL(baseUrl);
    origin = `${u.protocol}//${u.host}/*`;
  } catch {
    throw new Error(`Invalid LLM base URL: ${baseUrl}`);
  }
  try {
    const has = await chrome.permissions.contains({ origins: [origin] });
    if (has) return true;
  } catch (_) { /* fall through */ }
  // Try to request (works if called within a user gesture; otherwise the
  // Options page should have already granted it on Save).
  try {
    const granted = await chrome.permissions.request({ origins: [origin] });
    if (granted) return true;
  } catch (_) { /* not in a user gesture */ }
  throw new Error(
    `This extension doesn't yet have permission to reach ${origin}. ` +
    `Open Options, confirm the LLM base URL, and click Save (and accept the ` +
    `permission prompt) — or Test LLM connection — to grant access.`
  );
}


// returns { content, stopReason, usage, requestId } where `content` is an
// Anthropic-style block array (text + tool_use) so the loop is unchanged.
// Uses non-streaming for simplicity/compatibility across the many
// OpenAI-compatible servers (some local ones stream tool calls poorly).
async function callOpenAITurn(cfg, body, log, logErr) {
  const baseUrl = (cfg.llmBaseUrl || DEFAULT_OPENAI_BASE_URL).replace(/\/+$/, "");
  const model = cfg.llmModel || DEFAULT_OPENAI_MODEL;
  const url = `${baseUrl}/chat/completions`;

  await ensureOpenAiHostPermission(baseUrl);

  const messages = anthropicMessagesToOpenAI(body.system, body.messages);
  const tools = Array.isArray(body.tools) ? body.tools.map(anthropicToolToOpenAI) : undefined;

  const payload = {
    model,
    max_tokens: body.max_tokens || 4096,
    messages,
    ...(tools && tools.length ? { tools } : {}),
  };

  const headers = { "Content-Type": "application/json" };
  if (cfg.openaiApiKey) headers["Authorization"] = `Bearer ${cfg.openaiApiKey}`;

  // Per-turn timeout, overridable by the caller (e.g. the CVE evaluation)
  // via body.turnTimeoutMs; falls back to the shared default. Not part of
  // the request payload (payload is built from explicit fields above).
  const turnTimeoutMs = (typeof body.turnTimeoutMs === "number" && body.turnTimeoutMs > 0)
    ? body.turnTimeoutMs
    : TURN_TIMEOUT_MS;
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort("turn-timeout"), turnTimeoutMs);
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: abort.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if (err.name === "AbortError") {
      throw new Error(`LLM turn timed out after ${turnTimeoutMs / 1000}s (${url}).`);
    }
    throw new Error(`Could not reach LLM endpoint ${url}: ${err.message}`);
  }
  clearTimeout(timer);

  const requestId = res.headers.get("x-request-id") || "";
  log("turn response: status=", res.status, " endpoint=", url);

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    let parsed; try { parsed = JSON.parse(text); } catch {}
    const m = (parsed && (parsed.error?.message || parsed.message)) || text || res.statusText;
    throw new Error(`LLM API ${res.status}: ${m}`);
  }

  let json;
  try { json = await res.json(); } catch (err) {
    throw new Error(`LLM endpoint returned non-JSON response: ${err.message}`);
  }

  const choice = json?.choices?.[0] || {};
  const message = choice.message || {};
  const finish = choice.finish_reason || "stop";

  // Assemble the Anthropic-style content block array.
  const content = [];
  if (message.content) {
    content.push({ type: "text", text: String(message.content) });
  }
  if (Array.isArray(message.tool_calls)) {
    for (const tc of message.tool_calls) {
      if (!tc || tc.type !== "function" || !tc.function) continue;
      let input = {};
      try { input = tc.function.arguments ? JSON.parse(tc.function.arguments) : {}; }
      catch { input = {}; }
      content.push({
        type: "tool_use",
        id: tc.id || `call_${Math.random().toString(36).slice(2)}`,
        name: tc.function.name,
        input,
      });
    }
  }

  const hasToolUse = content.some((b) => b.type === "tool_use");
  const stopReason = hasToolUse ? "tool_use" : openAiFinishToStop(finish);

  return { content, stopReason, usage: json?.usage || null, requestId };
}

// Provider dispatcher: pick the turn implementation from config. Returns
// the SAME normalized shape regardless of provider so callers are
// provider-agnostic. `cfg` carries provider, model, baseUrl, and keys.
async function callLlmTurn(cfg, body, log, logErr) {
  if (cfg.llmProvider === "openai-compatible") {
    return callOpenAITurn(cfg, body, log, logErr);
  }
  // Default / "claude": the existing Anthropic path (unchanged).
  const model = cfg.llmModel || DEFAULT_CLAUDE_MODEL;
  return callAnthropicTurn(cfg.anthropicApiKey, { ...body, model }, log, logErr);
}

/* ----------------------------------------------------------------------
 * IP Fabric UI deep-link hints  (the `ipf-ui-link` contract)
 * ----------------------------------------------------------------------
 * Shared by the LLM Interactive Session and the CVE Security Status
 * system prompts (NOT by Global Search, whose renderer already produces
 * its own links from the scanned table paths and must not change).
 *
 * The model is asked to attach an optional "link" object to each bucketed
 * item. overlay.js turns that into a clickable URL of the canonical shape
 *
 *   {origin}{webPath}?options={urlencoded JSON}&selectSnapshot={snapshot}
 *
 * The extension owns the encoding, the mandatory `and` filter wrapper and
 * the snapshot pinning, so the model only has to supply the web path and
 * the column/operator/value it wants filtered. If the model omits "link"
 * (or gives one the extension can't validate), overlay.js falls back to
 * inferring the target from the bucket, and failing that renders the item
 * as plain text — a missing link is always preferred to a wrong one.
 * -------------------------------------------------------------------- */
const UI_LINK_PROMPT_FRAGMENT = `IP FABRIC UI DEEP-LINKS — each item in the "networks", "devices", "sites" and "configs" buckets MAY carry an optional "link" object so the extension can render its name as a clickable link straight into the IP Fabric web UI:

  "link": {
    "webPath": "<the IP Fabric UI route for the table, e.g. /inventory/devices>",
    "filters": { "<column>": ["<operator>", "<value>"] }
  }

Rules for "link":
  - "webPath" is the UI (web) route, NOT the API path — e.g. the API endpoint /tables/inventory/devices is the UI route /inventory/devices, and /tables/security/aaa/lines is /technology/management/aaa/lines. If you know only the API path, you may put it in "webPath" anyway (the extension maps it where it confidently can) — but the UI route is preferred.
  - "filters" narrows that table down to the one item. Use the real API column name for the table (e.g. "hostname", "sn", "siteName", "net", "vlanName") and a valid operator: eq, neq, like, notlike, ieq, nieq, reg, nreg, ireg, nireg, cidr, lt, gt, lte, gte, empty. Prefer "eq" with the exact value you got back from the tools.
  - Do NOT URL-encode anything, do NOT add an "and"/"or" wrapper, and do NOT include a snapshot — the extension adds the encoding, the wrapper and the snapshot pinning itself.
  - Only emit "link" when the webPath, the column name and the value all come from data the tools actually returned. NEVER guess or invent a route, a column name or a value. If you are unsure, OMIT "link" entirely — the item still renders, just without a hyperlink, and that is strictly better than a link that lands on an empty or broken view.
  - Item names in the "snapshots" bucket need no "link": if "name" is a snapshot UUID the extension links it to snapshot management automatically.`;

const LLM_SYSTEM_PROMPT = `You are investigating where a search term appears in an IP Fabric network deployment.

You have DIRECT, ALREADY-AUTHENTICATED access to this IP Fabric deployment through the MCP tools provided to you (e.g. ipf_api_endpoint_search, ipf_api_endpoint_invoke, etc.). These tools are live and fully configured — the connection and API credentials are handled for you by the extension. You do NOT need any API token, credentials, or setup from the user, and you must NEVER ask the user to configure authentication, provide a token, or check connectivity. If you need data, just CALL THE TOOLS — they work. If a tool call returns an error, report the specific error text and retry with adjusted arguments; do NOT respond by telling the user to set up authentication.

The search term could be ANY kind of value, not just a device or network. Before concluding nothing matches, consider that the term might be:
  - a VLAN name (e.g. "s4xanadu") or VLAN ID — check the VLAN tables: /technology/vlans/network-summary, /technology/vlans/site-summary, /technology/vlans/device-detail (API table "vlan/device"), /technology/vlans/l3-gateways
  - a hostname or device serial number
  - an interface name or interface description
  - a VRF name, a route/prefix (e.g. "10.2.10.128/25" — check the IPv4/IPv6 routing tables), or a managed network
  - a MAC address, an IP address, a site name, an SNMP community, an NTP/DNS/AAA server, a config snippet, or a snapshot

A typical investigation flow:
  1. Call ipf_api_endpoint_search with the SEARCH TERM ITSELF (not a description of what you want to find) to locate relevant API endpoints. Example: if the term is "s3xlbr01", pass {"query": "s3xlbr01"}.
  2. ALSO consider which table(s) the term would naturally live in given the possibilities above (e.g. a VLAN-name-looking string → the VLAN tables; a CIDR → the routing/networks tables), and invoke those endpoints directly even if endpoint-search did not surface them.
  3. Invoke candidate endpoints via ipf_api_endpoint_invoke (or similar) to actually fetch matching data. When invoking a table, request its full/default columns so name-type columns (e.g. a VLAN's vlanName) are included — do not restrict to only id/hostname.
  4. Synthesize the findings into the structured answer below.

Investigate thoroughly — 4 to 8 tool calls is typical, and it is fine to check a few likely tables directly. When you have enough, return a single JSON object inside a fenced \`\`\`json ... \`\`\` block with EXACTLY this shape:

{
  "summary": "one-sentence plain-English summary",
  "networks":  [{ "name": "...", "detail": "..." }],
  "devices":   [{ "name": "...", "detail": "..." }],
  "sites":     [{ "name": "...", "detail": "..." }],
  "configs":   [{ "name": "...", "detail": "..." }],
  "snapshots": [{ "name": "...", "detail": "..." }],
  "other":     [{ "name": "...", "detail": "..." }]
}

Each bucket is an array — use an empty array if nothing was found in that category. Put matches that don't fit networks/devices/sites/configs/snapshots — such as VLANs, interfaces, VRFs, routes, MACs — into "other", with "name" set to the matched value and "detail" naming the table/column it was found in. "name" is the identifier the user would recognize (hostname, network CIDR, site label, snapshot UUID, config-file name, VLAN name, etc.). "detail" is a short reason it matched.

Rules:
  - Do NOT invent matches. Only report what tools actually returned.
  - The JSON block IS the entire user-visible answer; do not narrate around it.
  - If after several tool calls you find no matches at all, return the JSON with the summary explaining the search was performed but nothing matched.`;

async function runLlmMcpSearch(query) {
  const t0 = Date.now();
  const log = (...a) => console.log("[ipf-gs:llm]", `+${((Date.now() - t0) / 1000).toFixed(2)}s`, ...a);
  const logErr = (...a) => console.error("[ipf-gs:llm]", `+${((Date.now() - t0) / 1000).toFixed(2)}s`, ...a);

  log("runLlmMcpSearch (agentic-loop) start; query=", JSON.stringify(query));

  const cfg = await chrome.storage.sync.get({
    mcpUrl: "https://demo2.eu.ipfabric.io/mcp",
    authHeader: "",
    anthropicApiKey: "",
    llmProvider: "claude",
    llmModel: "",
    llmBaseUrl: "",
    openaiApiKey: "",
  });
  if (cfg.llmProvider === "openai-compatible") {
    if (!cfg.llmBaseUrl) {
      throw new Error("No LLM base URL configured. Open Options and set the OpenAI-compatible base URL (e.g. http://localhost:1234/v1).");
    }
  } else if (!cfg.anthropicApiKey) {
    throw new Error("No Anthropic API key configured. Open Options and paste your key.");
  }
  if (!cfg.mcpUrl || !cfg.authHeader) {
    throw new Error("MCP endpoint URL or Authorization header is empty in Options.");
  }

  await notifyLlmProgress({ event: "request_sent" });

  // Phase 1: enumerate MCP tools so we can pass schemas to Claude.
  log("discovering IPF MCP tools…");
  let mcpTools;
  try {
    mcpTools = await listTools();
  } catch (err) {
    throw new Error(`Could not list IPF MCP tools: ${err.message}`);
  }
  log("got", mcpTools.length, "tools from IPF MCP");
  await notifyLlmProgress({ event: "streaming_started" });

  // Convert to Anthropic tool definitions, dropping any with invalid
  // names (Anthropic constrains name to ^[a-zA-Z0-9_-]{1,64}$).
  const anthropicTools = mcpTools.map(mcpToolToAnthropic).filter(Boolean);
  if (!anthropicTools.length) {
    throw new Error("No usable IPF MCP tools (all failed name validation).");
  }
  log("exposing", anthropicTools.length, "tools to Claude:",
      anthropicTools.map((t) => t.name).join(", "));

  // Phase 2: agentic loop.
  const messages = [
    {
      role: "user",
      content:
        `Find every place the term \`${query}\` appears in this IP Fabric ` +
        `deployment. The term could be a device, network, site, config, or ` +
        `snapshot — but also possibly a VLAN name/ID, interface, VRF, route, ` +
        `MAC, or similar, so check the relevant tables for those too. ` +
        `Return the structured JSON described in your instructions.`,
    },
  ];

  const allToolCalls = []; // record for the UI
  let lastUsage = null;
  let lastStopReason = "";
  let lastTextAnswer = "";

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    log(`--- turn ${turn + 1}/${MAX_TURNS} ---`);
    const result = await callLlmTurn(
      cfg,
      {
        max_tokens: 4096,
        system: LLM_SYSTEM_PROMPT,
        messages,
        tools: anthropicTools,
      },
      log,
      logErr
    );
    lastUsage = result.usage;
    lastStopReason = result.stopReason;
    log(`turn ${turn + 1} done: stop_reason=${result.stopReason}, blocks=${result.content.length}`);

    // Append the assistant message to the conversation.
    messages.push({ role: "assistant", content: result.content });

    // Collect any text and any tool_use blocks.
    const toolUses = result.content.filter((b) => b.type === "tool_use");
    const textBlocks = result.content.filter((b) => b.type === "text");
    if (textBlocks.length) {
      lastTextAnswer = textBlocks.map((b) => b.text).join("\n\n");
    }

    // No tool calls: Claude is done. Break and parse the final answer.
    if (!toolUses.length) {
      log("no tool calls in this turn — finalizing");
      break;
    }

    // Execute each tool call against the IPF MCP server.
    log(`executing ${toolUses.length} MCP tool call(s)`);
    const toolResults = [];
    for (const tu of toolUses) {
      const callIndex = allToolCalls.length + 1;
      allToolCalls.push({ name: tu.name, input: tu.input });
      log(`  → tool ${callIndex}: ${tu.name}(${JSON.stringify(tu.input)})`);
      notifyLlmProgress({
        event: "tool_use_start",
        toolName: tu.name,
        toolIndex: callIndex,
      }).catch(() => {});
      let resultText, isError = false;
      try {
        const mcpResult = await callMcpTool(tu.name, tu.input);
        resultText = mcpResultToText(mcpResult);
        if (mcpResult && mcpResult.isError) isError = true;
        log(`  ← tool ${callIndex} ok (${resultText.length} chars)`);
      } catch (err) {
        isError = true;
        resultText = `Tool call failed: ${err.message || String(err)}`;
        logErr(`  ← tool ${callIndex} FAILED: ${resultText}`);
      }
      // Cap the result text — very large MCP responses can blow up
      // subsequent context windows.
      if (resultText.length > 20_000) {
        resultText = resultText.slice(0, 20_000) +
          `\n\n... (truncated; ${resultText.length} total chars)`;
      }
      toolResults.push({
        type: "tool_result",
        tool_use_id: tu.id,
        content: [{ type: "text", text: resultText }],
        ...(isError ? { is_error: true } : {}),
      });
    }

    // Append the tool results as a single user turn, then loop.
    messages.push({ role: "user", content: toolResults });
  }

  log("loop done; total tool calls:", allToolCalls.length,
      " text answer chars:", lastTextAnswer.length);
  await notifyLlmProgress({ event: "complete", toolCalls: allToolCalls.length });

  const parsed = extractJsonAnswer(lastTextAnswer);
  log("final JSON parse:", parsed ? "OK" : "FAILED");

  return {
    query,
    parsed,
    rawText: lastTextAnswer,
    toolCalls: allToolCalls,
    stopReason: lastStopReason,
    usage: lastUsage,
  };
}

/* ----------------------------------------------------------------------
 * runInteractivePrompt — free-form interactive session (v2.0)
 *
 * Same agentic-loop architecture as runLlmMcpSearch, but instead of a
 * fixed "find this term" task we pass the user's prompt through verbatim.
 * Claude has the IP Fabric MCP tools available and decides how to use
 * them to answer. The system prompt asks Claude to OPTIONALLY emit a
 * fenced ```json block in the networks/devices/sites/configs/snapshots
 * shape when the answer naturally groups into those buckets, so the rich
 * bucketed renderer in overlay.js can display it. When the answer is
 * better expressed as prose, Claude just returns text and the overlay
 * falls back to rendering that text.
 * -------------------------------------------------------------------- */
const INTERACTIVE_SYSTEM_PROMPT = `You are an interactive assistant embedded in the IP Fabric network-assurance platform. The user types a free-form prompt and you answer it.

You have DIRECT, ALREADY-AUTHENTICATED access to this IP Fabric deployment through the MCP tools provided to you (e.g. ipf_api_endpoint_search, ipf_api_endpoint_invoke, etc.). These tools are live and fully configured — the connection and API credentials are handled for you by the extension. You do NOT need any API token, credentials, or setup from the user, and you must NEVER ask the user to configure authentication, provide a token, or check connectivity. If you need live data, just CALL THE TOOLS — they work.

Whenever the user's prompt requires data from this IP Fabric deployment, you MUST use the tools rather than answering from general knowledge or describing what you "would" do. A typical flow:
  1. Call ipf_api_endpoint_search to locate the relevant API endpoint(s) for what the user is asking about.
  2. Invoke the chosen endpoint(s) via ipf_api_endpoint_invoke (or similar) to fetch the actual data.
  3. Synthesize the findings into a clear answer.

If a tool call returns an error, report the specific error text the tool returned and, if reasonable, retry with adjusted arguments — do NOT respond by telling the user to set up authentication or credentials (that is already done).

Work concisely — only make the tool calls you actually need (3 to 6 is typical). Do NOT invent data; only report what tools actually returned.

OUTPUT FORMAT — choose ONE of the following based on what best fits the user's request:

A) If the answer naturally groups into discoverable IP Fabric entities, end your reply with a single fenced \`\`\`json ... \`\`\` block with EXACTLY this shape:

\`\`\`json
{
  "summary": "one-sentence plain-English summary of the answer",
  "networks":  [{ "name": "...", "detail": "...", "link": { "webPath": "...", "filters": { "...": ["eq", "..."] } } }],
  "devices":   [{ "name": "...", "detail": "...", "link": { "webPath": "...", "filters": { "...": ["eq", "..."] } } }],
  "sites":     [{ "name": "...", "detail": "...", "link": { "webPath": "...", "filters": { "...": ["eq", "..."] } } }],
  "configs":   [{ "name": "...", "detail": "...", "link": { "webPath": "...", "filters": { "...": ["eq", "..."] } } }],
  "snapshots": [{ "name": "...", "detail": "..." }]
}
\`\`\`

Each bucket is an array — use an empty array if nothing belongs in that category. "name" is the identifier the user would recognize (hostname, network CIDR, site label, snapshot UUID, config-file name). "detail" is a short, relevant note. When you use this format, the JSON block is the entire user-visible answer; do not narrate around it.

${UI_LINK_PROMPT_FRAGMENT}

B) If the answer is explanatory, conversational, or doesn't map cleanly onto those buckets, just reply in clear prose. Do not force the JSON structure.

Pick whichever format genuinely serves the user's prompt best.`;

async function runInteractivePrompt(prompt) {
  const t0 = Date.now();
  const log = (...a) => console.log("[ipf-llm:interactive]", `+${((Date.now() - t0) / 1000).toFixed(2)}s`, ...a);
  const logErr = (...a) => console.error("[ipf-llm:interactive]", `+${((Date.now() - t0) / 1000).toFixed(2)}s`, ...a);

  prompt = (prompt || "").trim();
  log("runInteractivePrompt start; prompt=", JSON.stringify(prompt));
  if (!prompt) throw new Error("Empty prompt.");

  const cfg = await chrome.storage.sync.get({
    mcpUrl: "https://demo2.eu.ipfabric.io/mcp",
    authHeader: "",
    anthropicApiKey: "",
    llmProvider: "claude",
    llmModel: "",
    llmBaseUrl: "",
    openaiApiKey: "",
  });
  if (cfg.llmProvider === "openai-compatible") {
    if (!cfg.llmBaseUrl) {
      throw new Error("No LLM base URL configured. Open Options and set the OpenAI-compatible base URL (e.g. http://localhost:1234/v1).");
    }
  } else if (!cfg.anthropicApiKey) {
    throw new Error("No Anthropic API key configured. Open Options and paste your key.");
  }
  if (!cfg.mcpUrl || !cfg.authHeader) {
    throw new Error("MCP endpoint URL or Authorization header is empty in Options.");
  }

  await notifyLlmProgress({ event: "request_sent" });

  // Phase 1: enumerate MCP tools so we can pass schemas to Claude.
  log("discovering IPF MCP tools…");
  let mcpTools;
  try {
    mcpTools = await listTools();
  } catch (err) {
    throw new Error(`Could not list IPF MCP tools: ${err.message}`);
  }
  log("got", mcpTools.length, "tools from IPF MCP");
  await notifyLlmProgress({ event: "streaming_started" });

  const anthropicTools = mcpTools.map(mcpToolToAnthropic).filter(Boolean);
  if (!anthropicTools.length) {
    throw new Error("No usable IPF MCP tools (all failed name validation).");
  }
  log("exposing", anthropicTools.length, "tools to Claude:",
      anthropicTools.map((t) => t.name).join(", "));

  // Phase 2: agentic loop — the user's prompt goes through verbatim.
  const messages = [{ role: "user", content: prompt }];

  const allToolCalls = [];
  let lastUsage = null;
  let lastStopReason = "";
  let lastTextAnswer = "";

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    log(`--- turn ${turn + 1}/${MAX_TURNS} ---`);
    const result = await callLlmTurn(
      cfg,
      {
        max_tokens: 4096,
        system: INTERACTIVE_SYSTEM_PROMPT,
        messages,
        tools: anthropicTools,
      },
      log,
      logErr
    );
    lastUsage = result.usage;
    lastStopReason = result.stopReason;
    log(`turn ${turn + 1} done: stop_reason=${result.stopReason}, blocks=${result.content.length}`);

    messages.push({ role: "assistant", content: result.content });

    const toolUses = result.content.filter((b) => b.type === "tool_use");
    const textBlocks = result.content.filter((b) => b.type === "text");
    if (textBlocks.length) {
      lastTextAnswer = textBlocks.map((b) => b.text).join("\n\n");
    }

    if (!toolUses.length) {
      log("no tool calls in this turn — finalizing");
      break;
    }

    log(`executing ${toolUses.length} MCP tool call(s)`);
    const toolResults = [];
    for (const tu of toolUses) {
      const callIndex = allToolCalls.length + 1;
      allToolCalls.push({ name: tu.name, input: tu.input });
      log(`  → tool ${callIndex}: ${tu.name}(${JSON.stringify(tu.input)})`);
      notifyLlmProgress({
        event: "tool_use_start",
        toolName: tu.name,
        toolIndex: callIndex,
      }).catch(() => {});
      let resultText, isError = false;
      try {
        const mcpResult = await callMcpTool(tu.name, tu.input);
        resultText = mcpResultToText(mcpResult);
        if (mcpResult && mcpResult.isError) isError = true;
        log(`  ← tool ${callIndex} ok (${resultText.length} chars)`);
      } catch (err) {
        isError = true;
        resultText = `Tool call failed: ${err.message || String(err)}`;
        logErr(`  ← tool ${callIndex} FAILED: ${resultText}`);
      }
      if (resultText.length > 20_000) {
        resultText = resultText.slice(0, 20_000) +
          `\n\n... (truncated; ${resultText.length} total chars)`;
      }
      toolResults.push({
        type: "tool_result",
        tool_use_id: tu.id,
        content: [{ type: "text", text: resultText }],
        ...(isError ? { is_error: true } : {}),
      });
    }

    messages.push({ role: "user", content: toolResults });
  }

  log("loop done; total tool calls:", allToolCalls.length,
      " text answer chars:", lastTextAnswer.length);
  await notifyLlmProgress({ event: "complete", toolCalls: allToolCalls.length });

  // Try to extract a structured JSON answer; null if Claude replied in prose.
  const parsed = extractJsonAnswer(lastTextAnswer);
  log("final JSON parse:", parsed ? "OK" : "none (prose answer)");

  return {
    prompt,
    parsed,
    rawText: lastTextAnswer,
    toolCalls: allToolCalls,
    stopReason: lastStopReason,
    usage: lastUsage,
  };
}


/* ----------------------------------------------------------------------
 * runCveEvaluation — CVE Security Status "Evaluate" button (v3.13)
 *
 * Same agentic-loop architecture as runInteractivePrompt / runLlmMcpSearch,
 * but the task is fixed: identify whether any current network devices in
 * this IP Fabric deployment are affected or impacted by published CVE
 * vulnerabilities. The model uses the IP Fabric MCP tools to enumerate the
 * deployment's devices and OS versions, then cross-references those
 * device/OS-version pairs against its knowledge of public, well-known
 * network CVE and vulnerability tracking sources (NVD, CISA KEV, and the
 * relevant vendor security advisories). The result is returned in the same
 * bucketed JSON shape the overlay's renderer already understands, so the
 * CVE results display identically to the Global Search and LLM Interactive
 * Session results.
 * -------------------------------------------------------------------- */
const CVE_SYSTEM_PROMPT = `You are a network security assessor embedded in the IP Fabric network-assurance platform. Your task is to determine whether any current network devices in THIS IP Fabric deployment are affected or impacted by published CVE vulnerabilities.

You have DIRECT, ALREADY-AUTHENTICATED access to this IP Fabric deployment through the MCP tools provided to you (e.g. ipf_api_endpoint_search, ipf_api_endpoint_invoke, etc.). These tools are live and fully configured — the connection and API credentials are handled for you by the extension. You do NOT need any API token, credentials, or setup from the user, and you must NEVER ask the user to configure authentication, provide a token, or check connectivity. If you need live data, just CALL THE TOOLS — they work. If a tool call returns an error, report the specific error text the tool returned and retry with adjusted arguments; do NOT respond by telling the user to set up authentication.

INVESTIGATION FLOW:
  1. Enumerate the deployment's network devices and their OS/software versions. The most useful sources are the device inventory and OS-version inventory tables — e.g. call ipf_api_endpoint_search to locate the relevant endpoints (try queries like "devices", "os versions", "inventory"), then invoke them via ipf_api_endpoint_invoke. Request the columns that identify each device and its software: hostname, vendor, family, platform, model, and version (and siteName where available). The inventory OS-version summary tables are an efficient way to get the distinct vendor + family + version combinations in use.
  2. For each distinct (vendor, OS family, OS version) combination actually present in the deployment, CROSS-REFERENCE it against published, well-known public network CVE and vulnerability tracking sources — specifically the NIST National Vulnerability Database (NVD), the CISA Known Exploited Vulnerabilities (KEV) catalog, and the relevant vendor security advisories (e.g. Cisco Security Advisories / PSIRT, Juniper SIRT, Arista, Palo Alto Networks Security Advisories, Fortinet PSIRT). Use your knowledge of these sources to identify CVEs that affect those specific software versions.
  3. Map each relevant CVE back to the specific affected device(s) and OS version(s) discovered in step 1.
  4. Please cross-reference device models and device OS versions with public CVE databases and identify if any devices are impacted by configuration specific identified CVE's and provide the details of these in a Configuration Specific section of your CVE output. A configuration-specific CVE is one whose exploitability depends on a particular feature or configuration being enabled on the device (for example a specific protocol, service, or feature). Where the deployment's data lets you tell whether the triggering configuration is present, note that in the detail; where it does not, say the exposure is conditional on that configuration. Put each such finding in the "configs" bucket of the output (this is rendered as the "Configuration Specific" section).

Work methodically — make the tool calls you actually need to enumerate devices and OS versions (typically 3 to 8). Do NOT invent device data; only report devices and versions the tools actually returned. When you reference a CVE, use its real published identifier (e.g. CVE-2023-20198) and be honest about uncertainty — if you are not confident a given version is affected, say so in the detail rather than asserting it.

OUTPUT FORMAT — end your reply with a single fenced \`\`\`json ... \`\`\` block with EXACTLY this shape:

\`\`\`json
{
  "summary": "one-sentence plain-English summary of the CVE exposure found (or that none was found)",
  "networks":  [],
  "devices":   [{ "name": "<hostname or device identifier>", "detail": "<vendor/OS version> — affected by <CVE id(s)>: <short impact note>", "link": { "webPath": "/inventory/devices", "filters": { "hostname": ["eq", "<the exact hostname>"] } } }],
  "sites":     [],
  "configs":   [{ "name": "<CVE id — affected device/version>", "detail": "<the configuration-specific CVE: which feature/config makes it exploitable, which device(s)/version(s) it impacts, whether the triggering configuration was observed, and the public source (NVD/CISA KEV/vendor advisory)>", "link": { "webPath": "/inventory/devices", "filters": { "hostname": ["eq", "<the exact hostname of the impacted device>"] } } }],
  "snapshots": [],
  "other":     [{ "name": "<CVE id or affected version>", "detail": "<which devices/versions it impacts and the public source, e.g. NVD/CISA KEV/vendor advisory>", "link": { "webPath": "/inventory/devices", "filters": { "version": ["eq", "<the exact OS version>"] } } }]
}
\`\`\`

${UI_LINK_PROMPT_FRAGMENT}

For this CVE assessment specifically, the "link" on each finding should point at the IP Fabric UI rows the finding is about, so the user can click straight from a CVE to the affected kit:
  - "devices": link to the device inventory filtered to that device — webPath "/inventory/devices" with filters { "hostname": ["eq", "<hostname>"] } (use { "sn": ["eq", "<serial>"] } instead if you have the serial and not a clean hostname).
  - "configs" (the Configuration Specific section): link to the device(s) whose configuration makes the CVE exploitable — same "/inventory/devices" shape, filtered to that device's hostname. If a finding spans several devices, link to the first/most representative one.
  - "other" (the per-CVE / per-version breakdown): link to the devices running the affected OS version — "/inventory/devices" with filters { "version": ["eq", "<the exact version string the tools returned>"] }. Only do this when you have the exact version string from the tool output; otherwise omit "link".
Every hostname, serial and version you put in a "link" MUST be one the tools actually returned — never a guessed or reconstructed value.

Each bucket is an array — use an empty array if nothing belongs in that category. Put each impacted device in "devices" (with the CVE id(s) and impact in its detail). Put each CONFIGURATION-SPECIFIC CVE (per step 4 — a CVE whose exploitability depends on a specific feature or configuration being enabled) in "configs"; this bucket is rendered to the user as the "Configuration Specific" section. Use "other" to summarize each distinct CVE / affected version and the public tracking source it comes from. If, after enumerating the devices and OS versions, you find NO devices impacted by any known published CVEs, return the JSON with empty "devices"/"configs"/"other" arrays and a summary stating that no current devices were found to be affected by published CVE vulnerabilities. The JSON block IS the entire user-visible answer; do not narrate around it. Keep any reasoning BEFORE the JSON block brief — do not restate the whole analysis in prose — and keep each "detail" string concise (roughly one or two sentences). Always emit the COMPLETE JSON block, closing every brace and the final fence, so the structured answer (including the Configuration Specific section) is never cut off.`;

async function runCveEvaluation() {
  const t0 = Date.now();
  const log = (...a) => console.log("[ipf-llm:cve]", `+${((Date.now() - t0) / 1000).toFixed(2)}s`, ...a);
  const logErr = (...a) => console.error("[ipf-llm:cve]", `+${((Date.now() - t0) / 1000).toFixed(2)}s`, ...a);

  log("runCveEvaluation start");

  const cfg = await chrome.storage.sync.get({
    mcpUrl: "https://demo2.eu.ipfabric.io/mcp",
    authHeader: "",
    anthropicApiKey: "",
    llmProvider: "claude",
    llmModel: "",
    llmBaseUrl: "",
    openaiApiKey: "",
  });
  if (cfg.llmProvider === "openai-compatible") {
    if (!cfg.llmBaseUrl) {
      throw new Error("No LLM base URL configured. Open Options and set the OpenAI-compatible base URL (e.g. http://localhost:1234/v1).");
    }
  } else if (!cfg.anthropicApiKey) {
    throw new Error("No Anthropic API key configured. Open Options and paste your key.");
  }
  if (!cfg.mcpUrl || !cfg.authHeader) {
    throw new Error("MCP endpoint URL or Authorization header is empty in Options.");
  }

  await notifyLlmProgress({ event: "request_sent" });

  // Phase 1: enumerate MCP tools so we can pass schemas to the model.
  log("discovering IPF MCP tools…");
  let mcpTools;
  try {
    mcpTools = await listTools();
  } catch (err) {
    throw new Error(`Could not list IPF MCP tools: ${err.message}`);
  }
  log("got", mcpTools.length, "tools from IPF MCP");
  await notifyLlmProgress({ event: "streaming_started" });

  const anthropicTools = mcpTools.map(mcpToolToAnthropic).filter(Boolean);
  if (!anthropicTools.length) {
    throw new Error("No usable IPF MCP tools (all failed name validation).");
  }
  log("exposing", anthropicTools.length, "tools to the model:",
      anthropicTools.map((t) => t.name).join(", "));

  // Phase 2: agentic loop with a fixed CVE-evaluation task.
  const messages = [
    {
      role: "user",
      content:
        "Evaluate the CVE security status of this IP Fabric deployment. " +
        "Enumerate the current network devices and their OS/software versions " +
        "using the IP Fabric MCP tools, then cross-reference those devices and " +
        "OS versions against published, well-known public network CVE and " +
        "vulnerability tracking sources (NVD, CISA KEV, and the relevant vendor " +
        "security advisories) to identify any devices affected or impacted by " +
        "known CVE vulnerabilities. Return the structured JSON described in your " +
        "instructions.",
    },
  ];

  const allToolCalls = [];
  let lastUsage = null;
  let lastStopReason = "";
  let lastTextAnswer = "";

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    log(`--- turn ${turn + 1}/${MAX_TURNS} ---`);
    const result = await callLlmTurn(
      cfg,
      {
        max_tokens: CVE_MAX_TOKENS,
        system: CVE_SYSTEM_PROMPT,
        messages,
        tools: anthropicTools,
        // The CVE evaluation is the heaviest task (it reasons over the
        // device + OS-version inventory across several tool calls) and its
        // first turn can be slow when the MCP session is cold. Allow more
        // time per turn so a slow first turn doesn't abort mid-stream.
        turnTimeoutMs: CVE_TURN_TIMEOUT_MS,
      },
      log,
      logErr
    );
    lastUsage = result.usage;
    lastStopReason = result.stopReason;
    log(`turn ${turn + 1} done: stop_reason=${result.stopReason}, blocks=${result.content.length}`);

    messages.push({ role: "assistant", content: result.content });

    const toolUses = result.content.filter((b) => b.type === "tool_use");
    const textBlocks = result.content.filter((b) => b.type === "text");
    if (textBlocks.length) {
      lastTextAnswer = textBlocks.map((b) => b.text).join("\n\n");
    }

    if (!toolUses.length) {
      log("no tool calls in this turn — finalizing");
      break;
    }

    log(`executing ${toolUses.length} MCP tool call(s)`);
    const toolResults = [];
    for (const tu of toolUses) {
      const callIndex = allToolCalls.length + 1;
      allToolCalls.push({ name: tu.name, input: tu.input });
      log(`  → tool ${callIndex}: ${tu.name}(${JSON.stringify(tu.input)})`);
      notifyLlmProgress({
        event: "tool_use_start",
        toolName: tu.name,
        toolIndex: callIndex,
      }).catch(() => {});
      let resultText, isError = false;
      try {
        const mcpResult = await callMcpTool(tu.name, tu.input);
        resultText = mcpResultToText(mcpResult);
        if (mcpResult && mcpResult.isError) isError = true;
        log(`  ← tool ${callIndex} ok (${resultText.length} chars)`);
      } catch (err) {
        isError = true;
        resultText = `Tool call failed: ${err.message || String(err)}`;
        logErr(`  ← tool ${callIndex} FAILED: ${resultText}`);
      }
      if (resultText.length > 20_000) {
        resultText = resultText.slice(0, 20_000) +
          `\n\n... (truncated; ${resultText.length} total chars)`;
      }
      toolResults.push({
        type: "tool_result",
        tool_use_id: tu.id,
        content: [{ type: "text", text: resultText }],
        ...(isError ? { is_error: true } : {}),
      });
    }

    messages.push({ role: "user", content: toolResults });
  }

  log("loop done; total tool calls:", allToolCalls.length,
      " text answer chars:", lastTextAnswer.length);
  await notifyLlmProgress({ event: "complete", toolCalls: allToolCalls.length });

  const parsed = extractJsonAnswer(lastTextAnswer);
  log("final JSON parse:", parsed ? "OK" : "none (prose answer)");

  return {
    parsed,
    rawText: lastTextAnswer,
    toolCalls: allToolCalls,
    stopReason: lastStopReason,
    usage: lastUsage,
  };
}


// Look for the first ```json ... ``` block in Claude's output and try to
// parse it. Falls back to scanning for the first balanced {...} object
// if no fenced block exists. Returns null if neither works.
function extractJsonAnswer(text) {
  if (!text) return null;
  // Fenced ```json ... ``` (preferred, since the system prompt requests it).
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    try { return JSON.parse(fenced[1].trim()); } catch { /* fall through */ }
  }
  // Unfenced (or unterminated fence): find the first { and walk to the
  // matching }. This also handles a fenced block whose closing ``` never
  // arrived because the response was truncated at the token limit.
  const start = text.indexOf("{");
  if (start === -1) return null;
  const stack = [];         // open brackets, in order: "{" or "["
  let inStr = false, esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === "{" || c === "[") stack.push(c);
    else if (c === "}" || c === "]") {
      stack.pop();
      if (stack.length === 0) {
        const candidate = text.slice(start, i + 1);
        try { return JSON.parse(candidate); } catch { return null; }
      }
    }
  }
  // We reached end-of-text with brackets still open — i.e. the JSON was
  // truncated (e.g. the model hit its output-token limit mid-answer).
  // Best-effort recovery so a large-but-cut-off CVE answer still renders
  // as the structured bucketed view (with its Configuration Specific
  // section) instead of silently falling back to raw prose.
  return recoverTruncatedJson(text.slice(start), stack, inStr);
}

// Attempt to repair a truncated JSON fragment whose opening "{" is intact
// but which was cut off before all brackets closed. `openStack` is the
// list of still-open "{"/"[" characters (in order); `inStr` indicates the
// cut happened inside a string. Strategy: close a dangling string, trim any
// incomplete trailing element/key, then close the open brackets in reverse
// order. Returns the parsed object or null if it still can't be salvaged.
function recoverTruncatedJson(frag, openStack, inStr) {
  if (!openStack || openStack.length === 0) return null;
  let s = frag;
  if (inStr) s += '"';                       // close a dangling string value
  // Trim trailing whitespace.
  s = s.replace(/\s+$/, "");
  // If the fragment ends partway through a new element or key, drop back to
  // the last structurally safe boundary: the last '}' , ']' , or a complete
  // "key": "value" pair ending in '"'. We iteratively strip a trailing
  // incomplete tail and re-try parsing after closing brackets.
  const closers = { "{": "}", "[": "]" };
  function closeAll(str, stack) {
    let out = str.replace(/,\s*$/, "");      // no trailing comma
    for (let i = stack.length - 1; i >= 0; i--) out += closers[stack[i]];
    return out;
  }
  // First attempt: close as-is.
  try { return JSON.parse(closeAll(s, openStack)); } catch { /* keep trimming */ }
  // Iteratively remove the trailing (incomplete) fragment. We cut at the
  // last comma or opening bracket and retry, popping a bracket from the
  // stack when we cut past it, up to a bounded number of attempts.
  let stack = openStack.slice();
  for (let attempt = 0; attempt < 200 && s.length > 1; attempt++) {
    // Find a safe cut point: the last comma, "{" or "[" not inside a string.
    let cut = -1, depthStr = false, e = false;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (depthStr) { if (e) e = false; else if (c === "\\") e = true; else if (c === '"') depthStr = false; continue; }
      if (c === '"') depthStr = true;
      else if (c === "," || c === "{" || c === "[") cut = i;
    }
    if (cut === -1) break;
    const cutChar = s[cut];
    s = s.slice(0, cut);                     // drop the incomplete tail
    // Recompute the open-bracket stack for the trimmed string.
    stack = [];
    let sstr = false, se = false;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (sstr) { if (se) se=false; else if (c==="\\") se=true; else if (c==='"') sstr=false; continue; }
      if (c === '"') sstr = true;
      else if (c === "{" || c === "[") stack.push(c);
      else if (c === "}" || c === "]") stack.pop();
    }
    if (stack.length === 0) break;
    try { return JSON.parse(closeAll(s, stack)); } catch { /* keep trimming */ }
    void cutChar;
  }
  return null;
}

/* ---------------------------------------------------------------------- */
/* UI activation: toolbar icon + keyboard shortcut focus the search input. */
/* ---------------------------------------------------------------------- */

async function focusSearchInput(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: "FOCUS_INPUT" });
  } catch (_) {
    chrome.runtime.openOptionsPage();
  }
}

chrome.action.onClicked.addListener(async (tab) => {
  if (tab && tab.id) await focusSearchInput(tab.id);
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "focus-search") return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab && tab.id) await focusSearchInput(tab.id);
});

/* ---------------------------------------------------------------------- */
/* Diff Dashboard integration                                             */
/*                                                                        */
/* The Diff Dashboard panel is owned by diff-content.js. Its keyboard      */
/* command (Ctrl+Shift+D) is relayed to that content script as a          */
/* TOGGLE_PANEL message. Kept as its own command listener so the existing  */
/* focus-search command and the toolbar-icon behavior are untouched: the   */
/* toolbar icon still focuses Global Search, and the Diff Dashboard is      */
/* toggled via its header-row button or Ctrl+Shift+D.                      */
/* ---------------------------------------------------------------------- */

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "toggle-diff-dashboard") return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab && tab.id) {
    try { await chrome.tabs.sendMessage(tab.id, { type: "IPFSD_TOGGLE_PANEL" }); }
    catch (_) { /* Diff content script not present on this tab */ }
  }
});
