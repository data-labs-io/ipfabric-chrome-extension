// overlay.js - runs inside the iframe.
//
// New responsibilities (v1.1):
//   - Detect IP Fabric API-endpoint search results in MCP text content
//     and render them as a sortable-looking table with expandable rows
//     for description / operation ID / available fields.
//   - Detect IP Fabric data-array responses ({_meta, data:[{...}, ...]})
//     and render them as a generic table.
//   - Fall back to highlighted JSON / plain text otherwise.
//   - Talk to the background worker via chrome.runtime.sendMessage.
//   - Tell the parent how tall the iframe needs to be (RESIZE).
//   - Handle FOCUS messages from the parent (toolbar / shortcut).

(() => {
  const $  = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  const input          = $("#query");
  const clearInputBtn  = $("#clearInput");
  const results        = $("#results");
  const dropdown       = $("#dropdown");
  const resultsMeta    = $("#resultsMeta");
  const resultsMetaTxt = $("#resultsMetaText");
  const resultsTool    = $("#resultsTool");
  const searchBtn      = $("#searchBtn");

  function showDropdown() { dropdown.hidden = false; gsHasResults = true; refreshToggleButtons(); }
  function hideDropdown() { dropdown.hidden = true; }

  // Whether the GS dropdown currently holds rendered results. Lets the
  // toggle button know there's something to re-show after an outside
  // click hides (but does not wipe) the panel.
  let gsHasResults = false;

  // Hide the GS results panel WITHOUT wiping its content, so it can be
  // toggled back into view with the same results. Used on outside-click.
  function hideResults() {
    hideDropdown();
    sendResize();
    refreshToggleButtons();
  }

  // Re-show the persisted GS results (if any).
  function showResults() {
    if (!gsHasResults) return;
    showDropdown();
    sendResize();
    refreshToggleButtons();
  }

  function toggleResults() {
    if (!gsHasResults) return;
    if (dropdown.hidden) showResults(); else hideResults();
  }

  // Show/hide the clear-input X based on whether the input has text.
  function refreshClearBtn() {
    clearInputBtn.hidden = !input.value;
  }

  /* ====================================================================
   * Persist the search term across page navigations
   * ==================================================================
   *
   * When the user clicks a deep-link, the new tab loads a fresh copy
   * of overlay.html and the iframe state is reset. We persist the
   * last typed query in chrome.storage.local so the new tab's bar
   * pre-fills with it. The user clears it explicitly via the X
   * button next to the input.
   *
   * Best-effort: if chrome.storage is unavailable (extension context
   * invalidated, etc.) we silently skip — the input just stays empty.
   */
  const STORAGE_KEY = "ipfgs_last_query";

  function saveQuery(q) {
    try {
      chrome.storage.local.set({ [STORAGE_KEY]: q || "" }).catch(() => {});
    } catch { /* no storage */ }
  }
  function loadQuery() {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get({ [STORAGE_KEY]: "" }).then(
          (obj) => resolve(obj[STORAGE_KEY] || ""),
          () => resolve("")
        );
      } catch { resolve(""); }
    });
  }

  // Restore the saved query on iframe load. Done before anything else
  // visual so users opened-via-deep-link see their query already there.
  loadQuery().then((q) => {
    if (q && !input.value) {
      input.value = q;
      refreshClearBtn();
    }
  });

  /* ====================================================================
   * Persist the GS results across page navigations
   * ==================================================================
   *
   * When the user clicks a deep-link in the results, the host page
   * navigates and the iframe reloads fresh — wiping the in-memory
   * results. We snapshot the rendered results HTML + meta to
   * chrome.storage.local after each render, and restore them (hidden,
   * toggle-able) on the next load. This lets the user re-open the exact
   * same results on the page they were sent to.
   */
  const RESULTS_KEY = "ipfgs_last_results";

  function persistResults() {
    try {
      chrome.storage.local.set({
        [RESULTS_KEY]: {
          html: results.innerHTML,
          metaText: resultsMetaTxt.textContent || "",
          metaTool: resultsTool.textContent || "",
          metaHidden: !!resultsMeta.hidden,
        },
      }).catch(() => {});
    } catch { /* no storage */ }
  }
  function clearPersistedResults() {
    try { chrome.storage.local.remove(RESULTS_KEY).catch(() => {}); }
    catch { /* no storage */ }
  }
  // Restore persisted GS results on load — kept hidden; the toggle button
  // (which appears because gsHasResults becomes true) re-shows them.
  function restorePersistedResults() {
    try {
      chrome.storage.local.get({ [RESULTS_KEY]: null }).then((obj) => {
        const saved = obj && obj[RESULTS_KEY];
        if (!saved || !saved.html) return;
        results.innerHTML = saved.html;
        resultsMetaTxt.textContent = saved.metaText || "";
        resultsTool.textContent = saved.metaTool || "";
        resultsTool.style.display = saved.metaTool ? "" : "none";
        resultsMeta.hidden = saved.metaHidden !== false ? (saved.metaHidden === true) : false;
        if (saved.metaText || saved.metaTool) resultsMeta.hidden = false;
        gsHasResults = true;
        dropdown.hidden = true;        // start hidden; user toggles to view
        refreshToggleButtons();
      }, () => {});
    } catch { /* no storage */ }
  }
  restorePersistedResults();

  // Persist GS results whenever the rendered content settles on a final
  // (non-loading, non-empty) state. A debounced MutationObserver captures
  // every render path without hooking each one individually. We skip the
  // transient loading spinner and in-progress scan states.
  let _persistTimer = null;
  function schedulePersist() {
    clearTimeout(_persistTimer);
    _persistTimer = setTimeout(() => {
      const html = results.innerHTML;
      if (!html) return;                                   // empty → nothing to save
      // Skip transient states: the LLM-MCP search spinner and the live
      // table-scan progress bar. The final scan render replaces the
      // progress element with the matches list, which we DO persist.
      if (results.querySelector(".spinner, .scan-progress")) return;
      // A scan that is still running shows the live progress element; only
      // persist once it has finished (scanState cleared or final rendered).
      // scanState is declared later in this scope but is initialized
      // (to null) during init, before any mutation can fire this callback.
      if (scanState && scanState.done < scanState.total) return;
      persistResults();
    }, 250);
  }
  try {
    new MutationObserver(schedulePersist).observe(results, {
      childList: true, subtree: true, characterData: true,
    });
  } catch { /* MutationObserver unavailable */ }

  // Origin of the host page (e.g. "https://demo2.eu.ipfabric.io"). Sent
  // from content.js via postMessage right after the iframe loads. Used
  // to build deep-link URLs in result rows. Defaults to "" until we
  // hear from the parent — the matcher will simply not produce links
  // until then, which is fine because the first search comes only
  // after the user types something.
  let hostOrigin = "";

  /* ====================================================================
   * Resize the iframe to fit content
   * ================================================================== */

  const ro = new ResizeObserver(() => sendResize());
  ro.observe($(".panel"));
  function sendResize() {
    const panel = $(".panel");
    if (!panel) return;
    // Panel's offsetHeight + the 16px-from-top we positioned at = total
    // height the iframe should reserve. We send just the content height;
    // the parent adds its own margins.
    parent.postMessage({ type: "RESIZE", height: panel.offsetHeight + 4 }, "*");
  }
  requestAnimationFrame(sendResize);

  // Size the results panels to ~half the REAL screen height. We can't rely
  // on CSS `vh` inside the iframe because the iframe's own height is
  // content-driven (so `vh` would resolve against a too-short iframe). The
  // host sends its actual window.innerHeight via HOST_INFO; we translate
  // that into a pixel height on a CSS custom property the results use.
  function applyResultsHeight(viewportHeight) {
    const px = Math.max(160, Math.round(viewportHeight * 0.5));
    document.documentElement.style.setProperty("--results-h", px + "px");
    // The panel just grew/shrank; tell the parent so the iframe follows.
    sendResize();
  }

  /* ====================================================================
   * Messages from the parent (toolbar / shortcut)
   * ================================================================== */

  window.addEventListener("message", (e) => {
    const msg = e.data || {};
    if (msg.type === "FOCUS") {
      input.focus();
      input.select();
    } else if (msg.type === "PAGE_MOUSEDOWN") {
      // User clicked the host page below the iframe. Hide any open
      // dropdown but KEEP its content so it can be toggled back into
      // view, and keep the search input intact.
      if (!dropdown.hidden) hideResults();
    } else if (msg.type === "HOST_INFO" && typeof msg.origin === "string") {
      hostOrigin = msg.origin;
      if (typeof msg.viewportHeight === "number" && msg.viewportHeight > 0) {
        applyResultsHeight(msg.viewportHeight);
      }
      // Snapshot UUID the host page is currently on. Used to pin the
      // IP Fabric UI deep-links generated for the LLM Interactive
      // Session and CVE Security Status results (see buildIpfUiLink).
      // Optional: when absent we fall back to the "$last" shortcut.
      if (typeof msg.snapshotId === "string" && msg.snapshotId) {
        hostSnapshotId = msg.snapshotId;
      }
    } else if (msg.type === "HOST_SNAPSHOT" && typeof msg.snapshotId === "string") {
      // Sent later by content.js once /api/snapshots has been read.
      if (msg.snapshotId) hostSnapshotId = msg.snapshotId;
    } else if (msg.type === "LLM_PROGRESS") {
      if (activeLlmTarget === "llm") LLM.handleProgress(msg);
      else if (activeLlmTarget === "cve") { if (window.__cveHandleProgress) window.__cveHandleProgress(msg); }
      else handleLlmProgress(msg);
    }
  });

  // Which feature owns the in-flight Anthropic call: "gs" (Global Search
  // LLM+MCP mode) or "llm" (LLM Interactive Session). Progress messages
  // from the shared background worker are routed accordingly.
  let activeLlmTarget = "gs";

  // Track in-flight LLM call so we can show progressive feedback.
  let llmCallStart = 0;
  let llmToolCount = 0;
  let llmLastEvent = "";
  let llmTicker = null;

  function handleLlmProgress(msg) {
    llmLastEvent = msg.event || "";
    if (msg.event === "request_sent") {
      llmCallStart = Date.now();
      llmToolCount = 0;
      startLlmTicker();
      updateLlmLoadingMessage("Connecting to Anthropic…");
    } else if (msg.event === "streaming_started") {
      updateLlmLoadingMessage("Claude is investigating…");
    } else if (msg.event === "tool_use_start") {
      llmToolCount = msg.toolIndex || (llmToolCount + 1);
      const tool = msg.toolName || "(tool)";
      updateLlmLoadingMessage(
        `Tool call ${llmToolCount}: <code>${escapeHtmlSafe(tool)}</code>…`
      );
    } else if (msg.event === "complete") {
      stopLlmTicker();
    }
  }

  function startLlmTicker() {
    stopLlmTicker();
    llmTicker = setInterval(() => {
      // Force a re-render to keep the elapsed-seconds counter ticking.
      updateLlmLoadingMessage(null);
    }, 1000);
  }
  function stopLlmTicker() {
    if (llmTicker) { clearInterval(llmTicker); llmTicker = null; }
  }

  function escapeHtmlSafe(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  // Refresh the loading-row text. If `text` is null, just update the
  // elapsed-seconds counter without changing the primary message.
  function updateLlmLoadingMessage(text) {
    const status = results.querySelector("[data-llm-status]");
    if (!status) return;
    const elapsed = Math.floor((Date.now() - llmCallStart) / 1000);
    const tail = llmCallStart
      ? `<span class="llm-elapsed">${elapsed}s</span>`
      : "";
    if (text !== null) {
      status.querySelector("[data-llm-status-text]").innerHTML = text;
    }
    const elapsedEl = status.querySelector("[data-llm-elapsed]");
    if (elapsedEl) elapsedEl.innerHTML = tail;
  }

  /* ====================================================================
   * Keyboard
   * ================================================================== */

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); doSearch(); }
    if (e.key === "Escape") { e.preventDefault(); clearResults(); input.blur(); }
  });

  // Live-persist the query as the user types and keep the X visible
  // in sync. Debounced lightly so we don't hit storage on every key.
  let saveTimer = null;
  input.addEventListener("input", () => {
    refreshClearBtn();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => saveQuery(input.value), 150);
  });

  /* ====================================================================
   * Click delegation
   * ================================================================== */

  document.addEventListener("click", (e) => {
    const t = e.target.closest("[data-action]");
    if (!t) return;
    const action = t.getAttribute("data-action");
    switch (action) {
      case "search":  doSearch(); break;
      case "clear":   clearResults(); input.focus(); break;
      case "clear-input":
        // Wipe both the input and the persisted query. Also clear any
        // open results dropdown so the bar returns to its idle state.
        input.value = "";
        refreshClearBtn();
        saveQuery("");
        clearResults();
        input.focus();
        break;
      case "submit-llm":   LLM.doSubmit(); break;
      case "clear-llm":    LLM.clearResults(); LLM.focus(); break;
      case "clear-prompt": LLM.clearPrompt(); break;
      case "clear-cve":    CVE.clearResults(); break;
      case "toggle-results":     toggleResults(); break;
      case "toggle-llm-results": LLM.toggleResults(); break;
      case "view-report-gs":
        makeReport("view", { toolName: "Global Search", queryLabel: "Search term",
          queryValue: input.value || "", resultsHtml: results.innerHTML });
        break;
      case "save-report-gs":
        makeReport("save", { toolName: "Global Search", queryLabel: "Search term",
          queryValue: input.value || "", resultsHtml: results.innerHTML });
        break;
      case "view-report-llm":
        if (LLM.getReportData) { const d = LLM.getReportData(); makeReport("view", d); }
        break;
      case "save-report-llm":
        if (LLM.getReportData) { const d = LLM.getReportData(); makeReport("save", d); }
        break;
      case "view-report-cve":
        if (CVE.getReportData) { const d = CVE.getReportData(); makeReport("view", d); }
        break;
      case "save-report-cve":
        if (CVE.getReportData) { const d = CVE.getReportData(); makeReport("save", d); }
        break;
      case "options":
        e.preventDefault();
        chrome.runtime.sendMessage({ type: "OPEN_OPTIONS" }).catch(() => {});
        break;
    }
  });

  /* ====================================================================
   * Results-toggle buttons in the bar (show/hide persisted results)
   * ==================================================================
   *
   * The toggle button for each side is visible only when that side has
   * results to re-show. It re-displays the last-rendered results after
   * an outside click (which hides but does not wipe them). The explicit
   * clear button inside each dropdown wipes the content and hides the
   * toggle again.
   */
  const gsToggleBtn = document.getElementById("gsToggleBtn");
  function refreshToggleButtons() {
    if (gsToggleBtn) {
      gsToggleBtn.hidden = !gsHasResults;
      gsToggleBtn.classList.toggle("is-active", gsHasResults && !dropdown.hidden);
      gsToggleBtn.title = dropdown.hidden ? "Show results" : "Hide results";
    }
    if (window.__refreshLlmToggle) window.__refreshLlmToggle();
  }

  /* ====================================================================
   * Result clearing
   * ================================================================== */

  function clearResults() {
    results.innerHTML = "";
    resultsMeta.hidden = true;
    hideDropdown();
    gsHasResults = false;
    clearPersistedResults();
    sendResize();
    refreshToggleButtons();
  }

  /* ====================================================================
   * Helpers
   * ================================================================== */

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  /* ====================================================================
   * HTML report generation (View in new tab / Save as file)
   * ==================================================================
   *
   * Each tool can turn its currently-rendered results into a standalone,
   * self-contained HTML report styled to the IP Fabric brand guidelines
   * (navy #143352 dominant, magenta #c01f60 sparing accent, gray #8d999b,
   * Open Sans, official wordmark). The report embeds:
   *   • the IP Fabric wordmark + a titled header,
   *   • the original Global Search term / LLM prompt (or the CVE action),
   *   • the exact results markup that is shown in the dropdown.
   *
   * The report is fully inline (its own <style> + inline SVG logo) so it
   * renders identically whether opened in a new tab or saved to disk and
   * opened later. We hand the finished HTML to the content script (via
   * postMessage) which — running in the host-page context — opens it in a
   * new browser tab or triggers a download. This does not touch or alter
   * any existing rendering; it only reads the already-rendered markup.
   */

  // Official IP Fabric primary (color) wordmark, inlined as scalable SVG so
  // the report needs no external assets. Sourced from the ipf-design skill.
  const IPF_LOGO_SVG = '<svg role="img" aria-label="IP Fabric" version="1.1" id="Layer_1" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" x="0px" y="0px" viewBox="0 0 728.5 133.2" style="enable-background:new 0 0 728.5 133.2;" xml:space="preserve"> <style type="text/css"> .ipflg0{fill-rule:evenodd;clip-rule:evenodd;fill:#8C989B;} .ipflg1{fill-rule:evenodd;clip-rule:evenodd;fill:#264183;} .ipflg2{fill:#264183;} .ipflg3{fill:#8C989B;} </style> <g> <g> <path class="ipflg0" d="M99.9,88.6c0,6.6-6.1,11.8-13,10.2c-3.8-0.9-6.9-3.9-7.8-7.7c-1.6-6.9,3.6-13,10.2-13 C95.2,78,99.9,82.8,99.9,88.6L99.9,88.6z"/> <path class="ipflg1" d="M55.7,44.7c0,6.6-6.1,11.8-13,10.2c-3.8-0.9-6.9-3.9-7.8-7.7c-1.6-6.9,3.6-13,10.2-13 C51,34.2,55.7,38.9,55.7,44.7L55.7,44.7L55.7,44.7z"/> </g> <path class="ipflg2" d="M132.7,11.7v109.8c0,5.8-4.7,10.5-10.5,10.5H56.5l21.8-21.8c3.3,1.7,7.1,2.7,11.1,2.7c5.8,0,11.2-2.1,15.4-5.5 c1.2-1,2.4-2.2,3.4-3.4c4.2-5.1,6.4-11.8,5.3-19.1c-1.5-10.3-9.2-18.4-19.5-20.3c-5.8-1.1-11.3-0.1-16,2.3L66.8,55.7 c1.7-3.3,2.7-7,2.7-11s-1-8-2.8-11.4L98.8,1.2h23.3C128,1.2,132.7,5.9,132.7,11.7z"/> <path class="ipflg3" d="M65,88.6c0,4,1,7.7,2.7,11l-32.5,32.4H12.4c-0.8,0-1.6-0.1-2.5-0.3c-3.8-0.9-6.9-3.9-7.8-7.7 c-0.2-0.8-0.3-1.7-0.3-2.5V11.7c0-5.8,4.7-10.5,10.5-10.5h65.2L55.9,22.8c-3.2-1.6-6.9-2.5-10.7-2.5c-5.8,0-11.2,2-15.4,5.5l0,0 c-1.2,1-2.4,2.1-3.4,3.4c-0.7,0.8-0.7,0.8,0,0c-4.5,5.5-6.7,12.9-5,20.8c2,9.4,9.4,16.7,18.8,18.5c5.9,1.2,11.4,0.2,16.1-2.2 l11.4,11.4C66,81,65,84.7,65,88.6L65,88.6z"/> </g> <g> <path class="ipflg2" d="M214,112.9h-16.5c-0.9,0-1.6-0.7-1.6-1.6V21.9c0-0.9,0.7-1.6,1.6-1.6H214c0.9,0,1.6,0.7,1.6,1.6v89.4 C215.6,112.2,214.9,112.9,214,112.9z"/> <path class="ipflg2" d="M294.9,49.9c0,8.7-2.7,15.8-8.4,21c-5.5,5.2-12.9,7.8-22.4,7.8h-13.7c-0.9,0-1.6,0.7-1.6,1.6v31 c0,0.9-0.7,1.6-1.6,1.6h-16.5c-0.9,0-1.6-0.7-1.6-1.6V21.9c0-0.9,0.7-1.6,1.6-1.6h33.4c9.5,0,17,2.6,22.4,8 C292.1,33.5,294.9,40.8,294.9,49.9L294.9,49.9z M275.2,49.9c0-4-1-7-3.1-9c-2-2.1-5-3.1-8.7-3.1h-12.9c-0.9,0-1.6,0.7-1.6,1.6v20.2 c0,0.9,0.7,1.6,1.6,1.6h12.9c3.8,0,6.6-0.9,8.7-2.9S275.2,53.6,275.2,49.9L275.2,49.9z"/> <path class="ipflg2" d="M378.2,62.8v14.3c0,0.9-0.7,1.6-1.6,1.6h-22.3c-0.9,0-1.6,0.7-1.6,1.6v31c0,0.9-0.7,1.6-1.6,1.6h-16.5 c-0.9,0-1.6-0.7-1.6-1.6V21.9c0-0.9,0.7-1.6,1.6-1.6h56.6c0.9,0,1.6,0.7,1.6,1.6v14.3c0,0.9-0.7,1.6-1.6,1.6h-36.9 c-0.9,0-1.6,0.7-1.6,1.6v20.3c0,0.9,0.7,1.6,1.6,1.6h22.3C377.5,61.3,378.2,62,378.2,62.8L378.2,62.8z"/> <path class="ipflg2" d="M644.8,112.9h-16.5c-0.9,0-1.6-0.7-1.6-1.6V21.9c0-0.9,0.7-1.6,1.6-1.6h16.5c0.9,0,1.6,0.7,1.6,1.6v89.4 C646.4,112.2,645.7,112.9,644.8,112.9z"/> <path class="ipflg2" d="M600,76.2c-0.2-0.5-0.1-1.1,0.4-1.4c1.9-1.1,3.7-2.4,5.3-3.9c5.6-5.2,8.3-12.3,8.3-21c0-1.8-0.1-3.5-0.3-5.1 c-0.9-6.8-3.5-12.4-8-16.6c-5.5-5.4-12.9-8-22.4-8h-33.4c-0.9,0-1.6,0.7-1.6,1.6v89.4c0,0.9,0.7,1.6,1.6,1.6h16.5 c0.9,0,1.6-0.7,1.6-1.6v-31c0-0.9,0.7-1.6,1.6-1.6h8.8c0.8,0,1.6,0.5,2,1.3l15,32c0.3,0.6,0.8,0.9,1.4,0.9h19 c1.2,0,1.9-1.2,1.4-2.3L600,76.2L600,76.2z M591.2,58.3c-2.1,2-5,2.9-8.7,2.9h-12.9c-0.9,0-1.6-0.7-1.6-1.6V39.4 c0-0.9,0.7-1.6,1.6-1.6h12.9c3.8,0,6.8,1,8.7,3.1c1.6,1.5,2.5,3.5,2.9,6.2c0.3,1.8,0.3,1.8,0,0c0.1,0.9,0.2,1.8,0.2,2.8 C594.3,53.6,593.3,56.3,591.2,58.3L591.2,58.3z"/> <path class="ipflg2" d="M433.3,20.3h-17.4c-0.7,0-1.3,0.5-1.5,1.1l-28.2,89.4c-0.3,1,0.4,2.1,1.5,2.1h17c0.7,0,1.3-0.5,1.5-1.2 l4.2-15.2c0.2-0.7,0.8-1.2,1.5-1.2h25.2c0.7,0,1.3,0.5,1.5,1.2l4.2,15.2c0.2,0.7,0.8,1.2,1.5,1.2h17c1.1,0,1.8-1,1.5-2.1 l-28.2-89.4C434.6,20.8,434,20.3,433.3,20.3L433.3,20.3z M416,76.9l7.6-27.3c0.3-1,1.7-1,2,0l7.6,27.3c0.2,0.8-0.4,1.7-1.3,1.7 h-14.8C416.4,78.6,415.7,77.8,416,76.9L416,76.9z"/> <path class="ipflg2" d="M533.9,72.6c-1.5-2.6-3.5-4.6-6-6.3c-0.6-0.4-0.6-1.2-0.1-1.6c1-1,2.4-2.3,3.1-3.2c0.5-0.6,0.9-1.3,1.3-2 c2.3-3.7,3.4-8,3.4-13c0-8.1-2.7-14.5-8.2-19.1c-5.4-4.7-12.7-7-22.1-7h-32.8c-0.9,0-1.6,0.7-1.6,1.6v89.4c0,0.9,0.7,1.6,1.6,1.6 h35.9c9,0,16.2-2.3,21.3-7.2c5.1-4.7,7.7-11.5,7.7-20C537.3,80.7,536.1,76.3,533.9,72.6L533.9,72.6z M490.6,39.4 c0-0.9,0.7-1.6,1.6-1.6l12.8,0c3.7,0,6.4,0.8,8.2,2.4c0.1,0,0.1,0.1,0.2,0.2c1.6,1.7,2.5,4,2.5,7c0,3.4-0.9,5.8-2.7,7.7 c-1.7,1.7-4.4,2.6-8.2,2.6l-12.8,0c-0.9,0-1.6-0.7-1.6-1.6L490.6,39.4L490.6,39.4z M514.8,92.7c-1.7,1.8-4.4,2.7-8.2,2.7h-14.5 c-0.9,0-1.6-0.7-1.6-1.6V76.2c0-0.9,0.7-1.6,1.6-1.6h14.5c3.7,0,6.4,0.9,8.3,2.5c0.1,0.1,0.1,0.1,0.2,0.2c1.6,1.8,2.5,4.1,2.5,7.3 C517.6,88.1,516.7,90.7,514.8,92.7L514.8,92.7z"/> <path class="ipflg2" d="M703.8,92.7c-2.2,2.3-5.6,3.5-10.2,3.5c-5.1,0-8.8-1.4-11.1-4.4c-2.3-3-3.5-8.1-3.5-15.1V56.6 c0-7,1.2-12.1,3.5-15.1c2.3-3,6-4.4,11.1-4.4c4.6,0,8,1.2,10.2,3.5c2,2,3.2,4.8,3.5,8.2c0.1,0.8,0.8,1.5,1.6,1.5h16.3 c0.9,0,1.6-0.7,1.6-1.6c-0.3-9.2-3.3-16.2-9-21.4c-6-5.3-14.2-8.1-24.5-8.1c-22.6,0-34,12.5-34,37.2v20.6c0,24.7,11.5,37.2,34,37.2 c10.3,0,18.5-2.7,24.5-8.1c5.6-5.1,8.6-12.2,9-21.4c0-0.9-0.7-1.6-1.6-1.6h-16.3c-0.8,0-1.5,0.6-1.6,1.5 C707,87.9,705.8,90.6,703.8,92.7L703.8,92.7z"/> </g> </svg>';

  function reportStyles() {
    return `
:root{
  --navy:#143352; --deepnavy:#08132a; --magenta:#c01f60; --gray:#8d999b;
  --lightgray:#e5e4e4; --offwhite:#f6f6f6; --body:#222222; --white:#ffffff;
}
*{box-sizing:border-box;}
html,body{margin:0;padding:0;}
body{
  font-family:'Open Sans',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;
  color:var(--body); background:var(--white); line-height:1.5;
  -webkit-font-smoothing:antialiased;
}
.ipf-report{max-width:1100px;margin:0 auto;padding:40px 48px 64px;}
.ipf-report__logo{width:230px;max-width:60%;height:auto;display:block;margin-bottom:26px;}
.ipf-report__eyebrow{
  font-size:12px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;
  color:var(--gray);margin:0 0 6px;
}
.ipf-report__title{font-size:30px;font-weight:700;color:var(--navy);margin:0 0 18px;}
.ipf-report__meta{
  border-top:3px solid var(--magenta);padding-top:14px;margin:0 0 10px;
  display:flex;flex-wrap:wrap;gap:26px;font-size:13px;
}
.ipf-report__meta b{color:var(--navy);font-weight:700;}
.ipf-report__meta span{color:var(--gray);}
.ipf-report__query{
  background:var(--offwhite);border:1px solid var(--lightgray);border-left:4px solid var(--magenta);
  border-radius:6px;padding:12px 16px;margin:18px 0 26px;font-size:14px;color:var(--body);
  word-break:break-word;white-space:pre-wrap;
}
.ipf-report__query .lbl{display:block;font-size:11px;font-weight:700;letter-spacing:.08em;
  text-transform:uppercase;color:var(--gray);margin-bottom:4px;}
.ipf-report__section-title{
  font-size:18px;font-weight:700;color:var(--navy);margin:26px 0 12px;
  padding-bottom:6px;border-bottom:2px solid var(--magenta);
}
.ipf-report__body{font-size:14px;}
.ipf-report__footer{
  margin-top:40px;padding-top:14px;border-top:1px solid var(--lightgray);
  font-size:12px;color:var(--gray);display:flex;justify-content:space-between;gap:16px;flex-wrap:wrap;
}
.ipf-report__footer b{color:var(--navy);}
/* ---- Result content theming (mirrors the in-app result markup) ---- */
.ipf-report__body table,.ipf-report__body .data-table{
  border-collapse:collapse;width:100%;font-size:13px;margin:6px 0 18px;
}
.ipf-report__body .table-wrap{overflow-x:auto;}
.ipf-report__body th{
  background:var(--navy);color:#fff;text-align:left;font-weight:700;
  padding:8px 12px;border-bottom:2px solid var(--navy);white-space:nowrap;
}
.ipf-report__body td{
  padding:7px 12px;border-bottom:1px solid var(--lightgray);vertical-align:top;
}
.ipf-report__body tr:nth-child(even) td,.ipf-report__body tbody tr:nth-child(even){background:var(--offwhite);}
.ipf-report__body a,.ipf-report__body .detail-link,.ipf-report__body .path-link{
  color:var(--navy);text-decoration:none;border-bottom:1px solid var(--lightgray);
}
.ipf-report__body a:hover{color:var(--magenta);}
.ipf-report__body .text-block{
  white-space:pre-wrap;word-break:break-word;font-size:14px;line-height:1.6;
}
.ipf-report__body .code-block,.ipf-report__body pre{
  background:var(--offwhite);border:1px solid var(--lightgray);border-radius:6px;
  padding:12px 14px;overflow-x:auto;font-family:Consolas,Menlo,Monaco,monospace;
  font-size:12.5px;color:var(--deepnavy);white-space:pre-wrap;word-break:break-word;
}
/* LLM / CVE bucketed sections */
.ipf-report__body .llm-summary{font-size:14px;margin:0 0 16px;color:var(--body);}
.ipf-report__body .llm-section{margin:0 0 18px;}
.ipf-report__body .llm-section__header{
  display:flex;align-items:center;gap:8px;margin:0 0 8px;
}
.ipf-report__body .llm-section__label{
  font-size:14px;font-weight:700;color:var(--navy);
}
.ipf-report__body .llm-section__count{
  font-size:11px;font-weight:700;color:#fff;background:var(--magenta);
  border-radius:10px;padding:1px 8px;
}
.ipf-report__body .llm-list{list-style:none;margin:0;padding:0;}
.ipf-report__body .llm-item{
  padding:8px 0;border-bottom:1px solid var(--lightgray);
}
.ipf-report__body .llm-item__name{font-weight:700;color:var(--navy);}
/* Deep-link back into the IP Fabric UI (LLM Interactive Session & CVE
 * Security Status results). Inherits the item's bold navy; the dotted
 * underline marks it as clickable in the exported report too. */
.ipf-report__body .llm-item__name .ipf-ui-link{
  color:var(--navy);font-weight:700;text-decoration:none;
  border-bottom:1px dotted var(--navy);
}
.ipf-report__body .llm-item__name .ipf-ui-link:hover{
  color:var(--magenta);border-bottom-color:var(--magenta);
}
.ipf-report__body .llm-item__sep{color:var(--gray);margin:0 6px;}
.ipf-report__body .llm-item__detail{color:var(--body);}
.ipf-report__body .ok-yes{color:#007f33;font-weight:700;}
.ipf-report__body .ok-no{color:var(--magenta);font-weight:700;}
.ipf-report__body .scan-table-name,.ipf-report__body .scan-match-count{font-weight:700;color:var(--navy);}
.ipf-report__body .scan-sample{color:var(--gray);}
/* JSON token colors */
.ipf-report__body .tk-key{color:var(--navy);font-weight:700;}
.ipf-report__body .tk-str{color:#007f33;}
.ipf-report__body .tk-num{color:var(--magenta);}
.ipf-report__body .tk-bool{color:#8a4b08;}
.ipf-report__body .tk-null{color:var(--gray);}
/* Hide any in-app-only affordances that may live inside the captured markup */
.ipf-report__body .spinner,.ipf-report__body [data-llm-status]{display:none !important;}
@media print{ body{background:#fff;} .ipf-report{padding:0;} }
`;
  }

  // Build a complete standalone HTML report document.
  //   toolName    — e.g. "Global Search", "LLM Interactive Session", "CVE Security Status"
  //   queryLabel  — e.g. "Search term", "Prompt", "Action"
  //   queryValue  — the actual term / prompt / action text (may be empty)
  //   resultsHtml — the innerHTML captured from the tool's results container
  function buildHtmlReport({ toolName, queryLabel, queryValue, resultsHtml }) {
    const now = new Date();
    const generated = now.toLocaleString();
    const safeTool = escapeHtml(toolName || "Results");
    const host = (() => { try { return location.host || "IP Fabric"; } catch { return "IP Fabric"; } })();
    const queryBlock = queryValue
      ? `<div class="ipf-report__query"><span class="lbl">${escapeHtml(queryLabel || "Query")}</span>${escapeHtml(queryValue)}</div>`
      : "";
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>IP Fabric ${safeTool} report</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Open+Sans:ital,wght@0,400;0,600;0,700;1,400&display=swap" rel="stylesheet">
<style>${reportStyles()}</style>
</head>
<body>
<main class="ipf-report">
  ${IPF_LOGO_SVG.replace('<svg ', '<svg class="ipf-report__logo" ')}
  <p class="ipf-report__eyebrow">Chrome Extension &middot; ${safeTool}</p>
  <h1 class="ipf-report__title">${safeTool} report</h1>
  <div class="ipf-report__meta">
    <span><b>Source</b> &nbsp;${escapeHtml(host)}</span>
    <span><b>Generated</b> &nbsp;${escapeHtml(generated)}</span>
  </div>
  ${queryBlock}
  <h2 class="ipf-report__section-title">Results</h2>
  <div class="ipf-report__body">${resultsHtml || "<p>(no results)</p>"}</div>
  <div class="ipf-report__footer">
    <span>IP Fabric &middot; Global Search + LLM Interactive Session</span>
    <span>Generated by the IP Fabric browser extension</span>
  </div>
</main>
</body>
</html>`;
  }

  // Hand a finished report to the content script, which (in the host-page
  // context) opens it in a new tab or downloads it as a file.
  function deliverReport(mode, toolName, htmlDoc) {
    const base = (toolName || "ipfabric").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    const filename = `ipfabric-${base || "report"}-${stamp}.html`;
    try {
      window.parent.postMessage({
        type: "OPEN_HTML_REPORT", mode, filename, html: htmlDoc,
      }, "*");
    } catch { /* nothing else we can do from here */ }
  }

  // Convenience used by each panel: capture its state and emit the report.
  function makeReport(mode, { toolName, queryLabel, queryValue, resultsHtml }) {
    if (!resultsHtml || !resultsHtml.trim()) return;
    const doc = buildHtmlReport({ toolName, queryLabel, queryValue, resultsHtml });
    deliverReport(mode, toolName, doc);
  }

  function highlightJson(value) {
    const json = JSON.stringify(value, null, 2);
    return escapeHtml(json).replace(
      /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false)\b|\b(null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g,
      (_m, str, colon, bool, nul, num) => {
        if (str) {
          return colon
            ? `<span class="tk-key">${str}</span>${colon}`
            : `<span class="tk-str">${str}</span>`;
        }
        if (bool) return `<span class="tk-bool">${bool}</span>`;
        if (nul)  return `<span class="tk-null">${nul}</span>`;
        if (num)  return `<span class="tk-num">${num}</span>`;
        return _m;
      }
    );
  }

  function tpl(id) {
    const t = document.getElementById(id);
    return t.content.firstElementChild.cloneNode(true);
  }

  /* ====================================================================
   * Result-format detection
   * ================================================================== */

  // Cheap pre-check before running the heavier parser.
  function looksLikeApiEndpointResults(text) {
    return /^Found\s+\d+\s+API\s+endpoints?/im.test(text) ||
           /^##\s*\d+\.\s+(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\s+\//m.test(text);
  }

  /**
   * Parse the markdown-ish "Found N API endpoints..." text the IP Fabric
   * MCP server returns. Returns { summary: {count, query}, endpoints: [...] }
   * on success, or null on no match.
   */
  function parseApiEndpoints(text) {
    if (!looksLikeApiEndpointResults(text)) return null;

    const header = text.match(/^Found\s+(\d+)\s+API\s+endpoints?\s+matching\s+"([^"]+)"/im);
    const summary = header
      ? { count: parseInt(header[1], 10), query: header[2] }
      : null;

    // Sections separated by lines of '=' characters.
    const sections = text.split(/\n=+\s*\n/);
    const endpoints = [];

    for (const section of sections) {
      const h = section.match(/##\s*(\d+)\.\s+(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\s+(\S+)/);
      if (!h) continue;

      const num    = parseInt(h[1], 10);
      const method = h[2];
      const path   = h[3];

      const grab = (label) => {
        const m = section.match(
          new RegExp(`\\*\\*${label}:\\*\\*\\s+([^\\n]+)`, "i")
        );
        return m ? m[1].trim() : "";
      };

      const summary_     = grab("Summary");
      const description  = grab("Description");
      const opId         = grab("Operation ID");
      const tags         = grab("Tags");
      const matchScoreRaw = grab("Match Score");
      const callableRaw  = grab("Callable with current credentials");

      const scoreMatch = matchScoreRaw.match(/([\d.]+)/);
      const score = scoreMatch ? parseFloat(scoreMatch[1]) : null;
      const callable = /yes|true/i.test(callableRaw);

      // "Available data:" tends to live indented under Responses.
      const availMatch = section.match(/\*\*Available data:\*\*\s+([^\n]+)/i);
      const availableData = availMatch ? availMatch[1].trim() : "";

      const respCodeMatch = section.match(/\*\*Status Code:\*\*\s+(\d+)/i);
      const respCode = respCodeMatch ? respCodeMatch[1] : "";

      const respTypeMatch = section.match(/\*\*Response type:\*\*\s+([^\n]+)/i);
      const respType = respTypeMatch ? respTypeMatch[1].trim() : "";

      endpoints.push({
        num, method, path, summary: summary_, description, opId, tags,
        score, callable, availableData, respCode, respType,
      });
    }

    return endpoints.length ? { summary, endpoints } : null;
  }


  /* ====================================================================
   * IP Fabric UI deep-link matcher
   * ==================================================================
   *
   * The MCP search returns API endpoint paths (e.g.
   * "/tables/management/snmp/communities"). Each of those maps to a UI
   * page on the host (e.g. "/technology/management/snmp/communities").
   * We bundle the full list of UI table paths (extracted from the IP
   * Fabric URL inventory) and match API paths against it using a tight
   * tail-segment match — strict enough to avoid false positives but
   * lenient enough to handle the minor naming differences between the
   * API and the UI (e.g. API uses "l3-vpn", UI uses "l3vpn").
   */

  const IPF_TECH_PATHS = [
    "/inventory/devices",
    "/inventory/devices/models",
    "/inventory/devices/platforms",
    "/inventory/devices/families",
    "/inventory/devices/vendors",
    "/inventory/interfaces",
    "/inventory/sites/overview",
    "/inventory/sites/manual-separation",
    "/inventory/part-numbers",
    "/inventory/os-versions/platforms",
    "/inventory/os-versions/models",
    "/inventory/hosts",
    "/inventory/hosts/ipv6",
    "/inventory/end-of-life-milestones/summary",
    "/inventory/end-of-life-milestones/detail",
    "/technology/interfaces/rate/inbound",
    "/technology/interfaces/rate/outbound",
    "/technology/interfaces/rate/bidirectional",
    "/technology/interfaces/duplex",
    "/technology/interfaces/switchport",
    "/technology/interfaces/mtu",
    "/technology/interfaces/counters/inbound",
    "/technology/interfaces/counters/outbound",
    "/technology/interfaces/tunnels/ipv4",
    "/technology/interfaces/tunnels/ipv6",
    "/technology/cdp-lldp/all-neighbors",
    "/technology/cdp-lldp/unmanaged-neighbors",
    "/technology/cdp-lldp/unidirectional-neighbors",
    "/technology/cdp-lldp/endpoints",
    "/technology/platforms/stack/stacks",
    "/technology/platforms/poe/devices",
    "/technology/platforms/cisco-fabric-path/summary",
    "/technology/platforms/environment/power-supplies",
    "/technology/routing/summary/protocols",
    "/technology/routing/summary/bgp",
    "/technology/routing/summary/eigrp",
    "/technology/routing/summary/isis",
    "/technology/routing/summary/ospf",
    "/technology/routing/summary/ospfv3",
    "/technology/routing/summary/rip",
    "/technology/routing/routes",
    "/technology/routing/routes/ipv6",
    "/technology/routing/route-stability",
    "/technology/routing/ospf/neighbors",
    "/technology/routing/ospf/interfaces",
    "/technology/routing/bgp/neighbors",
    "/technology/routing/bgp/address-families",
    "/technology/routing/bgp/routes",
    "/technology/routing/bgp/routesIpv6",
    "/technology/routing/eigrp/neighbors",
    "/technology/routing/eigrp/interfaces",
    "/technology/routing/path-verifications",
    "/technology/routing/vrf/summary",
    "/technology/routing/vrf/detail",
    "/technology/routing/vrf/interfaces",
    "/technology/routing/policy/policies",
    "/technology/routing/policy/pbr-interfaces",
    "/technology/routing/policy/pbr",
    "/technology/security/access-list",
    "/technology/security/acl-interfaces",
    "/technology/security/acl/global-acl-policies",
    "/technology/security/dhcp-snooping/configuration-v4",
    "/technology/security/dhcp-snooping/bindings-v4",
    "/technology/security/ipsec/tunnels",
    "/technology/security/ipsec/gateways",
    "/technology/security/secure-ports/devices",
    "/technology/security/secure-ports/interfaces",
    "/technology/security/secure-ports/users",
    "/technology/security/ssl/certificates",
    "/technology/security/zone-firewall/policies",
    "/technology/security/zone-firewall/interfaces",
    "/technology/load-balancing/virtual-servers",
    "/technology/load-balancing/virtual-servers-pools",
    "/technology/load-balancing/virtual-servers-pool-members",
    "/technology/load-balancing/virtual-servers-path-rules",
    "/technology/load-balancing/virtual-servers-certs",
    "/technology/load-balancing/partitions",
    "/technology/mpls/ldp/neighbors",
    "/technology/mpls/ldp/interfaces",
    "/technology/mpls/rsvp/neighbors",
    "/technology/mpls/forwarding",
    "/technology/mpls/l3vpn/pe-routers",
    "/technology/mpls/l3vpn/vrf-on-pe",
    "/technology/mpls/l3vpn/vrf-route-targets",
    "/technology/mpls/l3vpn/pe-routes",
    "/technology/mpls/l2vpn/point-to-point-vpws",
    "/technology/mpls/l2vpn/point-to-multipoint-vpls",
    "/technology/mpls/l2vpn/circuit-cross-connect",
    "/technology/mpls/l2vpn/all-pseudowires",
    "/technology/sdn/aci/endpoint",
    "/technology/sdn/aci/dtep",
    "/technology/sdn/aci/vlan",
    "/technology/sdn/vxlan/vtep",
    "/technology/sdn/vxlan/peers",
    "/technology/sdn/vxlan/interfaces",
    "/technology/sdn/vxlan/vni",
    "/technology/sdn/apic/controllers",
    "/technology/sdn/apic/contexts",
    "/technology/sdn/apic/endpoint-groups",
    "/technology/sdn/apic/endpoint-groups-contracts",
    "/technology/sdn/apic/contracts",
    "/technology/sdwan/velocloud/overlay",
    "/technology/sdwan/meraki/overlay",
    "/technology/sdwan/silverpeak/overlay",
    "/technology/sdwan/silverpeak/underlay",
    "/technology/sdwan/viptela/bfd-sessions",
    "/technology/sdwan/viptela/control-connections",
    "/technology/sdwan/viptela/bfd-summary",
    "/technology/sdwan/versa/sites",
    "/technology/sdwan/versa/transport-links",
    "/technology/multicast/pim/interfaces",
    "/technology/multicast/pim/neighbors",
    "/technology/multicast/mroute/table",
    "/technology/multicast/mroute/counters",
    "/technology/multicast/mroute/sources",
    "/technology/multicast/igmp/groups",
    "/technology/multicast/igmp/interfaces",
    "/technology/multicast/igmp/snooping/global",
    "/technology/multicast/igmp/snooping/groups",
    "/technology/multicast/rp/overview",
    "/technology/multicast/rp/bsr",
    "/technology/multicast/rp/mappings",
    "/technology/multicast/rp/mappings-groups",
    "/technology/management/snmp/summary",
    "/technology/management/snmp/communities",
    "/technology/management/snmp/trap-hosts",
    "/technology/management/snmp/users",
    "/technology/management/flow/netflow-devices",
    "/technology/management/flow/netflow-collectors",
    "/technology/management/flow/netflow-interfaces",
    "/technology/management/flow/sflow-devices",
    "/technology/management/flow/sflow-collectors",
    "/technology/management/flow/sflow-data-sources",
    "/technology/management/ntp/summary",
    "/technology/management/ntp/sources",
    "/technology/management/port-mirroring",
    "/technology/management/telnet-access",
    "/technology/management/aaa/servers",
    "/technology/management/aaa/authentication",
    "/technology/management/aaa/authorization",
    "/technology/fhrp/group-state",
    "/technology/fhrp/group-members",
    "/technology/fhrp/glbp-forwarders",
    "/technology/addressing/nat",
    "/technology/addressing/arp-table",
    "/technology/addressing/mac-table",
    "/technology/addressing/managed-ip/ipv4",
    "/technology/addressing/managed-ip/ipv4-managed-ip-summary",
    "/technology/vlans/network-summary",
    "/technology/vlans/site-summary",
    "/technology/vlans/l3-gateways",
    "/technology/vlans/device-detail",
    // --- Merged from URL_Path_List_FULL.txt (v3.13.7): additional
    // IP Fabric table UI paths. Exact-duplicate paths already present
    // above are omitted so each entry is unique. ---
    "/inventory/sites/sites",
    "/inventory/applications/applications",
    "/inventory/applications/flows",
    "/inventory/applications/workloads",
    "/inventory/applications/devices",
    "/inventory/devices/devices",
    "/inventory/hosts/hosts",
    "/inventory/hosts/ipv6-hosts",
    "/inventory/hosts/inventory",
    "/inventory/hosts/virtual-machines-interfaces",
    "/technology/platforms/cluster/srx",
    "/technology/platforms/fex/modules",
    "/technology/platforms/fex/interfaces",
    "/technology/platforms/vss/overview",
    "/technology/platforms/vss/chassis",
    "/technology/platforms/vss/vsl",
    "/technology/platforms/poe/interfaces",
    "/technology/platforms/poe/modules",
    "/technology/platforms/stack/stack",
    "/technology/platforms/stack/members",
    "/technology/platforms/stack/connections",
    "/technology/platforms/environment/power-supplies-fans",
    "/technology/platforms/environment/fans",
    "/technology/platforms/environment/modules",
    "/technology/platforms/environment/temperature-sensors",
    "/technology/platforms/cisco-fabric-path/neighbors",
    "/technology/platforms/cisco-fabric-path/switches",
    "/technology/platforms/cisco-fabric-path/routes",
    "/technology/interfaces/connectivity-matrix/connectivity-matrix",
    "/technology/interfaces/connectivity-matrix/summary",
    "/technology/interfaces/connectivity-matrix/detail",
    "/technology/interfaces/storm-control/broadcast",
    "/technology/interfaces/storm-control/unicast",
    "/technology/interfaces/storm-control/multicast",
    "/technology/interfaces/storm-control/all",
    "/technology/interfaces/transceivers/inventory",
    "/technology/interfaces/transceivers/statistics",
    "/technology/interfaces/transceivers/thresholds",
    "/technology/interfaces/transceivers/errors",
    "/technology/interfaces/pppoe/pppoe",
    "/technology/interfaces/pppoe/sessions",
    "/technology/interfaces/virtual-wires/virtual-wires",
    "/technology/dhcp/relay/interfaces",
    "/technology/dhcp/relay/interfaces-stats/received",
    "/technology/dhcp/relay/interfaces-stats/relayed",
    "/technology/dhcp/relay/interfaces-stats/sent",
    "/technology/dhcp/relay/global-stats/summary",
    "/technology/dhcp/relay/global-stats/received",
    "/technology/dhcp/relay/global-stats/relayed",
    "/technology/dhcp/relay/global-stats/sent",
    "/technology/dhcp/server/summary",
    "/technology/dhcp/server/pools",
    "/technology/dhcp/server/leases",
    "/technology/dhcp/server/excluded-ranges",
    "/technology/dhcp/server/interfaces",
    "/technology/port-channels/mlag/switches",
    "/technology/port-channels/mlag/peers",
    "/technology/port-channels/mlag/pairs",
    "/technology/port-channels/mlag/vpc",
    "/technology/vlans/device-summary",
    "/technology/vlans/device",
    "/technology/spanning-tree/inconsistencies/vlans-no-stp/summary",
    "/technology/spanning-tree/inconsistencies/vlans-no-stp/details",
    "/technology/spanning-tree/inconsistencies/neighbor-ports-vlan-mismatch",
    "/technology/spanning-tree/inconsistencies/ports-multiple-neighbors",
    "/technology/spanning-tree/inconsistencies/stp-cdp-ports-mismatch",
    "/technology/spanning-tree/inconsistencies/multiple-stp",
    "/technology/addressing/managed-ip/managed-devs",
    "/technology/addressing/managed-ip/ipv6-managed-ip-summary",
    "/technology/addressing/managed-ip/ipv6-managed-devs",
    "/technology/routing/routes/routes",
    "/technology/routing/routes/ipv6-routes",
    "/technology/routing/ospf-v3/neighbors",
    "/technology/routing/ospf-v3/interfaces",
    "/technology/routing/rip/neighbors",
    "/technology/routing/rip/interfaces",
    "/technology/routing/is-is/neighbors",
    "/technology/routing/is-is/interfaces",
    "/technology/routing/is-is/levels",
    "/technology/routing/prefix-lists/ipv4",
    "/technology/routing/prefix-lists/ipv6",
    "/technology/routing/lisp/routes/ipv4-routes",
    "/technology/routing/lisp/routes/ipv6-routes",
    "/technology/routing/lisp/map-resolvers/ipv4-databases",
    "/technology/routing/lisp/map-resolvers/ipv6-databases",
    "/technology/routing/routing",
    "/technology/routing/interfaces",
    "/technology/routing/pbr",
    "/technology/mpls/rsvp/interfaces",
    "/technology/mpls/l3vpn/pe-vrfs",
    "/technology/mpls/l3vpn/vrf-targets",
    "/technology/mpls/l2vpn/point-to-multipoint",
    "/technology/mpls/l2vpn/pseudowires",
    "/technology/multicast/mroute/overview",
    "/technology/multicast/mroute/outgoing-interfaces",
    "/technology/multicast/mroute/first-hop-router",
    "/technology/multicast/igmp/snooping/vlans",
    "/technology/management/aaa/lines",
    "/technology/management/aaa/accounting",
    "/technology/management/aaa/users",
    "/technology/management/aaa/password-strength",
    "/technology/management/banners/summary",
    "/technology/management/banners/banners",
    "/technology/management/logging/summary",
    "/technology/management/logging/remote",
    "/technology/management/logging/local",
    "/technology/management/flow/overview",
    "/technology/management/flow/devices",
    "/technology/management/flow/collectors",
    "/technology/management/flow/interfaces",
    "/technology/management/flow/sources",
    "/technology/management/ptp/local-clock",
    "/technology/management/ptp/masters",
    "/technology/management/ptp/interfaces",
    "/technology/management/licenses/license/summary",
    "/technology/management/licenses/license/licenses",
    "/technology/management/licenses/license/detail",
    "/technology/management/licenses/cisco-smart-license/authorization",
    "/technology/management/licenses/cisco-smart-license/registration",
    "/technology/management/licenses/cisco-smart-license/reservations",
    "/technology/management/dns/settings",
    "/technology/management/dns/servers",
    "/technology/security/acl",
    "/technology/security/interfaces",
    "/technology/security/global-policies",
    "/technology/security/dhcp-snooping/snooping",
    "/technology/security/dhcp-snooping/bindings",
    "/technology/security/lsvpn/satellites",
    "/technology/security/lsvpn/gateways",
    "/technology/load-balancing/pools",
    "/technology/load-balancing/pool-members",
    "/technology/load-balancing/path-rules",
    "/technology/load-balancing/certificates",
    "/technology/wireless/radios/radio",
    "/technology/wireless/radios/ssid-summary",
    "/technology/sdn/aci/endpoints",
    "/technology/sdn/aci/vrf",
    "/technology/sdn/apic/bridge-domains",
    "/technology/sdn/apic/applications",
    "/technology/sdn/apic/service-graphs",
    "/technology/sdwan/versa/links",
    "/technology/qos/policy-maps",
    "/technology/qos/shaping",
    "/technology/qos/queuing",
    "/technology/qos/policing",
    "/technology/qos/priority-queuing",
    "/technology/qos/marking",
    "/technology/qos/random-drops",
    "/technology/oam/udld/neighbors",
    "/technology/oam/udld/interfaces",
    "/technology/cloud/nodes/inventory",
    "/technology/cloud/nodes/tags",
    "/technology/cloud/endpoints/virtual-machines",
    "/technology/cloud/endpoints/virtual-machines-interfaces",
    "/technology/cloud/endpoints/endpoint-groups",
    "/technology/cloud/public-ips/ip-addresses/ipv4-addresses",
    "/technology/cloud/public-ips/ip-addresses/ipv6-addresses",
    "/technology/cloud/networks/inventory",
    "/technology/cloud/networks/peerings",
    "/technology/cloud/network-interfaces",
    "/technology/cloud/subnets/inventory",
    "/technology/cloud/route-tables/inventory",
    "/technology/cloud/route-tables/routes",
    "/technology/cloud/security-addresses/inventory",
    "/technology/cloud/security-addresses/addresses",
    "/technology/cloud/private-link/endpoints",
    "/technology/cloud/private-link/services/inventory",
    "/technology/cloud/private-link/services/connections",
    "/technology/cloud/vendors/aws/inventory",
    "/technology/cloud/vendors/aws/scaling-groups",
    "/technology/cloud/vendors/aws/subnets",
    "/technology/cloud/vendors/aws/private-link/vpc-endpoints",
    "/technology/cloud/vendors/azure/inventory",
    "/technology/cloud/vendors/azure/virtual-machine-scale-sets",
    "/technology/cloud/vendors/azure/subnets",
    "/technology/cloud/vendors/azure/service-endpoints",
    "/technology/cloud/vendors/azure/private-link/endpoints",
    "/technology/cloud/vendors/azure/private-link/services",
    "/technology/cloud/vendors/azure/private-link/connections",
    "/technology/cloud/vendors/azure/vnet-integration/app-services",
    "/technology/cloud/vendors/azure/vnet-integration/container-apps",
    "/technology/cloud/vendors/azure/vnet-integration/flexible-servers",
    "/technology/cloud/vendors/azure/vnet-integration/sql-managed-instances",
    "/technology/cloud/vendors/azure/dns/vnet",
    "/technology/cloud/vendors/azure/dns/private-resolvers",
    "/technology/cloud/vendors/azure/dns/private-resolvers-endpoints",
    "/technology/cloud/vendors/azure/dns/forwarding-rulesets",
    "/technology/cloud/vendors/azure/dns/forwarding-rules",
    "/technology/cloud/vendors/gcp/inventory",
    "/technology/cloud/vendors/gcp/instance-network-endpoint-groups",
    "/technology/cloud/vendors/gcp/subnets",
    "/technology/cloud/vendors/gcp/private-service-connect/endpoints",
    "/technology/cloud/vendors/gcp/private-service-connect/published-services",
    "/technology/cloud/vendors/gcp/private-service-connect/published-services-connections",
    "/technology/cloud/vendors/gcp/serverless-services/app-engine",
    "/technology/cloud/vendors/gcp/serverless-services/cloud-functions",
    "/technology/cloud/vendors/gcp/serverless-services/cloud-run",
    // --- v5.1.0: additional tables reconciled from IP Fabric webPages.yaml ---
    "/inventory/devices/vendors-2",
    "/inventory/devices/families-2",
    "/inventory/devices/platforms-2",
    "/inventory/devices/models-2",
    "/inventory/part-numbers-2",
    "/inventory/hosts/virtual-machines",
    "/management/discovery-history",
    "/technology/platforms/cisco-fabric-path/is-is-neighbors",
    "/technology/platforms/cisco-fabric-path/switch-ids",
    "/technology/platforms/logical-devices",
    "/technology/interfaces/errdisabled",
    "/technology/interfaces/switchport-2",
    "/technology/interfaces/connectivity-matrix/unmanaged-neighbors-summary",
    "/technology/interfaces/connectivity-matrix/unmanaged-neighbors-detail",
    "/technology/cdp-lldp/all-neighbors-2",
    "/technology/cdp-lldp/unmanaged-neighbors-2",
    "/technology/cdp-lldp/unidirectional-neighbors-2",
    "/technology/cdp-lldp/endpoints-neighbors",
    "/technology/port-channels/inbound-balancing-table",
    "/technology/port-channels/outbound-balancing-table",
    "/technology/port-channels/member-status-table",
    "/technology/port-channels/mlag/peer-links",
    "/technology/port-channels/mlag/cisco-vpc",
    "/technology/spanning-tree/stp-bridges",
    "/technology/spanning-tree/stp-instances",
    "/technology/spanning-tree/stp-vlans",
    "/technology/spanning-tree/stp-virtual-ports",
    "/technology/spanning-tree/stp-neighbors",
    "/technology/spanning-tree/stp-guards",
    "/technology/spanning-tree/inconsistencies/vlans-no-stp/detail",
    "/technology/spbm/services",
    "/technology/spbm/b-mac-forwarding",
    "/technology/addressing/arp-table-2",
    "/technology/addressing/mac-table-2",
    "/technology/addressing/managed-duplicate-ip",
    "/technology/addressing/nat-2",
    "/technology/addressing/ipv6-neighbor-discovery",
    "/technology/addressing/managed-ip/ipv4-managed-ip",
    "/technology/addressing/managed-ip/ipv6-managed-ip",
    "/technology/fhrp/active-gateway-root-alignment",
    "/technology/fhrp/active-gateway-balancing",
    "/technology/fhrp/virtual-gateways",
    "/technology/routing/summary/is-is",
    "/technology/routing/route-stability-2",
    "/technology/routing/path-verifications-2",
    "/technology/routing/bgp/advertised-routes",
    "/technology/routing/bgp/advertised-routes-ipv6",
    "/technology/routing/lisp/routes/ipv4",
    "/technology/routing/lisp/routes/ipv6",
    "/technology/routing/lisp/map-resolvers/ipv4",
    "/technology/routing/lisp/map-resolvers/ipv6",
    "/technology/routing/routing-policies",
    "/technology/routing/pbr-interfaces",
    "/technology/routing/policy-based-routing",
    "/technology/multicast/mroute/mroute-table",
    "/technology/multicast/mroute/oil-detail",
    "/technology/multicast/mroute/mroute-counters",
    "/technology/multicast/mac",
    "/technology/multicast/rp/rp-overview",
    "/technology/multicast/rp/rp-mappings",
    "/technology/multicast/rp/rp-mappings-groups",
    "/technology/management/aaa/local-users",
    "/technology/management/telnet-access-2",
    "/technology/management/licenses/license",
    "/technology/management/licenses/license/license-detail",
    "/technology/management/licenses/cisco-smart-license",
    "/technology/management/licenses/cisco-smart-license/registration-2",
    "/technology/management/licenses/cisco-smart-license/reservations-2",
    "/technology/security/global-acl-policies",
    "/technology/security/dmvpn",
    "/technology/security/dhcp-snooping/configuration",
    "/technology/security/dhcp-snooping/binding-database",
    "/technology/wireless/controllers",
    "/technology/wireless/access-points",
    "/technology/wireless/clients",
    "/technology/wireless/radios/radios-detail",
    "/technology/ip-telephony/phones",
    "/technology/cloud/public-ips/ip-addresses/ipv4",
    "/technology/cloud/public-ips/ip-addresses/ipv6",
    "/technology/cloud/nat-gateways/inventory",
    "/technology/cloud/nat-gateways/rules",
    "/technology/cloud/security/inventory",
    "/technology/cloud/vendors/aws/internet-gateways",
    "/technology/serial-ports",
    "/settings/administration/license-consumption/overview",
    "/settings/administration/license-consumption/on-prem-devices",
    "/settings/administration/license-consumption/cloud-constructs"
  ];

  // Normalize a path segment for comparison: lowercase, no hyphens.
  // This handles the API/UI naming drift like "l3-vpn" ↔ "l3vpn"
  // without sacrificing precision on the rest of the segment.
  function normalizeSeg(s) {
    return String(s).toLowerCase().replace(/-/g, "");
  }

  // Split an API path into meaningful segments. Skips the "/tables/"
  // prefix common to IP Fabric MCP responses.
  function apiSegments(apiPath) {
    return apiPath.split("/")
      .filter((s) => s && s.toLowerCase() !== "tables")
      .map(normalizeSeg);
  }

  /**
   * Return the best matching UI path for an API path, or null if there
   * is no good match. The match is intentionally conservative — we
   * prefer to show no link than a wrong link.
   *
   * Strategy (highest-confidence first):
   *   1. Tail match: the UI path ends with the full API path segments.
   *      e.g. /tables/mpls/l3-vpn/pe-routers → /technology/mpls/l3vpn/pe-routers
   *   2. Last-two-segments match: the UI path's final two segments equal
   *      the API path's final two segments. Catches cases where the
   *      section prefix differs ("tables/X/A/B" → "technology/Y/A/B").
   *   3. Otherwise: null.
   *
   * Returns the UI path (e.g. "/technology/mpls/l3vpn/pe-routers"), not
   * a full URL. The caller composes that with hostOrigin.
   */
  function findMatchingUiPath(apiPath) {
    if (!apiPath || typeof apiPath !== "string") return null;
    const api = apiSegments(apiPath);
    if (!api.length) return null;

    // 1) Strict: UI path ends with the API path segments.
    for (const ui of IPF_TECH_PATHS) {
      const seg = ui.split("/").filter(Boolean).map(normalizeSeg);
      if (seg.length < api.length) continue;
      const tail = seg.slice(seg.length - api.length);
      let allEq = true;
      for (let i = 0; i < api.length; i++) {
        if (tail[i] !== api[i]) { allEq = false; break; }
      }
      if (allEq) return ui;
    }

    // 2) Looser: last two segments match.
    if (api.length >= 2) {
      const last2 = api.slice(-2);
      for (const ui of IPF_TECH_PATHS) {
        const seg = ui.split("/").filter(Boolean).map(normalizeSeg);
        if (seg.length < 2) continue;
        if (seg[seg.length - 2] === last2[0] && seg[seg.length - 1] === last2[1]) {
          return ui;
        }
      }
    }

    return null;
  }

  /* ====================================================================
   * IP Fabric UI deep-links  (per the `ipf-ui-link` skill)
   * ==================================================================
   *
   * Turns an item produced by the LLM Interactive Session or the CVE
   * Security Status evaluation into a clickable link back into the IP
   * Fabric web UI. Used by BOTH the on-screen results and the exported
   * HTML report — the report simply re-uses the rendered markup, so the
   * anchors carry through automatically.
   *
   * URL contract (from the skill — this is the definitive shape):
   *
   *   {base_url}{web_path}?options={url_encoded_json}&selectSnapshot={snap}
   *
   *   base_url       origin of the IPF instance (hostOrigin, from HOST_INFO)
   *   web_path       the UI route (NOT the API path). Resolved either from
   *                  the model's own `webPath`/`path` hint (mapped through
   *                  findMatchingUiPath when it looks like an API path) or
   *                  inferred from the bucket the item sits in.
   *   options        URL-encoded plain JSON (NOT base64) of the form
   *                    {"filters": {"and": [{"<col>": ["<op>", <value>]}]}}
   *                  The `and` wrapper is MANDATORY even for a single
   *                  column — IPF's advanced-filter parser rejects a bare
   *                  top-level column key ("Invalid initial advanced
   *                  filter").
   *   selectSnapshot snapshot UUID, or one of $last / $prev / $lastLocked.
   *                  Global, app-level param: valid on every route.
   *
   * Honesty rules carried over from the skill: never fabricate a webPath,
   * a column name or a snapshot; if we cannot resolve a confident target
   * we emit NO link rather than a broken one, and the item renders exactly
   * as it did before.
   * ================================================================== */

  // Snapshot to pin generated links to. content.js discovers the real
  // UUID from /api/snapshots and sends it over in HOST_INFO; until then
  // we fall back to the "$last" shortcut, which the skill allows for
  // everyday (non-compliance) links.
  let hostSnapshotId = "";

  const UI_LINK_SNAPSHOT_SHORTCUTS = ["$last", "$prev", "$lastLocked"];

  // Text operators that are valid on IPF text/ip columns. Anything not in
  // this set is rejected (we will not emit a filter with an invalid
  // operator — that produces an "Invalid initial advanced filter" error
  // on load rather than a usable view).
  const UI_LINK_VALID_OPS = new Set([
    "eq", "neq", "like", "notlike", "ieq", "nieq",
    "reg", "nreg", "ireg", "nireg", "cidr",
    "lt", "gt", "lte", "gte",
    "empty", "color",
  ]);

  // Landing routes used when we have to infer the target table from the
  // bucket an item was placed in. These are real IPF UI routes and appear
  // verbatim in IPF_TECH_PATHS.
  const UI_LINK_BUCKET_ROUTES = {
    devices:   "/inventory/devices",
    sites:     "/inventory/sites/overview",
    networks:  "/technology/addressing/managed-ip/networks",
    configs:   "/inventory/devices",
    snapshots: null,   // handled specially: /snapshot-management/<uuid>
    other:     null,   // no confident default — needs an explicit hint
  };

  // Which column each bucket's `name` is filtered on when we infer a link.
  const UI_LINK_BUCKET_FILTERS = {
    devices:   { column: "hostname", op: "eq" },
    sites:     { column: "siteName", op: "eq" },
    networks:  { column: "net",      op: "eq" },
    configs:   { column: "hostname", op: "eq" },
  };

  const UUID_RE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  // A hostname-ish token: what IPF device hostnames actually look like.
  // Used to pull a device name out of a CVE item like
  // "L21EXR1 — Cisco IOS 15.2" or "CVE-2023-20198 — L21EXR1".
  const HOSTNAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{1,62}$/;

  function isSnapshotRef(v) {
    if (typeof v !== "string" || !v) return false;
    return UUID_RE.test(v) || UI_LINK_SNAPSHOT_SHORTCUTS.includes(v);
  }

  // The snapshot every generated link is pinned to. Prefer the real UUID
  // the host discovered; otherwise use the $last shortcut so the link
  // still lands on a sane view.
  function currentSnapshotRef() {
    return isSnapshotRef(hostSnapshotId) ? hostSnapshotId : "$last";
  }

  /**
   * Build the `options` query-parameter value from a filters object.
   *
   * Accepts either the canonical wrapped shape
   *   {"and": [{"hostname": ["eq", "L21"]}]}
   * or a bare single/multi-column object
   *   {"hostname": ["eq", "L21"], "siteName": ["eq", "HWL"]}
   * and ALWAYS emits the wrapped form, per the skill.
   *
   * Returns null when there is nothing valid to filter on.
   */
  function buildUiLinkOptions(filters) {
    if (!filters || typeof filters !== "object" || Array.isArray(filters)) return null;

    let clauses;
    if (Array.isArray(filters.and) || Array.isArray(filters.or)) {
      // Already wrapped — validate the clauses but keep the operator.
      const key = Array.isArray(filters.and) ? "and" : "or";
      clauses = filters[key].filter(isValidFilterClause);
      if (!clauses.length) return null;
      return encodeURIComponent(JSON.stringify({ filters: { [key]: clauses } }));
    }

    // Bare column map → wrap each column as its own clause inside `and`.
    clauses = Object.keys(filters)
      .map((col) => ({ [col]: filters[col] }))
      .filter(isValidFilterClause);
    if (!clauses.length) return null;
    return encodeURIComponent(JSON.stringify({ filters: { and: clauses } }));
  }

  // A clause is {"<column>": [<operator>, <value>]} (or ["color","eq","20"]).
  function isValidFilterClause(clause) {
    if (!clause || typeof clause !== "object" || Array.isArray(clause)) return false;
    const cols = Object.keys(clause);
    if (cols.length !== 1) return false;
    const col = cols[0];
    if (!col || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(col)) return false;
    const spec = clause[col];
    if (!Array.isArray(spec) || spec.length < 2) return false;
    const op = spec[0];
    if (typeof op !== "string" || !UI_LINK_VALID_OPS.has(op)) return false;
    const val = spec[1];
    const t = typeof val;
    if (t !== "string" && t !== "number" && t !== "boolean") return false;
    if (t === "string" && !val) return false;
    return true;
  }

  /**
   * Resolve a route hint (which may be a UI web path, or an API path the
   * model happened to quote) into a real IPF UI web path.
   * Returns null when it cannot be resolved with confidence.
   */
  function resolveUiWebPath(hint) {
    if (!hint || typeof hint !== "string") return null;
    let p = hint.trim();
    if (!p) return null;
    // Tolerate a full URL.
    if (/^https?:\/\//i.test(p)) {
      try { p = new URL(p).pathname; } catch { return null; }
    }
    if (p[0] !== "/") p = "/" + p;
    p = p.replace(/\/+$/, "") || "/";

    // API-shaped hints (/api/..., /tables/...) map through the existing
    // conservative API→UI matcher.
    if (/^\/(api|tables)\b/i.test(p) || /^\/api\//i.test(p)) {
      return findMatchingUiPath(p.replace(/^\/api\b/i, ""));
    }

    // Exact UI route we already know about.
    const known = IPF_TECH_PATHS.find((u) => u.toLowerCase() === p.toLowerCase());
    if (known) return known;

    // Routes the UI has that aren't tables (so aren't in IPF_TECH_PATHS)
    // but are still legitimate link targets per the skill.
    if (/^\/(inventory|technology|management|dashboard|snapshot-management|diagrams)(\/|$)/i.test(p)) {
      return p;
    }

    // Last resort: treat it as an API-ish path and try the matcher, which
    // returns null when it isn't confident.
    return findMatchingUiPath(p);
  }

  /**
   * Pull a plausible device hostname out of an item name. CVE items are
   * named things like "CVE-2023-20198 — L21EXR1" or "L21EXR1 (Cisco IOS
   * 15.2)"; device items are usually just the hostname. Returns null when
   * nothing hostname-like is present, so no link gets fabricated.
   */
  function extractHostnameFromName(name) {
    const raw = String(name == null ? "" : name).trim();
    if (!raw) return null;

    // Split on the separators the prompts tell the model to use.
    const parts = raw.split(/\s+[—–-]\s+|[()[\]]|,\s*/g)
      .map((s) => s.trim())
      .filter(Boolean);
    const candidates = parts.length ? parts : [raw];

    for (const c of candidates) {
      // Never treat the CVE identifier itself as a hostname.
      if (/^CVE-\d{4}-\d{4,}$/i.test(c)) continue;
      // Skip obvious version / vendor prose ("Cisco IOS 15.2", "15.2(4)E").
      if (/\s/.test(c)) continue;
      if (!HOSTNAME_RE.test(c)) continue;
      // A bare version string ("15.2.4E") isn't a hostname.
      if (/^[\d._()]+[A-Za-z]?$/.test(c)) continue;
      return c;
    }
    return null;
  }

  /**
   * Core builder. Given an item from a bucketed LLM/CVE answer, return a
   * full deep-link URL (string) or null.
   *
   * The model may supply an explicit hint on the item, which we honour
   * first (this is the skill's "compute the answer, then link" path):
   *
   *   item.link = {
   *     webPath:  "/inventory/devices",       // or apiPath: "/tables/inventory/devices"
   *     filters:  { "hostname": ["eq", "L21EXR1"] },   // wrapped or bare
   *     snapshot: "<uuid>"                    // optional; defaults to current
   *   }
   *
   * With no hint we fall back to inference from the bucket + item name,
   * which is what makes existing/legacy answers link up too.
   */
  function buildIpfUiLink(item, bucketKey) {
    if (!hostOrigin) return null;                 // no instance base URL yet
    if (!item || typeof item !== "object") return null;

    const base = String(hostOrigin).replace(/\/+$/, "");
    const hint = (item.link && typeof item.link === "object") ? item.link : null;

    const snapRaw = hint && hint.snapshot;
    const snapshot = isSnapshotRef(snapRaw) ? snapRaw : currentSnapshotRef();

    /* --- snapshots bucket: the UUID lives in the path itself --------- */
    if (bucketKey === "snapshots") {
      const uuid = [item.name, hint && hint.snapshot]
        .map((v) => (typeof v === "string" ? v.trim() : ""))
        .find((v) => UUID_RE.test(v));
      if (uuid) return `${base}/snapshot-management/${uuid}`;
      // A named (non-UUID) snapshot can't be addressed — no link.
      return null;
    }

    /* --- 1) explicit hint from the model ----------------------------- */
    // Honour it only when BOTH the route and the filter validate. A hint
    // whose route we can't resolve, or whose filter uses an unknown column
    // shape / invalid operator, is discarded wholesale: we fall through to
    // inference (which yields a correctly-filtered link) rather than emit a
    // link that silently drops the filter and lands on the whole table.
    if (hint) {
      const webPath = resolveUiWebPath(hint.webPath || hint.path || hint.apiPath);
      const opts = webPath ? buildUiLinkOptions(hint.filters) : null;
      if (webPath && opts) {
        return base + webPath + "?options=" + opts +
               "&selectSnapshot=" + encodeURIComponent(snapshot);
      }
      // A route with no filter at all is still useful when the model
      // deliberately points at a whole table (and there's nothing for us
      // to infer) — but only if inference can't do better. Handled below.
      if (webPath && !hint.filters && !UI_LINK_BUCKET_ROUTES[bucketKey]) {
        return base + webPath + "?selectSnapshot=" + encodeURIComponent(snapshot);
      }
    }

    /* --- 2) infer from the bucket + item name ------------------------ */
    const route = UI_LINK_BUCKET_ROUTES[bucketKey];
    const filterSpec = UI_LINK_BUCKET_FILTERS[bucketKey];
    if (!route || !filterSpec) return null;

    // Devices and configs (the CVE "Configuration Specific" bucket) are
    // keyed on a hostname we may have to dig out of a composite name.
    const value = (bucketKey === "devices" || bucketKey === "configs")
      ? extractHostnameFromName(item.name)
      : (typeof item.name === "string" && item.name.trim() ? item.name.trim() : null);
    if (!value) return null;

    const opts = buildUiLinkOptions({ [filterSpec.column]: [filterSpec.op, value] });
    if (!opts) return null;

    return `${base}${route}?options=${opts}&selectSnapshot=${encodeURIComponent(snapshot)}`;
  }

  /**
   * Render one bucketed item's <li>. Shared verbatim by the LLM
   * Interactive Session and the CVE Security Status renderers so the two
   * stay identical (and so the HTML report, which re-uses this markup,
   * carries the same anchors).
   *
   * When a link can be built, the item NAME becomes the anchor; when it
   * can't, the markup is exactly what it was before this feature existed.
   */
  function buildBucketItemLi(item, bucketKey) {
    const li = document.createElement("li");
    li.className = "llm-item";

    const name = (item && item.name != null) ? String(item.name) : "(unnamed)";
    const detail = (item && item.detail != null) ? String(item.detail) : "";

    li.innerHTML =
      '<span class="llm-item__name"></span>' +
      (detail ? ' <span class="llm-item__sep">·</span> <span class="llm-item__detail"></span>' : "");

    const nameEl = li.querySelector(".llm-item__name");
    const href = buildIpfUiLink(item, bucketKey);
    if (href) {
      const a = document.createElement("a");
      a.className = "ipf-ui-link";
      a.href = href;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.textContent = name;
      a.title = "Open in IP Fabric: " + href;
      nameEl.appendChild(a);
    } else {
      nameEl.textContent = name;
    }

    if (detail) li.querySelector(".llm-item__detail").textContent = detail;
    return li;
  }

  /* ====================================================================
   * Renderers
   * ================================================================== */

  function renderLoading() {
    results.innerHTML = "";
    results.appendChild(tpl("tpl-loading"));
    resultsMeta.hidden = true;
    showDropdown();
    sendResize();
  }

  function renderError(message) {
    results.innerHTML = "";
    const node = tpl("tpl-error");
    node.querySelector("[data-message]").textContent = message;
    results.appendChild(node);
    resultsMeta.hidden = true;
    showDropdown();
    sendResize();
  }

  function setMeta({ primary, tool }) {
    resultsMetaTxt.textContent = primary || "";
    resultsTool.textContent = tool || "";
    resultsTool.style.display = tool ? "" : "none";
    resultsMeta.hidden = false;
    showDropdown();
    refreshToggleButtons();
  }

  /* --- API endpoint table ------------------------------------------ */

  function renderEndpointsTable(parsed, tool, query) {
    const count = parsed.summary ? parsed.summary.count : parsed.endpoints.length;
    const queryLabel = parsed.summary ? parsed.summary.query : query;
    setMeta({
      primary: `${count} API endpoint${count === 1 ? "" : "s"} for "${queryLabel}"`,
      tool: tool ? `${tool.name}` : "",
    });

    results.innerHTML = "";
    const tableWrap = tpl("tpl-endpoint-table");
    const tbody = tableWrap.querySelector("[data-body]");

    for (const ep of parsed.endpoints) {
      const row = tpl("tpl-endpoint-row");
      row.querySelector("[data-method]").textContent = ep.method;
      row.querySelector("[data-method]").classList.add(`method--${ep.method.toLowerCase()}`);

      // Path cell: wrap in a deep link when we can match the API path
      // to a known UI page. Click stops propagation so it doesn't also
      // toggle the row's expand state.
      const pathEl = row.querySelector("[data-path]");
      pathEl.textContent = ep.path;
      const uiPath = findMatchingUiPath(ep.path);
      if (uiPath && hostOrigin) {
        const link = document.createElement("a");
        link.href = hostOrigin + uiPath;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.className = "path-link";
        link.title = "Open in IP Fabric: " + uiPath;
        link.addEventListener("click", (e) => e.stopPropagation());
        // Wrap the existing <code> element inside the link, then add an
        // external-link icon after it so the affordance is visible.
        pathEl.parentNode.insertBefore(link, pathEl);
        link.appendChild(pathEl);
        const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        icon.setAttribute("viewBox", "0 0 24 24");
        icon.setAttribute("fill", "none");
        icon.setAttribute("stroke", "currentColor");
        icon.setAttribute("stroke-width", "2.4");
        icon.setAttribute("stroke-linecap", "round");
        icon.setAttribute("stroke-linejoin", "round");
        icon.setAttribute("class", "ext-icon");
        icon.setAttribute("aria-hidden", "true");
        icon.innerHTML =
          '<path d="M7 17 17 7"/><polyline points="9 7 17 7 17 15"/>';
        link.appendChild(icon);
      }

      row.querySelector("[data-summary]").textContent = ep.summary || "";
      row.querySelector("[data-tags]").textContent = ep.tags || "";
      row.querySelector("[data-tags]").title = ep.tags || "";

      const scorePct = ep.score != null ? Math.round(ep.score * 100) : 0;
      row.querySelector("[data-bar]").style.width = scorePct + "%";
      row.querySelector("[data-score]").textContent =
        ep.score != null ? ep.score.toFixed(3) : "—";

      const okEl = row.querySelector("[data-ok]");
      if (ep.callable) {
        okEl.innerHTML = '<span class="ok-yes" title="Callable">✓</span>';
      } else {
        okEl.innerHTML = '<span class="ok-no" title="Not callable">✗</span>';
      }

      const detail = tpl("tpl-endpoint-detail");
      const grid = detail.querySelector("[data-grid]");
      const addRow = (label, html) => {
        if (!html) return;
        const dt = document.createElement("dt");
        dt.textContent = label;
        const dd = document.createElement("dd");
        dd.innerHTML = html;
        grid.appendChild(dt);
        grid.appendChild(dd);
      };
      addRow("Description", ep.description ? escapeHtml(ep.description) : "");
      addRow("Operation ID", ep.opId ? `<code>${escapeHtml(ep.opId)}</code>` : "");
      if (uiPath && hostOrigin) {
        // Surface the deep link prominently in the expanded detail too.
        const fullUrl = hostOrigin + uiPath;
        addRow(
          "UI page",
          `<a href="${escapeHtml(fullUrl)}" target="_blank" rel="noopener noreferrer" class="detail-link">${escapeHtml(uiPath)}</a>`
        );
      }
      if (ep.respCode || ep.respType) {
        const parts = [];
        if (ep.respCode) parts.push(`<code>${escapeHtml(ep.respCode)}</code>`);
        if (ep.respType) parts.push(escapeHtml(ep.respType));
        addRow("Response", parts.join(" · "));
      }
      addRow("Available data",
        ep.availableData ? `<code>${escapeHtml(ep.availableData)}</code>` : "");

      // Toggle expansion when the user clicks the data row.
      row.addEventListener("click", () => {
        const expanded = row.classList.toggle("expanded");
        detail.hidden = !expanded;
      });

      tbody.appendChild(row);
      tbody.appendChild(detail);
    }

    results.appendChild(tableWrap);
    sendResize();
  }

  /* --- Generic data-array table ------------------------------------ */

  /**
   * Build a table from an array of plain objects. Filters out an `id`
   * column if present (usually internal). Returns the wrapping element
   * or null if the input doesn't look table-able.
   */
  function buildGenericTable(rows) {
    if (!Array.isArray(rows) || !rows.length) return null;
    if (typeof rows[0] !== "object" || rows[0] === null || Array.isArray(rows[0])) return null;

    // Collect the union of keys across all rows so a missing field in
    // row 0 doesn't lose us a column. Keep order from first-seen.
    const keys = [];
    const seen = new Set();
    for (const r of rows) {
      if (r && typeof r === "object") {
        for (const k of Object.keys(r)) {
          if (!seen.has(k)) { seen.add(k); keys.push(k); }
        }
      }
    }
    // Drop internal id column if there are other useful fields.
    const cols = (keys.length > 1) ? keys.filter((k) => k !== "id") : keys;

    const wrap = tpl("tpl-data-table");
    const thead = wrap.querySelector("[data-head]");
    const tbody = wrap.querySelector("[data-body]");

    const trh = document.createElement("tr");
    for (const k of cols) {
      const th = document.createElement("th");
      th.textContent = k;
      trh.appendChild(th);
    }
    thead.appendChild(trh);

    for (const row of rows) {
      const tr = document.createElement("tr");
      for (const k of cols) {
        const td = document.createElement("td");
        const v = row[k];
        if (v == null) {
          td.textContent = "—";
          td.classList.add("cell-null");
        } else if (typeof v === "object") {
          const s = JSON.stringify(v);
          td.textContent = s.length > 80 ? s.slice(0, 78) + "…" : s;
          td.title = s;
          td.classList.add("cell-obj");
        } else {
          td.textContent = String(v);
          td.title = String(v);
        }
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }

    return wrap;
  }

  function renderGenericTable(rows, meta, tool, query) {
    const wrap = buildGenericTable(rows);
    if (!wrap) return false;

    const count = (meta && (meta.count ?? meta.size)) || rows.length;
    const showing = rows.length;
    let primary = `${count} record${count === 1 ? "" : "s"}`;
    if (showing < count) primary += ` (showing ${showing})`;
    if (query) primary += ` for "${query}"`;

    setMeta({ primary, tool: tool ? tool.name : "" });

    results.innerHTML = "";
    results.appendChild(wrap);
    sendResize();
    return true;
  }

  /* --- Fallbacks --------------------------------------------------- */

  function renderJsonFallback(value, tool, query) {
    setMeta({ primary: query ? `Raw result for "${query}"` : "Result", tool: tool ? tool.name : "" });
    results.innerHTML = "";
    const pre = document.createElement("pre");
    pre.className = "code-block";
    pre.innerHTML = highlightJson(value);
    results.appendChild(pre);
    sendResize();
  }

  function renderTextFallback(text, tool, query) {
    setMeta({ primary: query ? `Result for "${query}"` : "Result", tool: tool ? tool.name : "" });
    results.innerHTML = "";
    const div = document.createElement("div");
    div.className = "text-block";
    div.textContent = text;
    results.appendChild(div);
    sendResize();
  }

  /* ====================================================================
   * Dispatcher
   * ================================================================== */

  function renderResults({ tool, result }, query) {
    const blocks = (result && Array.isArray(result.content)) ? result.content : [];
    if (!blocks.length) {
      results.innerHTML = "";
      results.appendChild(tpl("tpl-empty"));
      setMeta({ primary: "No content returned", tool: tool ? tool.name : "" });
      sendResize();
      return;
    }

    // Concatenate all text blocks for parsing. Multiple text blocks are
    // uncommon but happen with some MCP servers.
    const textBlocks = blocks.filter((b) => b && b.type === "text" && typeof b.text === "string");
    const joined = textBlocks.map((b) => b.text).join("\n\n").trim();

    // 1) IP Fabric API endpoint search markdown
    const endpoints = parseApiEndpoints(joined);
    if (endpoints) {
      renderEndpointsTable(endpoints, tool, query);
      return;
    }

    // 2) JSON: array of objects, or {data: [...]} envelope
    if (joined) {
      let parsed = null;
      if ((joined.startsWith("{") && joined.endsWith("}")) ||
          (joined.startsWith("[") && joined.endsWith("]"))) {
        try { parsed = JSON.parse(joined); } catch { /* not JSON */ }
      }
      if (parsed) {
        if (Array.isArray(parsed) &&
            renderGenericTable(parsed, null, tool, query)) return;
        if (parsed && Array.isArray(parsed.data) &&
            renderGenericTable(parsed.data, parsed._meta, tool, query)) return;
        renderJsonFallback(parsed, tool, query);
        return;
      }
    }

    // 3) Plain text
    if (textBlocks.length) {
      renderTextFallback(joined, tool, query);
      return;
    }

    // 4) Unknown block types
    renderJsonFallback(blocks, tool, query);
  }

  /* ====================================================================
   * Search trigger — dispatches based on mode (MCP vs table-scan)
   * ================================================================== */

  async function doSearch() {
    const query = input.value.trim();
    if (!query) { input.focus(); return; }
    // Persist immediately on search so a deep-link click in the
    // results doesn't race the debounced input listener.
    saveQuery(query);

    // Read the current mode from sync storage each search so changes
    // in Options take effect without reloading the page.
    let mode = "mcp";
    try {
      const cfg = await chrome.storage.sync.get({ searchMode: "scan" });
      mode = cfg.searchMode === "mcp" ? "mcp" : "scan";
    } catch { /* fall through with default */ }

    if (mode === "scan") {
      await doTableScan(query);
    } else {
      await doLlmMcpSearch(query);
    }
  }

  async function doLlmMcpSearch(query) {
    activeLlmTarget = "gs";
    searchBtn.disabled = true;
    renderLlmLoading();
    try {
      let response;
      try {
        response = await chrome.runtime.sendMessage({
          type: "LLM_MCP_SEARCH", query,
        });
      } catch (e) {
        // Common cause: the background service worker was killed mid-call
        // (long non-streaming Anthropic request, no keepalive). Streaming
        // in v1.6.2+ should prevent this, but if it still happens, give
        // the user something actionable rather than the cryptic raw error.
        const m = String(e && e.message || e);
        if (m.includes("message channel closed") || m.includes("disconnected port")) {
          throw new Error(
            "The background service worker disconnected before responding. " +
            "This usually means the request was killed by Chrome. " +
            "Check chrome://extensions → \"Service Worker\" → console for details, " +
            "and retry."
          );
        }
        throw e;
      }
      if (!response) throw new Error("No response from background service worker.");
      if (!response.ok) throw new Error(response.error || "Unknown error");
      renderLlmResults(response.data, query);
    } catch (err) {
      renderError(err && err.message ? err.message : String(err));
    } finally {
      // Ensure the elapsed-time interval is stopped whether the request
      // succeeded, errored, or was aborted — handleLlmProgress only
      // hears the success path so we need a guaranteed cleanup here.
      stopLlmTicker();
      searchBtn.disabled = false;
    }
  }

  function renderLlmLoading() {
    setMeta({
      primary: "Asking Claude to investigate via the IP Fabric MCP server…",
      tool: "llm+mcp",
    });
    results.innerHTML = "";
    const node = document.createElement("div");
    node.className = "status";
    node.setAttribute("data-llm-status", "1");
    node.innerHTML =
      '<span class="spinner" aria-hidden="true"></span>' +
      '<span data-llm-status-text>Connecting to Anthropic…</span>' +
      '<span class="spacer"></span>' +
      '<span data-llm-elapsed></span>';
    results.appendChild(node);
    sendResize();
  }

  function renderLlmResults(data, query) {
    const { parsed, rawText, toolCalls } = data || {};
    results.innerHTML = "";

    if (!parsed) {
      // Couldn't extract structured JSON. Fall back to showing raw text.
      setMeta({
        primary: `Claude responded but did not return structured results`,
        tool: "llm+mcp",
      });
      const wrap = document.createElement("div");
      wrap.className = "text-block";
      wrap.textContent = rawText || "(no response text)";
      results.appendChild(wrap);
      sendResize();
      return;
    }

    const buckets = [
      { key: "networks",  label: "Networks"  },
      { key: "devices",   label: "Devices"   },
      { key: "sites",     label: "Sites"     },
      { key: "configs",   label: "Configs"   },
      { key: "snapshots", label: "Snapshots" },
      { key: "other",     label: "Other"     },
    ];
    const totals = buckets.map((b) =>
      Array.isArray(parsed[b.key]) ? parsed[b.key].length : 0
    );
    const grandTotal = totals.reduce((a, b) => a + b, 0);

    setMeta({
      primary: grandTotal
        ? `${grandTotal} match${grandTotal === 1 ? "" : "es"} for "${query}" across ${totals.filter((n) => n > 0).length} categor${totals.filter((n) => n > 0).length === 1 ? "y" : "ies"}`
        : `No matches found for "${query}"`,
      tool: `llm+mcp · ${toolCalls?.length || 0} tool call${(toolCalls?.length || 0) === 1 ? "" : "s"}`,
    });

    // Summary blurb (if Claude gave one)
    if (parsed.summary && typeof parsed.summary === "string") {
      const sum = document.createElement("div");
      sum.className = "llm-summary";
      sum.textContent = parsed.summary;
      results.appendChild(sum);
    }

    // Render each non-empty bucket as a small section.
    for (let i = 0; i < buckets.length; i++) {
      const { key, label } = buckets[i];
      const rows = parsed[key];
      if (!Array.isArray(rows) || !rows.length) continue;

      const section = document.createElement("div");
      section.className = "llm-section";

      const header = document.createElement("div");
      header.className = "llm-section__header";
      header.innerHTML = `<span class="llm-section__label"></span> <span class="llm-section__count"></span>`;
      header.querySelector(".llm-section__label").textContent = label;
      header.querySelector(".llm-section__count").textContent = `${rows.length}`;
      section.appendChild(header);

      const list = document.createElement("ul");
      list.className = "llm-list";
      for (const item of rows) {
        const li = document.createElement("li");
        li.className = "llm-item";
        const name = (item && item.name != null) ? String(item.name) : "(unnamed)";
        const detail = (item && item.detail != null) ? String(item.detail) : "";
        li.innerHTML =
          '<span class="llm-item__name"></span>' +
          (detail ? ' <span class="llm-item__sep">·</span> <span class="llm-item__detail"></span>' : "");
        li.querySelector(".llm-item__name").textContent = name;
        if (detail) li.querySelector(".llm-item__detail").textContent = detail;
        list.appendChild(li);
      }
      section.appendChild(list);
      results.appendChild(section);
    }

    if (grandTotal === 0) {
      const empty = document.createElement("div");
      empty.className = "status status--muted";
      empty.textContent =
        "Claude investigated via the MCP server but found no matches in " +
        "networks, devices, sites, configs, or snapshots.";
      results.appendChild(empty);
    }

    sendResize();
  }

  /* ====================================================================
   * Table-scan mode
   * ==================================================================
   *
   * Asks content.js (running in the host page context with the user's
   * session cookie) to hit every IPF_TECH_PATHS API in parallel and
   * search each table's rows for the query. content.js streams
   * progress messages back via window.postMessage; we render a live
   * progress bar + matched-tables list as the data flows in.
   */

  let activeScanId = null;
  let scanState = null;  // { query, total, done, matches, started }

  // One-time wiring: forward scan progress messages from content.js
  // to our handler. content.js posts these from the parent window.
  window.addEventListener("message", (e) => {
    const m = e.data || {};
    if (m.type === "TABLE_SCAN_PROGRESS" && m.scanId === activeScanId) {
      handleScanProgress(m);
    }
  });

  async function doTableScan(query) {
    searchBtn.disabled = true;
    // Cancel any previous scan.
    if (activeScanId) {
      parent.postMessage({ type: "CANCEL_TABLE_SCAN", scanId: activeScanId }, "*");
    }
    activeScanId = "scan-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);
    scanState = {
      query,
      total: IPF_TECH_PATHS.length,
      done: 0,
      matches: [],
      started: Date.now(),
    };
    renderScanInitial();
    // Ask the parent (content.js) to run the scan. We pass the path
    // list explicitly so content.js doesn't need a copy.
    parent.postMessage({
      type: "START_TABLE_SCAN",
      query,
      uiPaths: IPF_TECH_PATHS,
      scanId: activeScanId,
    }, "*");
  }

  function handleScanProgress(msg) {
    if (!scanState) return;
    if (msg.event === "start") {
      scanState.total = msg.total;
      renderScanProgress();
    } else if (msg.event === "match") {
      scanState.done = msg.done;
      scanState.matches.push(msg.match);
      renderScanProgress();
    } else if (msg.event === "progress") {
      scanState.done = msg.done;
      // Throttle UI updates — only redraw every few items.
      if (scanState.done % 5 === 0 || scanState.done === scanState.total) {
        renderScanProgress();
      }
    } else if (msg.event === "done") {
      scanState.done = msg.done;
      if (msg.error) {
        // Snapshot discovery failed or some other fatal error — show it
        // as a normal error in the dropdown instead of an empty result.
        renderError(msg.error);
      } else {
        renderScanFinal();
      }
      searchBtn.disabled = false;
      activeScanId = null;
    }
  }

  function renderScanInitial() {
    setMeta({
      primary: `Scanning ${scanState.total} IP Fabric tables for "${scanState.query}"…`,
      tool: "table-scan",
    });
    results.innerHTML = "";
    results.appendChild(buildScanProgressEl());
    results.appendChild(buildScanMatchesEl());
    sendResize();
  }

  function renderScanProgress() {
    setMeta({
      primary: `Scanning ${scanState.done}/${scanState.total} · ${scanState.matches.length} match${scanState.matches.length === 1 ? "" : "es"}`,
      tool: "table-scan",
    });
    const bar = results.querySelector("[data-scan-bar]");
    const counter = results.querySelector("[data-scan-counter]");
    if (bar) {
      bar.style.width = Math.round((scanState.done / scanState.total) * 100) + "%";
    }
    if (counter) {
      counter.textContent = `${scanState.done} / ${scanState.total}`;
    }
    refreshScanMatchesList();
    sendResize();
  }

  function renderScanFinal() {
    const dur = ((Date.now() - scanState.started) / 1000).toFixed(1);
    setMeta({
      primary: `${scanState.matches.length} table${scanState.matches.length === 1 ? "" : "s"} contain "${scanState.query}" (scanned ${scanState.done}/${scanState.total} in ${dur}s)`,
      tool: "table-scan",
    });
    // Remove the progress bar; keep the matches list.
    const prog = results.querySelector(".scan-progress");
    if (prog) prog.remove();
    if (scanState.matches.length === 0) {
      const empty = document.createElement("div");
      empty.className = "status status--muted";
      empty.textContent = "No tables contained the search term. " +
        "This may mean the term genuinely isn't in any of the scanned " +
        "tables, or that the API path patterns don't match your IP " +
        "Fabric version (HTTP errors are silently skipped).";
      results.appendChild(empty);
    }
    refreshScanMatchesList();
    sendResize();
  }

  function buildScanProgressEl() {
    const wrap = document.createElement("div");
    wrap.className = "scan-progress";
    wrap.innerHTML =
      '<div class="scan-progress__bar"><div class="scan-progress__fill" data-scan-bar style="width:0%"></div></div>' +
      '<div class="scan-progress__caption">' +
        '<span data-scan-counter>0 / ' + scanState.total + '</span>' +
        ' tables scanned · 6 concurrent · stays on this page' +
      '</div>';
    return wrap;
  }

  function buildScanMatchesEl() {
    const wrap = document.createElement("div");
    wrap.className = "table-wrap";
    wrap.setAttribute("data-scan-matches", "1");
    wrap.innerHTML =
      '<table class="data-table data-table--scan">' +
      '<thead><tr>' +
        '<th>Table</th>' +
        '<th>UI page</th>' +
        '<th>Matches</th>' +
        '<th>Sample row</th>' +
      '</tr></thead>' +
      '<tbody data-scan-tbody></tbody></table>';
    return wrap;
  }

  function refreshScanMatchesList() {
    const tbody = results.querySelector("[data-scan-tbody]");
    if (!tbody) return;
    // Re-render every time — simple and the list is small (at most
    // a few dozen tables).
    tbody.innerHTML = "";
    for (const m of scanState.matches) {
      const tr = document.createElement("tr");

      // Table column: derive a display name from the UI path
      const name = m.uiPath.split("/").filter(Boolean).slice(-2).join(" / ");
      const c1 = document.createElement("td");
      c1.innerHTML = '<span class="scan-table-name"></span>';
      c1.querySelector("span").textContent = name;
      tr.appendChild(c1);

      // UI page column: clickable link to the host
      const c2 = document.createElement("td");
      if (hostOrigin) {
        const a = document.createElement("a");
        a.href = hostOrigin + m.uiPath;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        a.className = "detail-link";
        a.textContent = m.uiPath;
        c2.appendChild(a);
      } else {
        c2.textContent = m.uiPath;
      }
      tr.appendChild(c2);

      // Match count column
      const c3 = document.createElement("td");
      c3.innerHTML = '<span class="scan-match-count"></span>';
      const span = c3.querySelector("span");
      span.textContent = m.matchCount + (m.matchCount >= 5 ? "+" : "");
      tr.appendChild(c3);

      // Sample row column — show a few key fields if present
      const c4 = document.createElement("td");
      c4.className = "scan-sample";
      const sample = (m.sampleMatches && m.sampleMatches[0]) || {};
      const pretty = Object.entries(sample)
        .filter(([k, v]) => v != null && typeof v !== "object" && k !== "id")
        .slice(0, 4)
        .map(([k, v]) => `${k}=${String(v).slice(0, 40)}`)
        .join(" · ");
      c4.title = JSON.stringify(sample, null, 2);
      c4.textContent = pretty || "(no preview)";
      tr.appendChild(c4);

      tbody.appendChild(tr);
    }
  }

  /* ====================================================================
   * LLM Interactive Session controller (right side of the bar)
   * ==================================================================
   *
   * Mirrors the Global Search bar's behaviour but for free-form prompts:
   * sends INTERACTIVE_PROMPT to the background worker and renders the
   * answer into the LLM dropdown (#llmResults / #llmDropdown). Reuses the
   * shared helpers (escapeHtml, highlightJson, sendResize) from this same
   * IIFE scope. Bucketed/prose rendering matches the Global Search LLM
   * output exactly.
   */
  const LLM = (() => {
    const promptEl   = $("#prompt");
    const clearPromptBtn = $("#clearPrompt");
    const submitBtn  = $("#submitBtn");
    const dropdownEl = $("#llmDropdown");
    const resultsEl  = $("#llmResults");
    const metaEl     = $("#llmResultsMeta");
    const metaTxt    = $("#llmResultsMetaText");
    const toolEl     = $("#llmResultsTool");

    const PROMPT_KEY = "ipfgs_last_prompt";
    const llmToggleBtn = document.getElementById("llmToggleBtn");

    // Whether the LLM dropdown currently holds rendered results, so the
    // toggle button knows there's something to re-show.
    let llmHasResults = false;
    // The prompt that produced the currently-shown results (for HTML report).
    let lastRenderedPrompt = "";

    function refreshToggle() {
      if (!llmToggleBtn) return;
      llmToggleBtn.hidden = !llmHasResults;
      llmToggleBtn.classList.toggle("is-active", llmHasResults && !dropdownEl.hidden);
      llmToggleBtn.title = dropdownEl.hidden ? "Show results" : "Hide results";
    }
    // Let the outer scope refresh this toggle too (e.g. on init).
    window.__refreshLlmToggle = refreshToggle;

    function show() { dropdownEl.hidden = false; llmHasResults = true; refreshToggle(); }
    function hide() { dropdownEl.hidden = true; }
    function focus() { promptEl.focus(); }

    // Hide WITHOUT wiping content (outside-click), so it can be toggled back.
    function hideResults() { hide(); sendResize(); refreshToggle(); }
    function showResults() { if (!llmHasResults) return; dropdownEl.hidden = false; sendResize(); refreshToggle(); }
    function toggleResults() {
      if (!llmHasResults) return;
      if (dropdownEl.hidden) showResults(); else hideResults();
    }

    function refreshClearBtn() { clearPromptBtn.hidden = !promptEl.value; }

    function savePrompt(p) {
      try { chrome.storage.local.set({ [PROMPT_KEY]: p || "" }).catch(() => {}); }
      catch { /* no storage */ }
    }
    function loadPrompt() {
      return new Promise((resolve) => {
        try {
          chrome.storage.local.get({ [PROMPT_KEY]: "" }).then(
            (o) => resolve(o[PROMPT_KEY] || ""), () => resolve(""));
        } catch { resolve(""); }
      });
    }
    loadPrompt().then((p) => { if (p && !promptEl.value) { promptEl.value = p; refreshClearBtn(); } });

    /* ---- persist LLM results across navigations ---- */
    const LLM_RESULTS_KEY = "ipfgs_last_llm_results";
    function persistResults() {
      try {
        chrome.storage.local.set({
          [LLM_RESULTS_KEY]: {
            html: resultsEl.innerHTML,
            metaText: metaTxt.textContent || "",
            metaTool: toolEl.textContent || "",
            prompt: lastRenderedPrompt || "",
          },
        }).catch(() => {});
      } catch { /* no storage */ }
    }
    function clearPersistedResults() {
      try { chrome.storage.local.remove(LLM_RESULTS_KEY).catch(() => {}); }
      catch { /* no storage */ }
    }
    function restorePersistedResults() {
      try {
        chrome.storage.local.get({ [LLM_RESULTS_KEY]: null }).then((obj) => {
          const saved = obj && obj[LLM_RESULTS_KEY];
          if (!saved || !saved.html) return;
          resultsEl.innerHTML = saved.html;
          metaTxt.textContent = saved.metaText || "";
          toolEl.textContent = saved.metaTool || "";
          lastRenderedPrompt = saved.prompt || "";
          toolEl.style.display = saved.metaTool ? "" : "none";
          if (saved.metaText || saved.metaTool) metaEl.hidden = false;
          llmHasResults = true;
          dropdownEl.hidden = true;   // start hidden; user toggles to view
          refreshToggle();
        }, () => {});
      } catch { /* no storage */ }
    }
    restorePersistedResults();

    let _llmPersistTimer = null;
    function scheduleLlmPersist() {
      clearTimeout(_llmPersistTimer);
      _llmPersistTimer = setTimeout(() => {
        const html = resultsEl.innerHTML;
        if (!html) return;
        // Skip the transient loading state.
        if (resultsEl.querySelector("[data-llm-status]")) return;
        persistResults();
      }, 250);
    }
    try {
      new MutationObserver(scheduleLlmPersist).observe(resultsEl, {
        childList: true, subtree: true, characterData: true,
      });
    } catch { /* no MutationObserver */ }

    function setMeta({ primary, tool }) {
      metaTxt.textContent = primary || "";
      toolEl.textContent = tool || "";
      toolEl.style.display = tool ? "" : "none";
      metaEl.hidden = false;
      show();
    }

    function clearResults() {
      resultsEl.innerHTML = "";
      metaEl.hidden = true;
      hide();
      llmHasResults = false;
      clearPersistedResults();
      sendResize();
      refreshToggle();
    }

    function clearPrompt() {
      promptEl.value = "";
      refreshClearBtn();
      savePrompt("");
      clearResults();
      focus();
    }

    function truncate(s, n) {
      s = String(s || "");
      return s.length > n ? s.slice(0, n - 1) + "…" : s;
    }

    /* ---- progress feedback ---- */
    let callStart = 0, toolCount = 0, ticker = null;
    function handleProgress(msg) {
      if (msg.event === "request_sent") {
        callStart = Date.now(); toolCount = 0;
        startTicker(); updateLoading("Connecting to Anthropic…");
      } else if (msg.event === "streaming_started") {
        updateLoading("Claude is working…");
      } else if (msg.event === "tool_use_start") {
        toolCount = msg.toolIndex || (toolCount + 1);
        const tool = msg.toolName || "(tool)";
        updateLoading(`Tool call ${toolCount}: <code>${escapeHtmlSafe(tool)}</code>…`);
      } else if (msg.event === "complete") {
        stopTicker();
      }
    }
    function startTicker() { stopTicker(); ticker = setInterval(() => updateLoading(null), 1000); }
    function stopTicker() { if (ticker) { clearInterval(ticker); ticker = null; } }
    function updateLoading(text) {
      const status = resultsEl.querySelector("[data-llm-status]");
      if (!status) return;
      const elapsed = Math.floor((Date.now() - callStart) / 1000);
      const tail = callStart ? `${elapsed}s` : "";
      if (text !== null) {
        const t = status.querySelector("[data-llm-status-text]");
        if (t) t.innerHTML = text;
      }
      const e = status.querySelector("[data-llm-elapsed]");
      if (e) e.textContent = tail;
    }

    /* ---- renderers ---- */
    function renderLoading() {
      setMeta({ primary: "Asking Claude to work via the IP Fabric MCP server…", tool: "llm+mcp" });
      resultsEl.innerHTML = "";
      const node = document.createElement("div");
      node.className = "status";
      node.setAttribute("data-llm-status", "1");
      node.innerHTML =
        '<span class="spinner" aria-hidden="true"></span>' +
        '<span data-llm-status-text>Connecting to Anthropic…</span>' +
        '<span class="spacer"></span>' +
        '<span class="llm-elapsed" data-llm-elapsed></span>';
      resultsEl.appendChild(node);
      show();
      sendResize();
    }

    function renderError(message) {
      resultsEl.innerHTML = "";
      const node = document.createElement("div");
      node.className = "status status--error";
      node.innerHTML =
        '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
        'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
        '<circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line>' +
        '<line x1="12" y1="16" x2="12.01" y2="16"></line></svg><span></span>';
      node.querySelector("span").textContent = message;
      resultsEl.appendChild(node);
      metaEl.hidden = true;
      show();
      sendResize();
    }

    function renderResults(data, prompt) {
      const { parsed, rawText, toolCalls } = data || {};
      lastRenderedPrompt = prompt || "";
      resultsEl.innerHTML = "";
      const toolLabel = `llm+mcp · ${toolCalls?.length || 0} tool call${(toolCalls?.length || 0) === 1 ? "" : "s"}`;

      if (!parsed) {
        setMeta({ primary: `Claude's answer for "${truncate(prompt, 50)}"`, tool: toolLabel });
        const wrap = document.createElement("div");
        wrap.className = "text-block";
        wrap.textContent = rawText || "(no response text)";
        resultsEl.appendChild(wrap);
        show(); sendResize();
        return;
      }

      const buckets = [
        { key: "networks",  label: "Networks"  },
        { key: "devices",   label: "Devices"   },
        { key: "sites",     label: "Sites"     },
        { key: "configs",   label: "Configs"   },
        { key: "snapshots", label: "Snapshots" },
        { key: "other",     label: "Other"     },
      ];
      const totals = buckets.map((b) => Array.isArray(parsed[b.key]) ? parsed[b.key].length : 0);
      const grandTotal = totals.reduce((a, b) => a + b, 0);
      const cats = totals.filter((n) => n > 0).length;
      const hasAnyBucket = buckets.some((b) => Array.isArray(parsed[b.key]));

      if (!hasAnyBucket) {
        setMeta({ primary: `Result for "${truncate(prompt, 50)}"`, tool: toolLabel });
        const pre = document.createElement("pre");
        pre.className = "code-block";
        pre.innerHTML = highlightJson(parsed);
        resultsEl.appendChild(pre);
        show(); sendResize();
        return;
      }

      setMeta({
        primary: grandTotal
          ? `${grandTotal} result${grandTotal === 1 ? "" : "s"} for "${truncate(prompt, 40)}" across ${cats} categor${cats === 1 ? "y" : "ies"}`
          : `No results for "${truncate(prompt, 50)}"`,
        tool: toolLabel,
      });

      if (parsed.summary && typeof parsed.summary === "string") {
        const sum = document.createElement("div");
        sum.className = "llm-summary";
        sum.textContent = parsed.summary;
        resultsEl.appendChild(sum);
      }

      for (let i = 0; i < buckets.length; i++) {
        const { key, label } = buckets[i];
        const rows = parsed[key];
        if (!Array.isArray(rows) || !rows.length) continue;

        const section = document.createElement("div");
        section.className = "llm-section";
        const header = document.createElement("div");
        header.className = "llm-section__header";
        header.innerHTML = `<span class="llm-section__label"></span> <span class="llm-section__count"></span>`;
        header.querySelector(".llm-section__label").textContent = label;
        header.querySelector(".llm-section__count").textContent = `${rows.length}`;
        section.appendChild(header);

        const list = document.createElement("ul");
        list.className = "llm-list";
        for (const item of rows) {
          // buildBucketItemLi turns the item's name into a clickable IP
          // Fabric UI deep-link when one can be built (see the ipf-ui-link
          // section above); otherwise it renders exactly as plain text.
          list.appendChild(buildBucketItemLi(item, key));
        }
        section.appendChild(list);
        resultsEl.appendChild(section);
      }

      if (grandTotal === 0) {
        const empty = document.createElement("div");
        empty.className = "status status--muted";
        empty.textContent =
          "Claude worked via the MCP server but returned no items in " +
          "networks, devices, sites, configs, or snapshots.";
        resultsEl.appendChild(empty);
      }

      show(); sendResize();
    }

    /* ---- submit flow ---- */
    async function doSubmit() {
      const prompt = (promptEl.value || "").trim();
      if (!prompt) { focus(); return; }
      savePrompt(prompt);
      activeLlmTarget = "llm";
      submitBtn.disabled = true;
      renderLoading();
      try {
        let response;
        try {
          response = await chrome.runtime.sendMessage({ type: "INTERACTIVE_PROMPT", prompt });
        } catch (e) {
          const m = String(e && e.message || e);
          if (m.includes("message channel closed") || m.includes("disconnected port")) {
            throw new Error(
              "The background service worker disconnected before responding. " +
              "This usually means Chrome killed the request. Check " +
              "chrome://extensions → \"Service Worker\" → console, and retry."
            );
          }
          throw e;
        }
        if (!response) throw new Error("No response from background service worker.");
        if (!response.ok) throw new Error(response.error || "Unknown error");
        renderResults(response.data, prompt);
      } catch (err) {
        renderError(err && err.message ? err.message : String(err));
      } finally {
        stopTicker();
        submitBtn.disabled = false;
      }
    }

    /* ---- wiring ---- */
    promptEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); doSubmit(); }
      if (e.key === "Escape") { e.preventDefault(); clearResults(); promptEl.blur(); }
    });
    promptEl.addEventListener("input", () => { refreshClearBtn(); savePrompt(promptEl.value); });

    // Report data for the HTML report (prompt + currently-rendered markup).
    function getReportData() {
      return {
        toolName: "LLM Interactive Session",
        queryLabel: "Prompt",
        queryValue: (lastRenderedPrompt || promptEl.value || "").trim(),
        resultsHtml: resultsEl.innerHTML,
      };
    }

    return { doSubmit, clearResults, clearPrompt, focus, handleProgress, hide,
             toggleResults, hideResults, showResults, getReportData };
  })();

  /* ====================================================================
   * CVE Security Status controller (host-page "Evaluate" button)
   * ==================================================================
   *
   * Triggered by the "Evaluate" button that content.js overlays on the
   * host page's header row. When clicked, content.js posts
   * CVE_EVALUATE_CLICK to this iframe; we send CVE_EVALUATE to the
   * background worker (which runs the same agentic MCP loop the LLM
   * Interactive Session uses, but with a fixed CVE cross-reference task)
   * and render the bucketed/prose answer into the CVE dropdown
   * (#cveResults / #cveDropdown) — identical rendering, persistence, and
   * show/hide-on-outside-click behavior to the Global Search and LLM
   * Interactive Session results. Results persist until the user clears
   * them (the × in the meta row) or clicks Evaluate again.
   */
  const CVE = (() => {
    const dropdownEl = $("#cveDropdown");
    const resultsEl  = $("#cveResults");
    const metaEl     = $("#cveResultsMeta");
    const metaTxt    = $("#cveResultsMetaText");
    const toolEl     = $("#cveResultsTool");

    // Whether the CVE dropdown currently holds rendered results.
    let cveHasResults = false;

    // Tell content.js (which owns the host-page CVE control) the current
    // results-panel state so its results-toggle button can mirror the bar's
    // toggle: shown only when there are results, highlighted while visible.
    function notifyState() {
      parent.postMessage({
        type: "CVE_STATE",
        hasResults: cveHasResults,
        visible: cveHasResults && !dropdownEl.hidden,
      }, "*");
    }

    function show() { dropdownEl.hidden = false; cveHasResults = true; notifyState(); }
    function hide() { dropdownEl.hidden = true; notifyState(); }

    // Hide WITHOUT wiping content (outside-click), so it can be re-shown.
    function hideResults() { hide(); sendResize(); }
    function showResults() { if (!cveHasResults) return; dropdownEl.hidden = false; sendResize(); notifyState(); }
    function toggleResults() {
      if (!cveHasResults) return;
      if (dropdownEl.hidden) showResults(); else hideResults();
    }

    function setMeta({ primary, tool }) {
      metaTxt.textContent = primary || "";
      toolEl.textContent = tool || "";
      toolEl.style.display = tool ? "" : "none";
      metaEl.hidden = false;
      show();
    }

    function clearResults() {
      resultsEl.innerHTML = "";
      metaEl.hidden = true;
      hide();
      cveHasResults = false;
      clearPersistedResults();
      sendResize();
      notifyState();
    }

    function truncate(s, n) {
      s = String(s || "");
      return s.length > n ? s.slice(0, n - 1) + "…" : s;
    }

    /* ---- persist CVE results across navigations ---- */
    const CVE_RESULTS_KEY = "ipfgs_last_cve_results";
    function persistResults() {
      try {
        chrome.storage.local.set({
          [CVE_RESULTS_KEY]: {
            html: resultsEl.innerHTML,
            metaText: metaTxt.textContent || "",
            metaTool: toolEl.textContent || "",
          },
        }).catch(() => {});
      } catch { /* no storage */ }
    }
    function clearPersistedResults() {
      try { chrome.storage.local.remove(CVE_RESULTS_KEY).catch(() => {}); }
      catch { /* no storage */ }
    }
    function restorePersistedResults() {
      try {
        chrome.storage.local.get({ [CVE_RESULTS_KEY]: null }).then((obj) => {
          const saved = obj && obj[CVE_RESULTS_KEY];
          if (!saved || !saved.html) return;
          resultsEl.innerHTML = saved.html;
          metaTxt.textContent = saved.metaText || "";
          toolEl.textContent = saved.metaTool || "";
          toolEl.style.display = saved.metaTool ? "" : "none";
          if (saved.metaText || saved.metaTool) metaEl.hidden = false;
          cveHasResults = true;
          dropdownEl.hidden = true;   // start hidden; the toggle button re-shows
          // Surface the toggle button on the host-page control so the user
          // can re-open the restored results after a deep-link navigation.
          notifyState();
        }, () => {});
      } catch { /* no storage */ }
    }
    restorePersistedResults();

    let _cvePersistTimer = null;
    function scheduleCvePersist() {
      clearTimeout(_cvePersistTimer);
      _cvePersistTimer = setTimeout(() => {
        const html = resultsEl.innerHTML;
        if (!html) return;
        if (resultsEl.querySelector("[data-cve-status]")) return; // skip transient loading
        persistResults();
      }, 250);
    }
    try {
      new MutationObserver(scheduleCvePersist).observe(resultsEl, {
        childList: true, subtree: true, characterData: true,
      });
    } catch { /* no MutationObserver */ }

    /* ---- progress feedback (mirrors the LLM session) ---- */
    let callStart = 0, toolCount = 0, ticker = null;
    function handleProgress(msg) {
      if (msg.event === "request_sent") {
        callStart = Date.now(); toolCount = 0;
        startTicker(); updateLoading("Connecting to Anthropic…");
      } else if (msg.event === "streaming_started") {
        updateLoading("Evaluating CVE security status…");
      } else if (msg.event === "tool_use_start") {
        toolCount = msg.toolIndex || (toolCount + 1);
        const tool = msg.toolName || "(tool)";
        updateLoading(`Tool call ${toolCount}: <code>${escapeHtmlSafe(tool)}</code>…`);
      } else if (msg.event === "complete") {
        stopTicker();
      }
    }
    // Expose the progress handler so the iframe message router can reach it.
    window.__cveHandleProgress = handleProgress;
    function startTicker() { stopTicker(); ticker = setInterval(() => updateLoading(null), 1000); }
    function stopTicker() { if (ticker) { clearInterval(ticker); ticker = null; } }
    function updateLoading(text) {
      const status = resultsEl.querySelector("[data-cve-status]");
      if (!status) return;
      const elapsed = Math.floor((Date.now() - callStart) / 1000);
      const tail = callStart ? `${elapsed}s` : "";
      if (text !== null) {
        const t = status.querySelector("[data-cve-status-text]");
        if (t) t.innerHTML = text;
      }
      const e = status.querySelector("[data-cve-elapsed]");
      if (e) e.textContent = tail;
    }

    /* ---- renderers (match the LLM session output exactly) ---- */
    function renderLoading() {
      setMeta({ primary: "Evaluating CVE security status via the IP Fabric MCP server…", tool: "llm+mcp" });
      resultsEl.innerHTML = "";
      const node = document.createElement("div");
      node.className = "status";
      node.setAttribute("data-cve-status", "1");
      node.innerHTML =
        '<span class="spinner" aria-hidden="true"></span>' +
        '<span data-cve-status-text>Connecting to Anthropic…</span>' +
        '<span class="spacer"></span>' +
        '<span class="llm-elapsed" data-cve-elapsed></span>';
      resultsEl.appendChild(node);
      show();
      sendResize();
    }

    function renderError(message) {
      resultsEl.innerHTML = "";
      const node = document.createElement("div");
      node.className = "status status--error";
      node.innerHTML =
        '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
        'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
        '<circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line>' +
        '<line x1="12" y1="16" x2="12.01" y2="16"></line></svg><span></span>';
      node.querySelector("span").textContent = message;
      resultsEl.appendChild(node);
      metaEl.hidden = true;
      show();
      sendResize();
    }

    function renderResults(data) {
      const { parsed, rawText, toolCalls } = data || {};
      resultsEl.innerHTML = "";
      const toolLabel = `llm+mcp · ${toolCalls?.length || 0} tool call${(toolCalls?.length || 0) === 1 ? "" : "s"}`;

      if (!parsed) {
        // No structured JSON — fall back to prose, like the LLM session.
        setMeta({ primary: "CVE Security Status", tool: toolLabel });
        const wrap = document.createElement("div");
        wrap.className = "text-block";
        wrap.textContent = rawText || "(no response text)";
        resultsEl.appendChild(wrap);
        show(); sendResize();
        return;
      }

      const buckets = [
        { key: "networks",  label: "Networks"  },
        { key: "devices",   label: "Devices"   },
        { key: "sites",     label: "Sites"     },
        { key: "configs",   label: "Configuration Specific" },
        { key: "snapshots", label: "Snapshots" },
        { key: "other",     label: "Other"     },
      ];
      const totals = buckets.map((b) => Array.isArray(parsed[b.key]) ? parsed[b.key].length : 0);
      const grandTotal = totals.reduce((a, b) => a + b, 0);
      const cats = totals.filter((n) => n > 0).length;
      const hasAnyBucket = buckets.some((b) => Array.isArray(parsed[b.key]));

      if (!hasAnyBucket) {
        setMeta({ primary: "CVE Security Status", tool: toolLabel });
        const pre = document.createElement("pre");
        pre.className = "code-block";
        pre.innerHTML = highlightJson(parsed);
        resultsEl.appendChild(pre);
        show(); sendResize();
        return;
      }

      setMeta({
        primary: grandTotal
          ? `CVE Security Status — ${grandTotal} finding${grandTotal === 1 ? "" : "s"} across ${cats} categor${cats === 1 ? "y" : "ies"}`
          : `CVE Security Status — no affected devices found`,
        tool: toolLabel,
      });

      if (parsed.summary && typeof parsed.summary === "string") {
        const sum = document.createElement("div");
        sum.className = "llm-summary";
        sum.textContent = parsed.summary;
        resultsEl.appendChild(sum);
      }

      for (let i = 0; i < buckets.length; i++) {
        const { key, label } = buckets[i];
        const rows = parsed[key];
        if (!Array.isArray(rows) || !rows.length) continue;

        const section = document.createElement("div");
        section.className = "llm-section";
        const header = document.createElement("div");
        header.className = "llm-section__header";
        header.innerHTML = `<span class="llm-section__label"></span> <span class="llm-section__count"></span>`;
        header.querySelector(".llm-section__label").textContent = label;
        header.querySelector(".llm-section__count").textContent = `${rows.length}`;
        section.appendChild(header);

        const list = document.createElement("ul");
        list.className = "llm-list";
        for (const item of rows) {
          // Same shared builder the LLM Interactive Session uses, so the
          // CVE findings (including the "Configuration Specific" section,
          // which is the `configs` bucket) link back into the IP Fabric UI
          // wherever a confident target can be resolved.
          list.appendChild(buildBucketItemLi(item, key));
        }
        section.appendChild(list);
        resultsEl.appendChild(section);
      }

      if (grandTotal === 0) {
        const empty = document.createElement("div");
        empty.className = "status status--muted";
        empty.textContent =
          "No current devices were found to be affected by published CVE vulnerabilities.";
        resultsEl.appendChild(empty);
      }

      show(); sendResize();
    }

    /* ---- evaluate flow ---- */
    async function doEvaluate() {
      activeLlmTarget = "cve";
      // Tell content.js to disable the host-page Evaluate button while busy.
      parent.postMessage({ type: "CVE_BUSY", busy: true }, "*");
      renderLoading();
      try {
        let response;
        try {
          response = await chrome.runtime.sendMessage({ type: "CVE_EVALUATE" });
        } catch (e) {
          const m = String(e && e.message || e);
          if (m.includes("message channel closed") || m.includes("disconnected port")) {
            throw new Error(
              "The background service worker disconnected before responding. " +
              "This usually means Chrome killed the request. Check " +
              "chrome://extensions → \"Service Worker\" → console, and retry."
            );
          }
          throw e;
        }
        if (!response) throw new Error("No response from background service worker.");
        if (!response.ok) throw new Error(response.error || "Unknown error");
        renderResults(response.data);
      } catch (err) {
        renderError(err && err.message ? err.message : String(err));
      } finally {
        stopTicker();
        parent.postMessage({ type: "CVE_BUSY", busy: false }, "*");
      }
    }

    // Report data for the HTML report. The CVE evaluation has no user-typed
    // query; the "action" that produced the results is the Evaluate click.
    function getReportData() {
      return {
        toolName: "CVE Security Status",
        queryLabel: "Action",
        queryValue: "Evaluate — cross-reference deployment devices & OS versions against published CVE sources",
        resultsHtml: resultsEl.innerHTML,
      };
    }

    return { doEvaluate, clearResults, hideResults, showResults, toggleResults, notifyState, getReportData };
  })();

  // The host-page CVE control (in content.js) posts these in.
  window.addEventListener("message", (e) => {
    const msg = e.data || {};
    if (msg.type === "CVE_EVALUATE_CLICK") {
      CVE.doEvaluate();
    } else if (msg.type === "CVE_TOGGLE_RESULTS") {
      CVE.toggleResults();
    } else if (msg.type === "CVE_REQUEST_STATE") {
      // content.js (re)mounted the control and wants the current state so
      // its results-toggle button can be shown/hidden correctly.
      CVE.notifyState();
    } else if (msg.type === "PAGE_MOUSEDOWN") {
      // Outside-click: hide the CVE dropdown but keep its content so the
      // toggle button (or next Evaluate) can re-show it.
      const cveDd = document.getElementById("cveDropdown");
      if (cveDd && !cveDd.hidden) CVE.hideResults();
    }
  });

  // When the user clicks the host page, HIDE the LLM dropdown but keep its
  // content so it can be toggled back into view.
  window.addEventListener("message", (e) => {
    const msg = e.data || {};
    if (msg.type === "PAGE_MOUSEDOWN") {
      const llmDd = document.getElementById("llmDropdown");
      if (llmDd && !llmDd.hidden) LLM.hideResults();
    }
  });

  /* ====================================================================
   * Visibility toggles (show/hide each feature) from settings
   * ================================================================== */
  function applyVisibility(showGs, showLlm, showCve) {
    document.body.classList.toggle("hide-gs", !showGs);
    document.body.classList.toggle("hide-llm", !showLlm);
    document.body.classList.toggle("hide-cve", !showCve);
    sendResize();
    // Tell content.js whether the bar should reserve top space at all.
    parent.postMessage({ type: "BAR_VISIBILITY", showGs: !!showGs, showLlm: !!showLlm }, "*");
  }

  async function loadVisibility() {
    try {
      const cfg = await chrome.storage.sync.get({ showGlobalSearch: true, showLlmSession: true, showCveStatus: true });
      applyVisibility(cfg.showGlobalSearch !== false, cfg.showLlmSession !== false, cfg.showCveStatus !== false);
    } catch { applyVisibility(true, true, true); }
  }
  loadVisibility();

  // React to settings changes live (no page reload needed).
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "sync") return;
      if ("showGlobalSearch" in changes || "showLlmSession" in changes || "showCveStatus" in changes) loadVisibility();
    });
  } catch (_) { /* storage.onChanged unavailable */ }
})();
