// options.js
const DEFAULTS = {
  mcpUrl: "https://demo2.eu.ipfabric.io/mcp",
  // No secrets are bundled with the extension. Each user pastes their own
  // IP Fabric MCP Authorization header and (for LLM mode) their own
  // Anthropic API key in Options; those are saved to chrome.storage.sync
  // in their own browser profile, never to a file in the extension.
  authHeader: "",
  toolName: "",
  argName: "",
  anthropicApiKey: "",
  searchMode: "scan",   // "scan" (default — cycle every table) or "mcp" (LLM + MCP server)
  showGlobalSearch: true, // show the Global Search bar (left half)
  showLlmSession: true,   // show the LLM Interactive Session bar (right half)
  showCveStatus: true,    // show the CVE Security Status label + Evaluate button
  showDiffDashboard: true, // show the Diff Dashboard header-row button + panel
  // LLM provider selection (default Anthropic Claude; unchanged behavior).
  // `llmProvider` is what the background ENGINE understands and stores:
  // exactly "claude" or "openai-compatible". `llmPreset` is the UI-level
  // choice (claude / openai / azure / groq / ollama / lmstudio / localai /
  // vllm / openai-compatible) used only to restore the dropdown and to
  // pre-fill the base URL; the engine never depends on it.
  llmProvider: "claude",
  llmPreset: "claude",
  llmModel: "",
  llmBaseUrl: "",
  openaiApiKey: "",
};

// Named presets shown in the dropdown. Everything except "claude" maps to
// the single "openai-compatible" engine, differing only by a default base
// URL (mirroring the Demo Advisor's alias→baseURL approach). `keyHint`
// notes whether a hosted key is typically required (UI text only).
const LLM_PRESETS = {
  claude:              { engine: "claude",            baseUrl: "" },
  openai:              { engine: "openai-compatible", baseUrl: "https://api.openai.com/v1" },
  azure:               { engine: "openai-compatible", baseUrl: "" /* user-specific resource URL */ },
  groq:                { engine: "openai-compatible", baseUrl: "https://api.groq.com/openai/v1" },
  ollama:              { engine: "openai-compatible", baseUrl: "http://localhost:11434/v1" },
  lmstudio:            { engine: "openai-compatible", baseUrl: "http://localhost:1234/v1" },
  localai:             { engine: "openai-compatible", baseUrl: "http://localhost:8080/v1" },
  vllm:                { engine: "openai-compatible", baseUrl: "http://localhost:8000/v1" },
  "openai-compatible": { engine: "openai-compatible", baseUrl: "" },
};

// The set of base URLs that came from a preset. Used so switching presets
// can safely overwrite a URL that was itself preset-filled, without
// clobbering a URL the user typed by hand.
const PRESET_BASE_URLS = new Set(
  Object.values(LLM_PRESETS).map((p) => p.baseUrl).filter(Boolean)
);

// Resolve the UI preset value to the engine provider the background uses.
function presetToEngineProvider(preset) {
  const p = LLM_PRESETS[preset];
  return p ? p.engine : (preset === "claude" ? "claude" : "openai-compatible");
}

const els = {
  mcpUrl: document.getElementById("mcpUrl"),
  authHeader: document.getElementById("authHeader"),
  anthropicApiKey: document.getElementById("anthropicApiKey"),
  llmProvider: document.getElementById("llmProvider"),
  llmModel: document.getElementById("llmModel"),
  llmBaseUrl: document.getElementById("llmBaseUrl"),
  openaiApiKey: document.getElementById("openaiApiKey"),
  openaiFields: document.getElementById("openaiFields"),
  toolName: document.getElementById("toolName"),
  argName: document.getElementById("argName"),
  showGlobalSearch: document.getElementById("showGlobalSearch"),
  showLlmSession: document.getElementById("showLlmSession"),
  showCveStatus: document.getElementById("showCveStatus"),
  showDiffDashboard: document.getElementById("showDiffDashboard"),
  saveBtn: document.getElementById("saveBtn"),
  testBtn: document.getElementById("testBtn"),
  testLlmBtn: document.getElementById("testLlmBtn"),
  status: document.getElementById("status"),
  toolsList: document.getElementById("toolsList"),
};

function getSelectedMode() {
  const checked = document.querySelector('input[name="searchMode"]:checked');
  return checked ? checked.value : "mcp";
}

function setSelectedMode(mode) {
  const radio = document.querySelector(`input[name="searchMode"][value="${mode}"]`);
  if (radio) radio.checked = true;
}

function setStatus(text, kind) {
  els.status.textContent = text || "";
  els.status.className = "status" + (kind ? " " + kind : "");
}

// Show the OpenAI-compatible fields for any non-Claude preset, and
// pre-fill the base URL for the chosen preset. We only overwrite the base
// URL when it's empty or was itself filled from a preset — never a URL the
// user typed by hand. `userEdited` distinguishes a manual switch (where we
// pre-fill) from the initial load (where we keep the stored URL).
function syncProviderFields(userEdited) {
  const preset = els.llmProvider ? els.llmProvider.value : "claude";
  const engine = presetToEngineProvider(preset);
  const isOpenAi = engine === "openai-compatible";
  if (els.openaiFields) els.openaiFields.hidden = !isOpenAi;

  if (isOpenAi && userEdited && els.llmBaseUrl) {
    const current = els.llmBaseUrl.value.trim();
    const presetUrl = (LLM_PRESETS[preset] && LLM_PRESETS[preset].baseUrl) || "";
    // Pre-fill only if the field is empty or holds a (different) preset URL.
    if (presetUrl && (!current || PRESET_BASE_URLS.has(current))) {
      els.llmBaseUrl.value = presetUrl;
    }
  }
}

async function load() {
  const cfg = await chrome.storage.sync.get(DEFAULTS);
  els.mcpUrl.value = cfg.mcpUrl || "";
  els.authHeader.value = cfg.authHeader || "";
  els.anthropicApiKey.value = cfg.anthropicApiKey || "";
  els.toolName.value = cfg.toolName || "";
  els.argName.value = cfg.argName || "";
  setSelectedMode(cfg.searchMode || "scan");
  els.showGlobalSearch.checked = cfg.showGlobalSearch !== false;
  els.showLlmSession.checked = cfg.showLlmSession !== false;
  els.showCveStatus.checked = cfg.showCveStatus !== false;
  if (els.showDiffDashboard) els.showDiffDashboard.checked = cfg.showDiffDashboard !== false;
  // Restore the UI preset. `llmPreset` is the source of truth when present
  // and consistent with the engine provider. But configs saved before
  // presets existed have no real llmPreset (storage.get fills it with the
  // DEFAULTS value "claude"), so if the stored ENGINE provider is
  // openai-compatible we must not show "claude". Detect that mismatch and
  // fall back to the generic "openai-compatible" preset.
  let preset = cfg.llmPreset;
  const engineIsOpenAi = cfg.llmProvider === "openai-compatible";
  const presetEngine = LLM_PRESETS[preset] ? LLM_PRESETS[preset].engine : null;
  if (!preset || !LLM_PRESETS[preset] || presetEngine !== cfg.llmProvider) {
    // No usable preset, or it disagrees with the saved engine provider.
    preset = engineIsOpenAi ? "openai-compatible" : "claude";
  }
  if (els.llmProvider) els.llmProvider.value = preset;
  if (els.llmModel) els.llmModel.value = cfg.llmModel || "";
  if (els.llmBaseUrl) els.llmBaseUrl.value = cfg.llmBaseUrl || "";
  if (els.openaiApiKey) els.openaiApiKey.value = cfg.openaiApiKey || "";
  // Initial sync: show/hide fields, but DON'T overwrite the stored URL.
  syncProviderFields(false);
}

async function save() {
  const llmPreset = els.llmProvider ? els.llmProvider.value : "claude";
  const llmProvider = presetToEngineProvider(llmPreset);
  const llmBaseUrl = els.llmBaseUrl ? els.llmBaseUrl.value.trim() : "";

  // When using any OpenAI-compatible endpoint, request host permission for
  // it now (this runs inside the Save button's click — a user gesture —
  // so the permission prompt is allowed). The endpoint host isn't in the
  // static manifest host_permissions, so it's granted on demand via
  // optional_host_permissions. Claude (default) needs no extra grant.
  if (llmProvider === "openai-compatible" && llmBaseUrl) {
    try {
      const u = new URL(llmBaseUrl);
      const origin = `${u.protocol}//${u.host}/*`;
      const has = await chrome.permissions.contains({ origins: [origin] });
      if (!has) {
        const granted = await chrome.permissions.request({ origins: [origin] });
        if (!granted) {
          setStatus("Saved, but permission to reach the LLM host was denied — LLM modes won't work until granted.", "err");
        }
      }
    } catch (err) {
      setStatus(`Invalid LLM base URL: ${err.message}`, "err");
      return;
    }
  }

  await chrome.storage.sync.set({
    mcpUrl: els.mcpUrl.value.trim(),
    authHeader: els.authHeader.value.trim(),
    anthropicApiKey: els.anthropicApiKey.value.trim(),
    toolName: els.toolName.value.trim(),
    argName: els.argName.value.trim(),
    searchMode: getSelectedMode(),
    showGlobalSearch: !!els.showGlobalSearch.checked,
    showLlmSession: !!els.showLlmSession.checked,
    showCveStatus: !!els.showCveStatus.checked,
    showDiffDashboard: !!(els.showDiffDashboard && els.showDiffDashboard.checked),
    llmProvider,
    llmPreset,
    llmModel: els.llmModel ? els.llmModel.value.trim() : "",
    llmBaseUrl,
    openaiApiKey: els.openaiApiKey ? els.openaiApiKey.value.trim() : "",
  });
  // Force the background worker to re-initialize against the new config.
  await chrome.runtime.sendMessage({ type: "RESET_SESSION" }).catch(() => {});
  if (els.status.className.indexOf("err") === -1) {
    setStatus("Saved.", "ok");
    setTimeout(() => setStatus(""), 2200);
  }
}

function renderTools(tools, selected) {
  els.toolsList.innerHTML = "";
  for (const t of tools) {
    const pill = document.createElement("span");
    pill.className = "pill" + (t.name === selected ? " active" : "");
    pill.textContent = t.name;
    pill.title = t.description || t.name;
    pill.addEventListener("click", () => {
      els.toolName.value = t.name;
      [...els.toolsList.children].forEach((c) => c.classList.remove("active"));
      pill.classList.add("active");
    });
    els.toolsList.appendChild(pill);
  }
}

async function test() {
  // Prompt clearly if the required IP Fabric MCP fields are empty, rather
  // than firing a request that will just fail.
  const missing = [];
  if (!els.mcpUrl.value.trim()) missing.push("MCP endpoint URL");
  if (!els.authHeader.value.trim()) missing.push("Authorization header");
  if (missing.length) {
    setStatus(
      `Please fill in: ${missing.join(" and ")} before testing the connection.`,
      "err"
    );
    (missing.includes("Authorization header") ? els.authHeader : els.mcpUrl).focus();
    return;
  }
  setStatus("Connecting…");
  // Save current values first so the background worker uses them.
  await save();
  setStatus("Connecting…");
  try {
    const res = await chrome.runtime.sendMessage({ type: "LIST_TOOLS" });
    if (!res || !res.ok) throw new Error(res && res.error ? res.error : "Unknown error");
    const tools = res.data || [];
    renderTools(tools, els.toolName.value.trim());
    setStatus(`Connected. ${tools.length} tool${tools.length === 1 ? "" : "s"} available.`, "ok");
  } catch (err) {
    setStatus(err && err.message ? err.message : String(err), "err");
  }
}

async function testLlm() {
  const preset = els.llmProvider ? els.llmProvider.value : "claude";
  const isOpenAi = presetToEngineProvider(preset) === "openai-compatible";
  // Prompt clearly if the field the chosen provider needs is empty.
  if (isOpenAi) {
    if (els.llmBaseUrl && !els.llmBaseUrl.value.trim()) {
      setStatus("Please enter the OpenAI-compatible Base URL (e.g. http://localhost:1234/v1) before testing.", "err");
      els.llmBaseUrl.focus();
      return;
    }
  } else if (!els.anthropicApiKey.value.trim()) {
    setStatus("Please paste your Anthropic API key before testing the LLM.", "err");
    els.anthropicApiKey.focus();
    return;
  }
  const label = isOpenAi ? "Probing LLM endpoint (no MCP)…" : "Probing Anthropic API (no MCP)…";
  setStatus(label);
  await save();
  setStatus(label);
  try {
    const res = await chrome.runtime.sendMessage({ type: "LLM_PROBE" });
    if (!res || !res.ok) throw new Error(res && res.error ? res.error : "Unknown error");
    const { elapsedMs, model, reply, usage } = res.data;
    const summary =
      `LLM probe OK in ${(elapsedMs / 1000).toFixed(1)}s. ` +
      `Model: ${model}. Reply: "${reply.slice(0, 40)}". ` +
      (usage ? `Tokens: ${usage.input_tokens || usage.prompt_tokens || 0} in / ${usage.output_tokens || usage.completion_tokens || 0} out.` : "");
    setStatus(summary, "ok");
  } catch (err) {
    setStatus(err && err.message ? err.message : String(err), "err");
  }
}

els.saveBtn.addEventListener("click", save);
els.testBtn.addEventListener("click", test);
els.testLlmBtn.addEventListener("click", testLlm);
if (els.llmProvider) els.llmProvider.addEventListener("change", () => syncProviderFields(true));

load();

/* -------------------------------------------------------------------------- */
/* Diff Dashboard settings                                                     */
/*                                                                             */
/* These use the Diff Dashboard's own chrome.storage.sync keys (snapdiff_*)    */
/* and are applied live by diff-content.js. They are wired independently of    */
/* the Save button so the Global Search / LLM / CVE save flow is untouched.    */
/* (The "Show Diff Dashboard" checkbox is part of the Display section above and */
/* is saved with the Save button, exactly like the other show/hide toggles.)   */
/* -------------------------------------------------------------------------- */
(() => {
  const ignoreEl = document.getElementById("diffIgnoreVolatile");
  const resetEl = document.getElementById("diffResetPos");
  const statusEl = document.getElementById("diffStatus");

  if (ignoreEl) {
    chrome.storage.sync.get({ snapdiff_ignore_volatile: true }, (cfg) => {
      ignoreEl.checked = cfg.snapdiff_ignore_volatile !== false;
    });
    ignoreEl.addEventListener("change", () => {
      chrome.storage.sync.set({ snapdiff_ignore_volatile: !!ignoreEl.checked });
    });
  }

  if (resetEl) {
    resetEl.addEventListener("click", () => {
      chrome.storage.sync.remove(
        ["snapdiff_rect", "snapdiff_collapsed", "snapdiff_hidden"],
        () => {
          if (statusEl) {
            statusEl.textContent = "Reset — reopen the Diff Dashboard on an IP Fabric tab.";
            statusEl.className = "status ok";
            setTimeout(() => { statusEl.textContent = ""; statusEl.className = "status"; }, 2600);
          }
        }
      );
    });
  }
})();
