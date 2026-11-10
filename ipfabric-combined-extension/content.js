// content.js - embeds the search bar at the top of the IP Fabric UI.
//
// v1.2 behavior:
//   - Runs at document_start so the page-push CSS lands before the host
//     page paints (no FOUC where content jumps down after first paint).
//   - Injects a <style> into the host page that pushes <html> content
//     down by BAR_H pixels. This is genuine layout reflow — the page
//     flows below the bar rather than being covered by it.
//   - Mounts a full-width fixed iframe at top:0. The iframe's visible
//     area is the bar itself (BAR_H tall) when idle. When results
//     arrive, the iframe grows downward; only that overflow is
//     "floating" over the page. The page-push amount stays at BAR_H,
//     so the host layout doesn't jump every time the user searches.
//   - Receives FOCUS_INPUT from the background (toolbar / shortcut)
//     and forwards it as a FOCUS message into the iframe.

(() => {
  if (window.__ipfGlobalSearchInstalled) return;
  window.__ipfGlobalSearchInstalled = true;

  // The bar's resting height. Must match overlay.css .bar height.
  const BAR_H = 48;

  /* ---- 1. Page-push CSS, applied as early as possible -------------- */

  function injectHostStyle() {
    if (document.getElementById("ipf-gs-host-style")) return;
    const style = document.createElement("style");
    style.id = "ipf-gs-host-style";
    style.textContent = `
      /* Reserve room at the top of the page for the IP Fabric Global
         Search bar. !important because some IP Fabric pages set their
         own html/body styles. */
      html {
        padding-top: ${BAR_H}px !important;
        box-sizing: border-box !important;
      }
      /* If the host has a fixed-position element pinned at the very
         top, nudge it down by the bar height. Common patterns:
         a top-level <header>, or a div with explicit top: 0. We use
         a conservative selector list to avoid disturbing modals or
         dropdowns. */
      body > header[class],
      body > [class*="header"]:not([class*="sub"]),
      body > [class*="Header"]:not([class*="sub"]),
      body > [class*="navbar"],
      body > [class*="Navbar"] {
        margin-top: 0 !important;
      }
    `;
    // <head> may not exist yet at document_start; documentElement does.
    (document.head || document.documentElement).appendChild(style);
  }

  // Try to inject right now. If documentElement isn't ready, retry.
  if (document.documentElement) {
    injectHostStyle();
  } else {
    const obs = new MutationObserver(() => {
      if (document.documentElement) {
        injectHostStyle();
        obs.disconnect();
      }
    });
    obs.observe(document, { childList: true, subtree: true });
  }

  /* ---- 2. Mount the iframe ---------------------------------------- */

  const iframe = document.createElement("iframe");
  iframe.id = "ipf-global-search-iframe";
  iframe.src = chrome.runtime.getURL("overlay.html");
  iframe.setAttribute("aria-label", "IP Fabric Global Search");
  // `all: initial` defeats any host-page CSS that targets iframes.
  iframe.style.cssText = [
    "all: initial",
    "position: fixed",
    "top: 0",
    "left: 0",
    "width: 100vw",
    `height: ${BAR_H}px`,
    "max-height: calc(100vh)",
    "border: 0",
    "background: transparent",
    "color-scheme: normal",
    "z-index: 2147483647",
    "display: block",
  ].join(";");

  function mountIframe() {
    if (iframe.isConnected) return;
    (document.documentElement || document.body).appendChild(iframe);
  }

  // Once the iframe's overlay.html has loaded, tell it the parent's origin
  // so overlay.js can build deep-link URLs back into the host page, plus
  // the real viewport height so the overlay can size its results panel
  // relative to the actual screen (the iframe's own `vh` is unreliable
  // because the iframe height is itself content-driven).
  function sendHostInfo() {
    if (!iframe.contentWindow) return;
    iframe.contentWindow.postMessage({
      type: "HOST_INFO",
      origin: location.origin,
      viewportHeight: window.innerHeight,
    }, "*");
  }
  iframe.addEventListener("load", sendHostInfo);

  // Resolve the current snapshot UUID (same discovery the table scanner
  // uses) and hand it to the overlay. overlay.js pins the IP Fabric UI
  // deep-links it generates for the LLM Interactive Session and CVE
  // Security Status results to this snapshot via `selectSnapshot`. Purely
  // additive and best-effort: if discovery fails the overlay falls back to
  // the "$last" snapshot shortcut, and nothing else in the extension is
  // affected.
  function sendHostSnapshot() {
    if (!iframe.contentWindow) return;
    Promise.resolve()
      .then(() => discoverSnapshotId(undefined))
      .then((id) => {
        if (!id || !iframe.contentWindow) return;
        iframe.contentWindow.postMessage({
          type: "HOST_SNAPSHOT",
          snapshotId: id,
        }, "*");
      })
      .catch(() => { /* best-effort only */ });
  }
  iframe.addEventListener("load", () => { sendHostSnapshot(); });

  // After the overlay loads (and restores any persisted CVE results), ask
  // it for the current CVE state so the host-page results-toggle button is
  // shown when there are restored results to re-open. Deferred a tick so
  // the overlay's own restore (which also posts CVE_STATE) has run.
  iframe.addEventListener("load", () => { setTimeout(requestCveState, 0); });

  // Keep the overlay's notion of the viewport height current so the
  // results panel stays ~half the screen as the window is resized.
  window.addEventListener("resize", () => {
    sendHostInfo();
  });

  if (document.documentElement) {
    mountIframe();
  } else {
    document.addEventListener("DOMContentLoaded", mountIframe, { once: true });
  }

  /* ---- 2a. CVE Security Status control (host-page overlay) --------- */
  //
  // A "CVE Security Status" text label and an "Evaluate" button, overlaid
  // on the host page's own navy header row (the row just below our 48px
  // bar — where "IP FABRIC <version>" and the CPU/RAM/HDD readouts live),
  // horizontally centered, matching the screenshot. This is a host-page
  // element (NOT inside the iframe) so it can sit visually on that header
  // row. Clicking Evaluate posts a message into the iframe, which runs the
  // CVE evaluation via the background worker and renders the results in
  // its own dropdown — displayed identically to the Global Search and LLM
  // Interactive Session results, and persisted the same way.
  //
  // Visibility is controlled by the showCveStatus setting (Options →
  // Display), mirroring the Global Search / LLM session show-hide behavior.

  const CVE_CTRL_ID = "ipf-cve-status-control";
  let cveControlEl = null;
  let cveStatusVisible = true; // updated from storage below

  function injectCveStyle() {
    if (document.getElementById("ipf-cve-status-style")) return;
    const style = document.createElement("style");
    style.id = "ipf-cve-status-style";
    // Brand-aligned: white label + white-outlined button to read on the
    // host's navy header row, matching the host's own header controls.
    style.textContent = `
      #${CVE_CTRL_ID} {
        all: initial;
        position: fixed;
        top: ${BAR_H}px;
        left: 50%;
        transform: translateX(-50%);
        height: 52px;
        display: flex;
        align-items: center;
        gap: 12px;
        /* Match the overlay iframe's z-index (it is the max 32-bit value).
           The control is mounted AFTER the iframe, so on a z-index tie it
           paints on top and stays clickable even when the CVE results
           dropdown expands the iframe over the header row. The CVE results
           themselves are pushed below this control (see the cve-control
           spacer in overlay.css), so they never sit behind it. */
        z-index: 2147483647;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto,
                     "Helvetica Neue", Arial, sans-serif;
        pointer-events: none;
      }
      #${CVE_CTRL_ID}[hidden] { display: none !important; }
      #${CVE_CTRL_ID} .ipf-cve-label {
        color: #ffffff;
        font-size: 14px;
        font-weight: 600;
        letter-spacing: 0.01em;
        white-space: nowrap;
        pointer-events: none;
        text-shadow: 0 1px 1px rgba(0, 0, 0, 0.18);
      }
      #${CVE_CTRL_ID} .ipf-cve-btn {
        all: unset;
        pointer-events: auto;
        cursor: pointer;
        box-sizing: border-box;
        height: 30px;
        padding: 0 22px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        font-size: 13px;
        font-weight: 600;
        color: #ffffff;
        background: rgba(255, 255, 255, 0.10);
        border: 1px solid rgba(255, 255, 255, 0.55);
        border-radius: 5px;
        transition: background 120ms ease, border-color 120ms ease, opacity 120ms ease;
      }
      #${CVE_CTRL_ID} .ipf-cve-btn:hover {
        background: rgba(255, 255, 255, 0.20);
        border-color: rgba(255, 255, 255, 0.85);
      }
      #${CVE_CTRL_ID} .ipf-cve-btn:active { background: rgba(255, 255, 255, 0.08); }
      #${CVE_CTRL_ID} .ipf-cve-btn:disabled { opacity: 0.6; cursor: progress; }
      #${CVE_CTRL_ID} .ipf-cve-btn:focus-visible {
        outline: 2px solid #ffffff;
        outline-offset: 2px;
      }
      /* Icon buttons (results-toggle + gear), mirroring the bar's
         .bar__icon-btn styling adapted for the host header row. */
      #${CVE_CTRL_ID} .ipf-cve-icon-btn {
        all: unset;
        pointer-events: auto;
        cursor: pointer;
        box-sizing: border-box;
        width: 30px;
        height: 30px;
        flex-shrink: 0;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        border-radius: 5px;
        color: rgba(255, 255, 255, 0.78);
        transition: background 120ms ease, color 120ms ease;
      }
      #${CVE_CTRL_ID} .ipf-cve-icon-btn:hover {
        color: #ffffff;
        background: rgba(255, 255, 255, 0.12);
      }
      #${CVE_CTRL_ID} .ipf-cve-icon-btn:focus-visible {
        outline: 2px solid #ffffff;
        outline-offset: 1px;
      }
      #${CVE_CTRL_ID} .ipf-cve-icon-btn[hidden] { display: none !important; }
      /* "active" highlight while the results panel is visible, identical to
         the bar's .bar__icon-btn.is-active treatment. */
      #${CVE_CTRL_ID} .ipf-cve-icon-btn.is-active {
        color: #ffffff;
        background: rgba(255, 255, 255, 0.20);
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  function buildCveControl() {
    if (cveControlEl) return cveControlEl;
    injectCveStyle();
    const wrap = document.createElement("div");
    wrap.id = CVE_CTRL_ID;
    wrap.setAttribute("role", "group");
    wrap.setAttribute("aria-label", "CVE Security Status");

    const label = document.createElement("span");
    label.className = "ipf-cve-label";
    label.textContent = "CVE Security Status";

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "ipf-cve-btn";
    btn.id = "ipf-cve-evaluate-btn";
    btn.textContent = "Evaluate";
    btn.addEventListener("click", (e) => {
      // Don't let the click bubble to the document mousedown handler that
      // dismisses the iframe dropdowns.
      e.stopPropagation();
      if (iframe.contentWindow) {
        iframe.contentWindow.postMessage({ type: "CVE_EVALUATE_CLICK" }, "*");
      }
    });

    // Results-toggle button — show/hide the persisted CVE results panel,
    // identical in behavior to the Global Search / LLM toggle buttons in
    // the bar. Hidden until there are results to re-show; gains an active
    // highlight while the panel is visible. State is driven by CVE_STATE
    // messages the iframe posts back to us.
    const toggleBtn = document.createElement("button");
    toggleBtn.type = "button";
    toggleBtn.className = "ipf-cve-icon-btn";
    toggleBtn.id = "ipf-cve-toggle-btn";
    toggleBtn.title = "Show/hide results";
    toggleBtn.setAttribute("aria-label", "Show or hide results");
    toggleBtn.hidden = true;
    toggleBtn.innerHTML =
      '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
      'stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<line x1="8" y1="6" x2="21" y2="6"></line>' +
      '<line x1="8" y1="12" x2="21" y2="12"></line>' +
      '<line x1="8" y1="18" x2="21" y2="18"></line>' +
      '<line x1="3" y1="6" x2="3.01" y2="6"></line>' +
      '<line x1="3" y1="12" x2="3.01" y2="12"></line>' +
      '<line x1="3" y1="18" x2="3.01" y2="18"></line>' +
      '</svg>';
    toggleBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (iframe.contentWindow) {
        iframe.contentWindow.postMessage({ type: "CVE_TOGGLE_RESULTS" }, "*");
      }
    });

    // Gear / Options button — opens the extension Options page, identical
    // to the gear shortcuts in the Global Search and LLM groups.
    const gearBtn = document.createElement("button");
    gearBtn.type = "button";
    gearBtn.className = "ipf-cve-icon-btn";
    gearBtn.id = "ipf-cve-options-btn";
    gearBtn.title = "Options";
    gearBtn.setAttribute("aria-label", "Open options");
    gearBtn.innerHTML =
      '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
      'stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<circle cx="12" cy="12" r="3"></circle>' +
      '<path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3h.1a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8v.1a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z"></path>' +
      '</svg>';
    gearBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      try {
        chrome.runtime.sendMessage({ type: "OPEN_OPTIONS" }).catch(() => {});
      } catch (_) { /* extension context invalidated */ }
    });

    // Prevent the capture-phase document mousedown (which posts
    // PAGE_MOUSEDOWN to hide dropdowns) from firing for clicks on the
    // control itself.
    wrap.addEventListener("mousedown", (e) => e.stopPropagation(), true);

    wrap.appendChild(label);
    wrap.appendChild(btn);
    wrap.appendChild(toggleBtn);
    wrap.appendChild(gearBtn);
    cveControlEl = wrap;
    return wrap;
  }

  function mountCveControl() {
    const el = buildCveControl();
    if (!el.isConnected) {
      (document.documentElement || document.body).appendChild(el);
    }
    el.hidden = !cveStatusVisible;
    // Ask the iframe for the current CVE results state so the toggle button
    // reflects any results restored after a deep-link navigation. Best
    // effort: if the iframe isn't ready yet, the iframe also proactively
    // posts CVE_STATE after it restores persisted results.
    requestCveState();
  }

  function requestCveState() {
    try {
      if (iframe.contentWindow) {
        iframe.contentWindow.postMessage({ type: "CVE_REQUEST_STATE" }, "*");
      }
    } catch (_) { /* iframe not ready */ }
  }

  function applyCveVisibility(show) {
    cveStatusVisible = !!show;
    if (cveStatusVisible) {
      mountCveControl();
    } else if (cveControlEl) {
      cveControlEl.hidden = true;
    }
  }

  // Initial visibility from storage (default: shown), then mount.
  try {
    chrome.storage.sync.get({ showCveStatus: true }).then((cfg) => {
      applyCveVisibility(cfg.showCveStatus !== false);
    }, () => { applyCveVisibility(true); });
  } catch (_) { applyCveVisibility(true); }

  // React to Options changes live (no reload needed), mirroring the
  // overlay's own visibility listener.
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "sync") return;
      if ("showCveStatus" in changes) {
        applyCveVisibility(changes.showCveStatus.newValue !== false);
      }
    });
  } catch (_) { /* storage.onChanged unavailable */ }

  // Let the iframe disable/enable the Evaluate button while an evaluation
  // is in flight (so the user can't double-trigger), and re-enable it when
  // done. The iframe posts CVE_BUSY { busy } back to us. The iframe also
  // posts CVE_STATE { hasResults, visible } whenever the CVE results panel
  // state changes, so the results-toggle button can mirror the bar's
  // toggle behavior (shown only when there are results to re-show, and
  // highlighted while the panel is visible).
  window.addEventListener("message", (e) => {
    if (!iframe.contentWindow || e.source !== iframe.contentWindow) return;
    const msg = e.data || {};
    if (msg.type === "CVE_BUSY") {
      const btn = cveControlEl && cveControlEl.querySelector("#ipf-cve-evaluate-btn");
      if (btn) btn.disabled = !!msg.busy;
    } else if (msg.type === "CVE_STATE") {
      const tog = cveControlEl && cveControlEl.querySelector("#ipf-cve-toggle-btn");
      if (tog) {
        tog.hidden = !msg.hasResults;
        tog.classList.toggle("is-active", !!msg.hasResults && !!msg.visible);
        tog.title = msg.visible ? "Hide results" : "Show results";
      }
    }
  });

  /* ---- 2b. Shift fixed-position elements down by BAR_H ------------ */
  //
  // `html { padding-top: 48px }` only reflows static/relative content.
  // IP Fabric's app uses `position: fixed; top: 0` for its top navigation
  // bar (the "IP FABRIC 7.11.5" row), which is positioned relative to the
  // viewport and therefore ignores our padding. Without this shifter,
  // our bar and theirs would stack on the same pixels at top: 0.
  //
  // Strategy: walk the DOM, find elements whose computed style is
  // position: fixed or sticky with top ≈ 0, and add an inline
  // `top: 48px !important` so they sit *below* our bar. We tag each
  // shifted element so we don't reshift it on later passes, and we use
  // a debounced MutationObserver to catch elements created later by the
  // SPA (modals, dropdowns, etc. won't usually be at top:0 so they're
  // naturally filtered out).

  const SHIFT_ATTR = "data-ipf-gs-shifted";

  // A `position: sticky` element pins to the top of its *nearest
  // scrolling ancestor*, not the viewport. So a sticky table-header
  // inside an overflow:auto div should NOT be shifted by our bar — if
  // we shifted it, it would cover the first rows of data when the
  // user opens that table. (This was the visible bug: the first
  // device-inventory rows appeared cut off at the top.)
  //
  // Walk up the ancestor chain; if any ancestor scrolls, the element
  // is sticky-within-container, not sticky-within-viewport.
  function isInsideScrollContainer(el) {
    let p = el.parentElement;
    while (p && p !== document.body && p !== document.documentElement) {
      const cs = window.getComputedStyle(p);
      const oy = cs.overflowY, ox = cs.overflowX, oa = cs.overflow;
      if (oy === "auto" || oy === "scroll" ||
          ox === "auto" || ox === "scroll" ||
          oa === "auto" || oa === "scroll") {
        return true;
      }
      p = p.parentElement;
    }
    return false;
  }

  function maybeShift(el) {
    if (!el || el.nodeType !== 1) return;          // ELEMENT_NODE only
    if (el.id === "ipf-global-search-iframe") return;
    if (el.hasAttribute(SHIFT_ATTR)) return;
    const cs = window.getComputedStyle(el);
    if (cs.position !== "fixed" && cs.position !== "sticky") return;
    // `top` can be 'auto', 'Npx', '0px'. We want elements pinned to
    // the very top of the viewport — accept small floating-point noise.
    const top = parseFloat(cs.top);
    if (isNaN(top) || top < -2 || top > 2) return;
    // Skip elements that aren't actually visible at the top (e.g.
    // tooltip wrappers with zero height/width).
    if (el.offsetHeight === 0 && el.offsetWidth === 0) return;
    // Critical: a sticky element inside a scroll container pins to
    // *that container*, not the viewport. Shifting it would cover
    // content. Only shift sticky elements when their containing
    // scroll context IS the viewport. Fixed elements are always
    // viewport-relative and are always safe to shift.
    if (cs.position === "sticky" && isInsideScrollContainer(el)) return;
    el.style.setProperty("top", BAR_H + "px", "important");
    el.setAttribute(SHIFT_ATTR, "1");
  }

  function scanAll() {
    if (!document.body) return;
    // querySelectorAll('*') is broad but cheap on first paint. We only
    // do real work for elements that pass the maybeShift filter.
    document.querySelectorAll("body *").forEach(maybeShift);
  }

  function setupShifting() {
    scanAll();

    // Catch elements rendered after the initial paint (SPA navigation,
    // re-mounts, lazy-loaded chrome). Debounce so SPAs with chatty
    // re-renders don't tank performance.
    let scheduled = false;
    const mo = new MutationObserver((muts) => {
      // Only rescan if NEW elements were added; pure attribute or text
      // changes can't introduce a new fixed-top element.
      let hasAdditions = false;
      for (const m of muts) {
        if (m.addedNodes && m.addedNodes.length) { hasAdditions = true; break; }
      }
      if (!hasAdditions || scheduled) return;
      scheduled = true;
      setTimeout(() => {
        scheduled = false;
        scanAll();
      }, 150);
    });
    mo.observe(document.body, { childList: true, subtree: true });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", setupShifting, { once: true });
  } else {
    setupShifting();
  }

  /* ---- 3. Messages from the iframe -------------------------------- */

  window.addEventListener("message", (e) => {
    if (!iframe.contentWindow || e.source !== iframe.contentWindow) return;
    const msg = e.data || {};
    if (msg.type === "RESIZE") {
      // Cap to viewport. Note: we do NOT change the page-push amount
      // when results expand the iframe; results visually overlay the
      // host content as a dropdown, so the host doesn't reflow.
      const cap = window.innerHeight;
      const h = Math.max(BAR_H, Math.min(cap, Math.ceil(msg.height || BAR_H)));
      iframe.style.height = h + "px";
    } else if (msg.type === "BAR_VISIBILITY") {
      // The overlay tells us whether either feature is shown. Even when
      // BOTH are hidden we keep the bar present (page-push + iframe) so a
      // small "restore" options gear remains reachable in the overlay —
      // otherwise the user would have no way back into Options to re-enable
      // a feature. The overlay's CSS collapses the bar to just that gear.
      setBarPresent(true);
    } else if (msg.type === "DISMISS_RESULTS_FROM_OUTSIDE_CLICK") {
      // (Not used right now, reserved.)
    } else if (msg.type === "START_TABLE_SCAN") {
      // Iframe asked us to scan the IP Fabric tables. We run the scan
      // here in the host page context so the user's session cookie
      // attaches automatically to fetch() calls.
      startTableScan(msg.query, msg.uiPaths, msg.scanId);
    } else if (msg.type === "CANCEL_TABLE_SCAN") {
      cancelActiveScan(msg.scanId);
    } else if (msg.type === "OPEN_HTML_REPORT") {
      // The overlay built a standalone HTML report and wants it either
      // opened in a new browser tab or saved as a file. We do this here in
      // the host-page context, where Blob URLs, window.open, and anchor
      // downloads work reliably (the extension iframe is more restricted).
      handleHtmlReport(msg.mode, msg.html, msg.filename);
    }
  });

  // Build a report and either open it in a new tab or download it. Runs in
  // the host-page content-script context where these APIs work reliably.
  function handleHtmlReport(mode, html, filename) {
    if (!html) return;
    let url = null;
    try {
      const blob = new Blob([html], { type: "text/html;charset=utf-8" });
      url = URL.createObjectURL(blob);
      if (mode === "save") {
        const a = document.createElement("a");
        a.href = url;
        a.download = filename || "ipfabric-report.html";
        a.style.display = "none";
        document.body.appendChild(a);
        a.click();
        a.remove();
        // Revoke a little later so the download has time to start.
        setTimeout(() => { try { URL.revokeObjectURL(url); } catch (_) {} }, 60000);
      } else {
        // Open in a new browser tab. If the popup is blocked, fall back to a
        // download so the user still gets the report.
        const win = window.open(url, "_blank", "noopener");
        if (!win) {
          const a = document.createElement("a");
          a.href = url;
          a.download = filename || "ipfabric-report.html";
          a.style.display = "none";
          document.body.appendChild(a);
          a.click();
          a.remove();
        }
        // Revoke later; revoking immediately can break the just-opened tab.
        setTimeout(() => { try { URL.revokeObjectURL(url); } catch (_) {} }, 60000);
      }
    } catch (err) {
      if (url) { try { URL.revokeObjectURL(url); } catch (_) {} }
      // Non-fatal: report generation is a convenience feature.
      console.warn("[IPF] HTML report failed:", err);
    }
  }

  // Toggle whether the bar reserves space + is visible. When neither
  // feature is enabled, the extension should not alter the host page.
  function setBarPresent(present) {
    const style = document.getElementById("ipf-gs-host-style");
    if (present) {
      injectHostStyle();
      iframe.style.display = "block";
    } else {
      if (style) style.remove();
      iframe.style.display = "none";
    }
  }

  /* =====================================================================
   * Table scanner — "cycle every table" search mode.
   *
   * This runs entirely in the host-page context (content script) so the
   * fetch() calls inherit the user's IP Fabric session cookie. We POST
   * to the API path corresponding to each UI table, then look for the
   * search term in any cell of any returned row.
   *
   * The API URL pattern we use is:
   *   /api/v1/tables/<rest-of-UI-path>
   * with the first segment ("technology" / "inventory") replaced by
   * "tables". This is a guess — IP Fabric may have moved to a different
   * API version, or some tables may not back onto /tables/ at all.
   * When a path fails we just report it as scanned-with-no-match;
   * the user will see those as "skipped" in the progress display.
   *
   * Progress is streamed back to the iframe via postMessage with
   * { type: "TABLE_SCAN_PROGRESS", scanId, ... }.
   *
   * The scan is cancellable: when the user issues a new search, the
   * iframe sends CANCEL_TABLE_SCAN with the old scanId and we abort.
   * =================================================================== */

  const activeScans = new Map();   // scanId → AbortController
  const CONCURRENCY = 6;           // browser limit per origin
  // Per-request timeout for a single table fetch. Without this, a request
  // that the server accepts but never answers (some large/slow cloud and
  // SD-WAN tables on certain deployments can do this) would leave a worker
  // blocked forever, stalling the whole scan just short of 100%. When a
  // request exceeds this budget we abort just that request and move on —
  // the table is reported as scanned-with-no-match, exactly like a 404.
  const TABLE_FETCH_TIMEOUT_MS = 20_000;

  function cancelActiveScan(scanId) {
    const ac = activeScans.get(scanId);
    if (ac) { ac.abort(); activeScans.delete(scanId); }
  }

  function postScanMsg(scanId, payload) {
    if (!iframe.contentWindow) return;
    iframe.contentWindow.postMessage(
      Object.assign({ type: "TABLE_SCAN_PROGRESS", scanId }, payload),
      "*"
    );
  }

  // Map a UI path to a probable IP Fabric API path.
  //
  // Verified mappings (from DevTools network capture + MCP endpoint search):
  //   UI:  /inventory/devices                  → API: /api/tables/inventory/devices    (200)
  //   UI:  /inventory/devices/models           → API: /api/tables/inventory/devices    (parent fallback;
  //                                                                                     /devices/models itself 404s)
  //   UI:  /technology/mpls/l3vpn/pe-routers   → API: /api/tables/mpls/l3-vpn/pe-routers
  //
  // Pattern:
  //   - "/inventory/..." is preserved as-is (API mirrors the UI segment)
  //   - "/technology/..." has the "technology" segment STRIPPED in the API
  //   - Some segments are hyphenated in the API but not in the UI
  //     (e.g. "l3vpn" → "l3-vpn"). We try the as-is variant first,
  //     then the hyphenated one.
  //   - Some UI URLs (e.g. /inventory/devices/models) are *views* of a
  //     parent table that doesn't itself live at that path. When the
  //     primary candidates 404, we fall back to the parent path —
  //     dropping the last segment up to two times.
  function uiPathToApi(uiPath) {
    const parts = uiPath.split("/").filter(Boolean);
    if (!parts.length) return [];
    const head = parts[0];
    const tail = parts.slice(1);

    // Explicit overrides for UI→API paths the generic rules can't derive.
    // These are tried FIRST (highest confidence), then the generic
    // candidates are appended as fallbacks. Documented IP Fabric VLAN
    // endpoints: the UI section "/technology/vlans/..." maps to the API
    // "/api/tables/vlan/..." (singular), and the "device-detail" view in
    // particular lives at ".../vlan/device" (NOT ".../vlan/device-detail").
    const API_PATH_OVERRIDES = {
      "/technology/vlans/network-summary": ["/api/tables/vlan/network-summary"],
      "/technology/vlans/site-summary":    ["/api/tables/vlan/site-summary"],
      "/technology/vlans/l3-gateways":     ["/api/tables/vlan/l3-gateways"],
      "/technology/vlans/device-detail":   ["/api/tables/vlan/device"],
      "/technology/vlans/device-summary":  ["/api/tables/vlan/device-summary"],
      // The IPv4/IPv6 routing tables live under "networks", not "routing":
      //   UI /technology/routing/routes      → API /api/tables/networks/routes
      //   UI /technology/routing/routes/ipv6 → API /api/tables/networks/routesV6
      "/technology/routing/routes":        ["/api/tables/networks/routes"],
      "/technology/routing/routes/ipv6":   ["/api/tables/networks/ipv6-routes", "/api/tables/networks/routesV6", "/api/tables/networks/routes/ipv6"],
      // The Inventory → Hosts tables live under "addressing", NOT
      // "inventory": the UI path "/inventory/hosts" maps to the API
      //   /api/tables/addressing/hosts        (IPv4)
      //   /api/tables/addressing/hosts-ipv6   (IPv6)
      // Without this override the generic rules only produce
      // /api/tables/inventory/hosts (and near variants), all of which 404 —
      // so the Hosts table was never fetched and values like a Host IP
      // address (e.g. 172.16.61.60) could never be matched. Multiple IPv6
      // spellings are listed so the scan tries each and uses whichever the
      // running IP Fabric version accepts (first 200 wins).
      "/inventory/hosts":                  ["/api/tables/addressing/hosts"],
      "/inventory/hosts/ipv6":             ["/api/tables/addressing/ipv6-hosts", "/api/tables/addressing/hosts-ipv6", "/api/tables/addressing/hostsV6", "/api/tables/addressing/hosts/ipv6"],
      // Load-balancing virtual-server sub-tables. The API path mirrors the
      // UI "reports" value's tail — e.g. the Pool members table's request
      // uses reports "/technology/load-balancing/virtual-servers-pool-members"
      // and is served from /api/tables/load-balancing/virtual-servers-pool-members.
      // The generic resolver already produces that flattened form, but we
      // pin it here (and add the nested-slash spelling as a fallback) so the
      // correct endpoint is always tried first and the table is reliably
      // fetched — without which values such as a Pool name (e.g.
      // "tg-tcp-80-private", which lives in the poolName column) can't match.
      "/technology/load-balancing/virtual-servers-pools":       ["/api/tables/load-balancing/virtual-servers-pools", "/api/tables/load-balancing/virtual-servers/pools"],
      "/technology/load-balancing/virtual-servers-pool-members":["/api/tables/load-balancing/virtual-servers-pool-members", "/api/tables/load-balancing/virtual-servers/pool-members"],
      "/technology/load-balancing/virtual-servers-path-rules":  ["/api/tables/load-balancing/virtual-servers-path-rules", "/api/tables/load-balancing/virtual-servers/path-rules"],
      "/technology/load-balancing/virtual-servers-certs":       ["/api/tables/load-balancing/virtual-servers-certs", "/api/tables/load-balancing/virtual-servers-certificates", "/api/tables/load-balancing/virtual-servers/certificates"],
      // --- v5.1.0: reconciled from IP Fabric webPages.yaml (authoritative table catalog) ---
      "/inventory/devices/families-2": ["/api/tables/inventory/summary/families"],
      "/inventory/devices/models-2": ["/api/tables/inventory/summary/models"],
      "/inventory/devices/platforms-2": ["/api/tables/inventory/summary/platforms"],
      "/inventory/devices/vendors-2": ["/api/tables/inventory/summary/vendors"],
      "/inventory/end-of-life-milestones": ["/api/tables/reports/eof/summary"],
      "/inventory/end-of-life-milestones/detail": ["/api/tables/reports/eof/detail"],
      "/inventory/end-of-life-milestones/summary": ["/api/tables/reports/eof/summary"],
      "/inventory/hosts/virtual-machines": ["/api/tables/inventory/virtual-machines/inventory"],
      "/inventory/hosts/virtual-machines-interfaces": ["/api/tables/inventory/virtual-machines/virtual-machines-interfaces"],
      "/inventory/os-versions": ["/api/tables/inventory/os-version-consistency/platforms"],
      "/inventory/os-versions/models": ["/api/tables/inventory/os-version-consistency/models"],
      "/inventory/os-versions/platforms": ["/api/tables/inventory/os-version-consistency/platforms"],
      "/inventory/part-numbers-2": ["/api/tables/inventory/pn"],
      "/management/discovery-history": ["/api/tables/inventory/discovery-history"],
      "/settings/administration/license-consumption": ["/api/tables/settings/administration/license-consumption/overview"],
      "/settings/administration/license-consumption/cloud-constructs": ["/api/tables/settings/administration/license-consumption/cloud-constructs"],
      "/settings/administration/license-consumption/on-prem-devices": ["/api/tables/settings/administration/license-consumption/on-prem-devices"],
      "/settings/administration/license-consumption/overview": ["/api/tables/settings/administration/license-consumption/overview"],
      "/technology/addressing/arp-table-2": ["/api/tables/addressing/arp"],
      "/technology/addressing/ipv6-neighbor-discovery": ["/api/tables/addressing/ipv6-neighbors"],
      "/technology/addressing/mac-table-2": ["/api/tables/addressing/mac"],
      "/technology/addressing/managed-duplicate-ip": ["/api/tables/addressing/duplicate-ip"],
      "/technology/addressing/managed-ip": ["/api/tables/addressing/managed-devs"],
      "/technology/addressing/managed-ip/ipv4-managed-ip": ["/api/tables/addressing/managed-devs"],
      "/technology/addressing/managed-ip/ipv4-managed-ip-summary": ["/api/tables/addressing/ipv4-managed-ip-summary"],
      "/technology/addressing/managed-ip/ipv6-managed-ip": ["/api/tables/addressing/ipv6-managed-devs"],
      "/technology/addressing/managed-ip/ipv6-managed-ip-summary": ["/api/tables/addressing/ipv6-managed-ip-summary"],
      "/technology/addressing/nat-2": ["/api/tables/security/nat44"],
      "/technology/cdp-lldp/all-neighbors-2": ["/api/tables/neighbors/all"],
      "/technology/cdp-lldp/endpoints-neighbors": ["/api/tables/neighbors/endpoints"],
      "/technology/cdp-lldp/unidirectional-neighbors-2": ["/api/tables/neighbors/unidirectional"],
      "/technology/cdp-lldp/unmanaged-neighbors-2": ["/api/tables/neighbors/unmanaged"],
      "/technology/cloud": ["/api/tables/cloud/network-interfaces"],
      "/technology/cloud/endpoints": ["/api/tables/cloud/endpoints/virtual-machines"],
      "/technology/cloud/nat-gateways": ["/api/tables/cloud/nat-gateways/inventory"],
      "/technology/cloud/nat-gateways/inventory": ["/api/tables/cloud/nat-gateways/inventory"],
      "/technology/cloud/nat-gateways/rules": ["/api/tables/cloud/nat-gateways/rules"],
      "/technology/cloud/networks": ["/api/tables/cloud/networks/inventory"],
      "/technology/cloud/nodes": ["/api/tables/cloud/nodes/inventory"],
      "/technology/cloud/private-link": ["/api/tables/cloud/private-link/endpoints"],
      "/technology/cloud/private-link/services": ["/api/tables/cloud/private-link/services/inventory"],
      "/technology/cloud/public-ips/ip-addresses": ["/api/tables/cloud/public-ips/ipv4-addresses"],
      "/technology/cloud/public-ips/ip-addresses/ipv4": ["/api/tables/cloud/public-ips/ipv4-addresses"],
      "/technology/cloud/public-ips/ip-addresses/ipv6": ["/api/tables/cloud/public-ips/ipv6-addresses"],
      "/technology/cloud/route-tables": ["/api/tables/cloud/route-tables/inventory"],
      "/technology/cloud/security": ["/api/tables/cloud/security/inventory"],
      "/technology/cloud/security-addresses": ["/api/tables/cloud/security-addresses/inventory"],
      "/technology/cloud/security/inventory": ["/api/tables/cloud/security/inventory"],
      "/technology/cloud/subnets": ["/api/tables/cloud/subnets/inventory"],
      "/technology/cloud/vendors/aws": ["/api/tables/cloud/vendors/aws/inventory"],
      "/technology/cloud/vendors/aws/internet-gateways": ["/api/tables/cloud/vendors/aws/internet-gateways"],
      "/technology/cloud/vendors/aws/private-link": ["/api/tables/cloud/vendors/aws/private-link/vpc-endpoints"],
      "/technology/cloud/vendors/azure": ["/api/tables/cloud/vendors/azure/inventory"],
      "/technology/cloud/vendors/azure/dns": ["/api/tables/cloud/vendors/azure/dns/vnet"],
      "/technology/cloud/vendors/azure/private-link": ["/api/tables/cloud/vendors/azure/private-link/endpoints"],
      "/technology/cloud/vendors/azure/vnet-integration": ["/api/tables/cloud/vendors/azure/vnet-integration/app-services"],
      "/technology/cloud/vendors/gcp": ["/api/tables/cloud/vendors/gcp/inventory"],
      "/technology/cloud/vendors/gcp/private-service-connect": ["/api/tables/cloud/vendors/gcp/private-service-connect/endpoints"],
      "/technology/cloud/vendors/gcp/serverless-services": ["/api/tables/cloud/vendors/gcp/serverless-services/app-engine"],
      "/technology/dhcp/relay": ["/api/tables/dhcp/relay/interfaces"],
      "/technology/dhcp/relay/global-stats": ["/api/tables/dhcp/relay/global-stats/summary"],
      "/technology/dhcp/relay/interfaces-stats": ["/api/tables/dhcp/relay/interfaces-stats/received"],
      "/technology/dhcp/server": ["/api/tables/dhcp/server/summary"],
      "/technology/fhrp/active-gateway-balancing": ["/api/tables/fhrp/balancing"],
      "/technology/fhrp/active-gateway-root-alignment": ["/api/tables/fhrp/stproot-alignment"],
      "/technology/fhrp/virtual-gateways": ["/api/tables/fhrp/virtual-gateways"],
      "/technology/interfaces/connectivity-matrix/unmanaged-neighbors-detail": ["/api/tables/interfaces/connectivity-matrix/unmanaged-neighbors/detail"],
      "/technology/interfaces/connectivity-matrix/unmanaged-neighbors-summary": ["/api/tables/interfaces/connectivity-matrix/unmanaged-neighbors/summary"],
      "/technology/interfaces/counters": ["/api/tables/interfaces/counters/inbound"],
      "/technology/interfaces/errdisabled": ["/api/tables/interfaces/errors/disabled"],
      "/technology/interfaces/rate": ["/api/tables/interfaces/load/inbound"],
      "/technology/interfaces/rate/bidirectional": ["/api/tables/interfaces/load/bidirectional"],
      "/technology/interfaces/rate/inbound": ["/api/tables/interfaces/load/inbound"],
      "/technology/interfaces/rate/outbound": ["/api/tables/interfaces/load/outbound"],
      "/technology/interfaces/storm-control": ["/api/tables/interfaces/storm-control/broadcast"],
      "/technology/interfaces/switchport-2": ["/api/tables/interfaces/switchports"],
      "/technology/interfaces/transceivers": ["/api/tables/interfaces/transceivers/inventory"],
      "/technology/interfaces/tunnels": ["/api/tables/interfaces/tunnels/ipv4"],
      "/technology/ip-telephony/phones": ["/api/tables/inventory/phones"],
      "/technology/load-balancing": ["/api/tables/load-balancing/virtual-servers"],
      "/technology/management/aaa": ["/api/tables/security/aaa/servers"],
      "/technology/management/aaa/accounting": ["/api/tables/security/aaa/accounting"],
      "/technology/management/aaa/authentication": ["/api/tables/security/aaa/authentication"],
      "/technology/management/aaa/authorization": ["/api/tables/security/aaa/authorization"],
      "/technology/management/aaa/lines": ["/api/tables/security/aaa/lines"],
      "/technology/management/aaa/local-users": ["/api/tables/security/aaa/users"],
      "/technology/management/aaa/password-strength": ["/api/tables/security/aaa/password-strength"],
      "/technology/management/aaa/servers": ["/api/tables/security/aaa/servers"],
      "/technology/management/banners": ["/api/tables/management/banners/summary"],
      "/technology/management/dns": ["/api/tables/management/dns/settings"],
      "/technology/management/flow": ["/api/tables/management/flow/overview"],
      "/technology/management/flow/netflow-collectors": ["/api/tables/management/flow/netflow/collectors"],
      "/technology/management/flow/netflow-devices": ["/api/tables/management/flow/netflow/devices"],
      "/technology/management/flow/netflow-interfaces": ["/api/tables/management/flow/netflow/interfaces"],
      "/technology/management/flow/sflow-collectors": ["/api/tables/management/flow/sflow/collectors"],
      "/technology/management/flow/sflow-data-sources": ["/api/tables/management/flow/sflow/sources"],
      "/technology/management/flow/sflow-devices": ["/api/tables/management/flow/sflow/devices"],
      "/technology/management/licenses/cisco-smart-license": ["/api/tables/management/licenses/cisco-smart-licenses/authorization"],
      "/technology/management/licenses/cisco-smart-license/registration-2": ["/api/tables/management/licenses/cisco-smart-licenses/registration"],
      "/technology/management/licenses/cisco-smart-license/reservations-2": ["/api/tables/management/licenses/cisco-smart-licenses/reservations"],
      "/technology/management/licenses/license": ["/api/tables/management/licenses/summary"],
      "/technology/management/licenses/license/license-detail": ["/api/tables/management/licenses/detail"],
      "/technology/management/logging": ["/api/tables/management/logging/summary"],
      "/technology/management/ntp": ["/api/tables/management/ntp/summary"],
      "/technology/management/ptp": ["/api/tables/management/ptp/local-clock"],
      "/technology/management/snmp": ["/api/tables/management/snmp/summary"],
      "/technology/management/telnet-access-2": ["/api/tables/security/enabled-telnet"],
      "/technology/mpls/l2vpn": ["/api/tables/mpls/l2-vpn/point-to-point-vpws"],
      "/technology/mpls/l3vpn": ["/api/tables/mpls/l3-vpn/pe-routers"],
      "/technology/mpls/ldp": ["/api/tables/mpls/ldp/neighbors"],
      "/technology/mpls/rsvp": ["/api/tables/mpls/rsvp/neighbors"],
      "/technology/multicast/igmp": ["/api/tables/multicast/igmp/groups"],
      "/technology/multicast/igmp/snooping": ["/api/tables/multicast/igmp/snooping/global"],
      "/technology/multicast/mac": ["/api/tables/multicast/mac"],
      "/technology/multicast/mroute": ["/api/tables/multicast/routes/overview"],
      "/technology/multicast/mroute/first-hop-router": ["/api/tables/multicast/routes/first-hop-router"],
      "/technology/multicast/mroute/mroute-counters": ["/api/tables/multicast/routes/counters"],
      "/technology/multicast/mroute/mroute-table": ["/api/tables/multicast/routes/table"],
      "/technology/multicast/mroute/oil-detail": ["/api/tables/multicast/routes/outgoing-interfaces"],
      "/technology/multicast/mroute/overview": ["/api/tables/multicast/routes/overview"],
      "/technology/multicast/mroute/sources": ["/api/tables/multicast/routes/sources"],
      "/technology/multicast/pim": ["/api/tables/multicast/pim/neighbors"],
      "/technology/multicast/rp": ["/api/tables/multicast/pim/rp/overview"],
      "/technology/multicast/rp/bsr": ["/api/tables/multicast/pim/rp/bsr"],
      "/technology/multicast/rp/rp-mappings": ["/api/tables/multicast/pim/rp/mappings"],
      "/technology/multicast/rp/rp-mappings-groups": ["/api/tables/multicast/pim/rp/mappings-groups"],
      "/technology/multicast/rp/rp-overview": ["/api/tables/multicast/pim/rp/overview"],
      "/technology/oam/udld": ["/api/tables/management/oam/unidirectional-link-detection/neighbors"],
      "/technology/oam/udld/interfaces": ["/api/tables/management/oam/unidirectional-link-detection/interfaces"],
      "/technology/oam/udld/neighbors": ["/api/tables/management/oam/unidirectional-link-detection/neighbors"],
      "/technology/platforms/cisco-fabric-path": ["/api/tables/platforms/fabric-path/summary"],
      "/technology/platforms/cisco-fabric-path/is-is-neighbors": ["/api/tables/platforms/fabric-path/neighbors"],
      "/technology/platforms/cisco-fabric-path/routes": ["/api/tables/platforms/fabric-path/routes"],
      "/technology/platforms/cisco-fabric-path/summary": ["/api/tables/platforms/fabric-path/summary"],
      "/technology/platforms/cisco-fabric-path/switch-ids": ["/api/tables/platforms/fabric-path/switches"],
      "/technology/platforms/cluster": ["/api/tables/platforms/cluster/srx"],
      "/technology/platforms/environment": ["/api/tables/inventory/power-supplies"],
      "/technology/platforms/environment/fans": ["/api/tables/inventory/fans"],
      "/technology/platforms/environment/modules": ["/api/tables/inventory/modules"],
      "/technology/platforms/environment/power-supplies": ["/api/tables/inventory/power-supplies"],
      "/technology/platforms/environment/power-supplies-fans": ["/api/tables/inventory/power-supplies-fans"],
      "/technology/platforms/environment/temperature-sensors": ["/api/tables/inventory/temperature-sensors"],
      "/technology/platforms/fex": ["/api/tables/platforms/fex/modules"],
      "/technology/platforms/logical-devices": ["/api/tables/platforms/devices"],
      "/technology/platforms/poe": ["/api/tables/platforms/poe/devices"],
      "/technology/platforms/vss": ["/api/tables/platforms/vss/overview"],
      "/technology/port-channels/inbound-balancing-table": ["/api/tables/interfaces/port-channel/balance/inbound"],
      "/technology/port-channels/member-status-table": ["/api/tables/interfaces/port-channel/member-status"],
      "/technology/port-channels/mlag": ["/api/tables/platforms/mlag/switches"],
      "/technology/port-channels/mlag/cisco-vpc": ["/api/tables/platforms/mlag/vpc"],
      "/technology/port-channels/mlag/pairs": ["/api/tables/platforms/mlag/pairs"],
      "/technology/port-channels/mlag/peer-links": ["/api/tables/platforms/mlag/peers"],
      "/technology/port-channels/mlag/switches": ["/api/tables/platforms/mlag/switches"],
      "/technology/port-channels/outbound-balancing-table": ["/api/tables/interfaces/port-channel/balance/outbound"],
      "/technology/qos": ["/api/tables/qos/policy-maps"],
      "/technology/routing": ["/api/tables/networks/policies/routing"],
      "/technology/routing/bgp": ["/api/tables/routing/protocols/bgp/neighbors"],
      "/technology/routing/bgp/address-families": ["/api/tables/routing/protocols/bgp/address-families"],
      "/technology/routing/bgp/advertised-routes": ["/api/tables/routing/protocols/bgp/routes"],
      "/technology/routing/bgp/advertised-routes-ipv6": ["/api/tables/routing/protocols/bgp/routesIpv6"],
      "/technology/routing/bgp/neighbors": ["/api/tables/routing/protocols/bgp/neighbors"],
      "/technology/routing/eigrp": ["/api/tables/routing/protocols/eigrp/neighbors"],
      "/technology/routing/eigrp/interfaces": ["/api/tables/routing/protocols/eigrp/interfaces"],
      "/technology/routing/eigrp/neighbors": ["/api/tables/routing/protocols/eigrp/neighbors"],
      "/technology/routing/is-is": ["/api/tables/routing/protocols/is-is/neighbors"],
      "/technology/routing/is-is/interfaces": ["/api/tables/routing/protocols/is-is/interfaces"],
      "/technology/routing/is-is/levels": ["/api/tables/routing/protocols/is-is/levels"],
      "/technology/routing/is-is/neighbors": ["/api/tables/routing/protocols/is-is/neighbors"],
      "/technology/routing/lisp/map-resolvers": ["/api/tables/routing/protocols/lisp/ipv4-databases"],
      "/technology/routing/lisp/map-resolvers/ipv4": ["/api/tables/routing/protocols/lisp/ipv4-databases"],
      "/technology/routing/lisp/map-resolvers/ipv6": ["/api/tables/routing/protocols/lisp/ipv6-databases"],
      "/technology/routing/lisp/routes": ["/api/tables/routing/protocols/lisp/ipv4-routes"],
      "/technology/routing/lisp/routes/ipv4": ["/api/tables/routing/protocols/lisp/ipv4-routes"],
      "/technology/routing/lisp/routes/ipv6": ["/api/tables/routing/protocols/lisp/ipv6-routes"],
      "/technology/routing/ospf": ["/api/tables/routing/protocols/ospf/neighbors"],
      "/technology/routing/ospf-v3": ["/api/tables/routing/protocols/ospf-v3/neighbors"],
      "/technology/routing/ospf-v3/interfaces": ["/api/tables/routing/protocols/ospf-v3/interfaces"],
      "/technology/routing/ospf-v3/neighbors": ["/api/tables/routing/protocols/ospf-v3/neighbors"],
      "/technology/routing/ospf/interfaces": ["/api/tables/routing/protocols/ospf/interfaces"],
      "/technology/routing/ospf/neighbors": ["/api/tables/routing/protocols/ospf/neighbors"],
      "/technology/routing/path-verifications-2": ["/api/tables/networks/path-lookup-checks"],
      "/technology/routing/pbr-interfaces": ["/api/tables/networks/policies/routing/interfaces"],
      "/technology/routing/policy-based-routing": ["/api/tables/security/pbr"],
      "/technology/routing/prefix-lists": ["/api/tables/networks/policies/prefix-lists/ipv4"],
      "/technology/routing/prefix-lists/ipv4": ["/api/tables/networks/policies/prefix-lists/ipv4"],
      "/technology/routing/prefix-lists/ipv6": ["/api/tables/networks/policies/prefix-lists/ipv6"],
      "/technology/routing/rip": ["/api/tables/routing/protocols/rip/neighbors"],
      "/technology/routing/rip/interfaces": ["/api/tables/routing/protocols/rip/interfaces"],
      "/technology/routing/rip/neighbors": ["/api/tables/routing/protocols/rip/neighbors"],
      "/technology/routing/route-stability-2": ["/api/tables/networks/route-stability"],
      "/technology/routing/routing-policies": ["/api/tables/networks/policies/routing"],
      "/technology/routing/summary": ["/api/tables/networks/summary/protocols"],
      "/technology/routing/summary/bgp": ["/api/tables/networks/summary/protocols/bgp"],
      "/technology/routing/summary/eigrp": ["/api/tables/networks/summary/protocols/eigrp"],
      "/technology/routing/summary/is-is": ["/api/tables/networks/summary/protocols/isis"],
      "/technology/routing/summary/ospf": ["/api/tables/networks/summary/protocols/ospf"],
      "/technology/routing/summary/ospfv3": ["/api/tables/networks/summary/protocols/ospfv3"],
      "/technology/routing/summary/protocols": ["/api/tables/networks/summary/protocols"],
      "/technology/routing/summary/rip": ["/api/tables/networks/summary/protocols/rip"],
      "/technology/routing/vrf": ["/api/tables/vrf/summary"],
      "/technology/routing/vrf/detail": ["/api/tables/vrf/detail"],
      "/technology/routing/vrf/interfaces": ["/api/tables/vrf/interfaces"],
      "/technology/routing/vrf/summary": ["/api/tables/vrf/summary"],
      "/technology/sdn/aci": ["/api/tables/aci/endpoints"],
      "/technology/sdn/aci/dtep": ["/api/tables/aci/dtep"],
      "/technology/sdn/aci/endpoint": ["/api/tables/aci/endpoints"],
      "/technology/sdn/aci/vlan": ["/api/tables/aci/vlan"],
      "/technology/sdn/aci/vrf": ["/api/tables/aci/vrf"],
      "/technology/sdn/apic": ["/api/tables/apic/controllers"],
      "/technology/sdn/apic/applications": ["/api/tables/apic/applications"],
      "/technology/sdn/apic/bridge-domains": ["/api/tables/apic/bridge-domains"],
      "/technology/sdn/apic/contexts": ["/api/tables/apic/contexts"],
      "/technology/sdn/apic/contracts": ["/api/tables/apic/contracts"],
      "/technology/sdn/apic/controllers": ["/api/tables/apic/controllers"],
      "/technology/sdn/apic/endpoint-groups": ["/api/tables/apic/endpoint-groups"],
      "/technology/sdn/apic/endpoint-groups-contracts": ["/api/tables/apic/endpoint-groups/contracts"],
      "/technology/sdn/apic/service-graphs": ["/api/tables/apic/service-graphs"],
      "/technology/sdn/vxlan": ["/api/tables/vxlan/vtep"],
      "/technology/sdn/vxlan/interfaces": ["/api/tables/vxlan/interfaces"],
      "/technology/sdn/vxlan/peers": ["/api/tables/vxlan/peers"],
      "/technology/sdn/vxlan/vni": ["/api/tables/vxlan/vni"],
      "/technology/sdn/vxlan/vtep": ["/api/tables/vxlan/vtep"],
      "/technology/sdwan/meraki": ["/api/tables/sdwan/meraki/overlay"],
      "/technology/sdwan/silverpeak": ["/api/tables/sdwan/silverpeak/overlay"],
      "/technology/sdwan/velocloud": ["/api/tables/sdwan/velocloud/overlay"],
      "/technology/sdwan/versa": ["/api/tables/sdwan/versa/sites"],
      "/technology/sdwan/viptela": ["/api/tables/sdwan/viptela/bfd-sessions"],
      "/technology/security": ["/api/tables/security/acl"],
      "/technology/security/acl-interfaces": ["/api/tables/security/acl/interfaces"],
      "/technology/security/dhcp-snooping": ["/api/tables/security/dhcp/snooping"],
      "/technology/security/dhcp-snooping/binding-database": ["/api/tables/security/dhcp/bindings"],
      "/technology/security/dhcp-snooping/configuration": ["/api/tables/security/dhcp/snooping"],
      "/technology/security/dmvpn": ["/api/tables/security/dmvpn"],
      "/technology/security/global-acl-policies": ["/api/tables/security/acl/global-policies"],
      "/technology/security/ipsec": ["/api/tables/security/ipsec/tunnels"],
      "/technology/security/lsvpn": ["/api/tables/security/lsvpn/satellites"],
      "/technology/security/secure-ports": ["/api/tables/security/secure-ports/devices"],
      "/technology/security/ssl": ["/api/tables/security/ssl/certificates"],
      "/technology/security/zone-firewall": ["/api/tables/security/zone-firewall/policies"],
      "/technology/serial-ports": ["/api/tables/serial-ports"],
      "/technology/spanning-tree/inconsistencies": ["/api/tables/spanning-tree/inconsistencies/neighbor-ports-vlan-mismatch"],
      "/technology/spanning-tree/inconsistencies/vlans-no-stp": ["/api/tables/interfaces/inconsistencies/summary"],
      "/technology/spanning-tree/inconsistencies/vlans-no-stp/detail": ["/api/tables/interfaces/inconsistencies/details"],
      "/technology/spanning-tree/inconsistencies/vlans-no-stp/summary": ["/api/tables/interfaces/inconsistencies/summary"],
      "/technology/spanning-tree/stp-bridges": ["/api/tables/spanning-tree/bridges"],
      "/technology/spanning-tree/stp-guards": ["/api/tables/spanning-tree/guards"],
      "/technology/spanning-tree/stp-instances": ["/api/tables/spanning-tree/instances"],
      "/technology/spanning-tree/stp-neighbors": ["/api/tables/spanning-tree/neighbors"],
      "/technology/spanning-tree/stp-virtual-ports": ["/api/tables/spanning-tree/ports"],
      "/technology/spanning-tree/stp-vlans": ["/api/tables/spanning-tree/vlans"],
      "/technology/spbm/b-mac-forwarding": ["/api/tables/spbm/bmac"],
      "/technology/spbm/services": ["/api/tables/spbm/services"],
      "/technology/vlans": ["/api/tables/vlan/device-summary"],
      "/technology/wireless/access-points": ["/api/tables/wireless/access-points"],
      "/technology/wireless/clients": ["/api/tables/wireless/clients"],
      "/technology/wireless/controllers": ["/api/tables/wireless/controllers"],
      "/technology/wireless/radios": ["/api/tables/wireless/radio"],
      "/technology/wireless/radios/radios-detail": ["/api/tables/wireless/radio"],
      "/technology/wireless/radios/ssid-summary": ["/api/tables/wireless/ssid-summary"],
    };

    // Build the base API path with the head→tail mapping.
    function basePath(t) {
      if (head === "technology") return "/api/tables/" + t.join("/");
      if (head === "inventory")  return "/api/tables/inventory/" + t.join("/");
      return "/api/tables/" + parts.join("/");
    }

    const candidates = [];
    // 0. Explicit overrides first (documented, highest-confidence paths).
    const overrides = API_PATH_OVERRIDES[uiPath];
    if (overrides) candidates.push(...overrides);
    // 1. Primary candidate: as-is.
    if (tail.length || head !== "inventory") {
      candidates.push(basePath(tail));
    }
    // 2. For inventory, also try without the "inventory" segment
    //    (e.g. /api/tables/devices). The host doesn't actually use
    //    this shape, but harmless to try if the canonical 404s.
    if (head === "inventory") {
      candidates.push("/api/tables/" + tail.join("/"));
    }
    // 3. Hyphenation variants (l3vpn → l3-vpn, l2vpn → l2-vpn).
    const hyphenVariants = candidates.flatMap((p) => {
      const h = p.replace(/\/l3vpn\b/g, "/l3-vpn")
                 .replace(/\/l2vpn\b/g, "/l2-vpn");
      return h !== p ? [h] : [];
    });
    candidates.push(...hyphenVariants);
    // 3b. Singular/plural variants of the FIRST section segment after
    //     "/api/tables/". Some UI sections are pluralized while their API
    //     table lives under the singular form (and vice-versa). The clearest
    //     example: the UI path "/technology/vlans/..." maps to the API
    //     "/api/tables/vlan/..." (singular). We add both forms so the scan
    //     tries each; the first that returns 200 wins. Only the leading
    //     section segment is toggled, to avoid touching real table names.
    const sectionVariants = [];
    for (const p of candidates) {
      const m = p.match(/^(\/api\/tables\/)([^/]+)(\/.*)?$/);
      if (!m) continue;
      const [, prefix, section, rest = ""] = m;
      const alts = new Set();
      if (/s$/i.test(section)) alts.add(section.replace(/s$/i, "")); // plural → singular
      else alts.add(section + "s");                                  // singular → plural
      for (const alt of alts) {
        if (alt && alt !== section) sectionVariants.push(prefix + alt + rest);
      }
    }
    candidates.push(...sectionVariants);
    // 4. Parent-path fallbacks: drop the last segment, then the last
    //    two, then stop. Skips top-level paths to avoid hitting
    //    unrelated tables.
    if (tail.length >= 2) {
      candidates.push(basePath(tail.slice(0, -1)));
    }
    if (tail.length >= 3) {
      candidates.push(basePath(tail.slice(0, -2)));
    }

    // De-dupe while preserving order.
    const seen = new Set();
    return candidates.filter((p) => p && !seen.has(p) && seen.add(p));
  }

  // The IP Fabric API requires a snapshot UUID in the request body
  // (e.g. "9a94ffe6-e2de-48ef-ac88-2a61f829db52"). The host page
  // fetches the current snapshot from /api/snapshots. We do the
  // same here, once per scan, and cache the result.
  let snapshotIdCache = null;

  // Common columns we send by default. The API requires a "columns"
  // field and validates it strictly — unknown columns return 422 with
  // a list of the invalid field names, which we parse and retry with
  // a filtered set.
  //
  // This list is a superset of columns observed across the IP Fabric
  // tables in the MCP schema dump. Most tables have at least 2–3 of
  // these; the ones it doesn't have come back as 422 errors which we
  // recover from.
  const COMMON_COLUMNS = [
    "id", "hostname", "name", "siteName",
    "sn", "snHw", "intName",
    "loginIpv4", "loginIp", "ip", "ipv4", "ipv6",
    "vendor", "family", "model", "platform", "version",
    "vlanId", "vlanName", "vrf", "mac", "address",
    "neighborHostname", "neighborSn", "remoteHostname",
    "dnsName", "uri", "url",
    "description", "dscr", "title",
    // VLAN-table columns (network/site/device/l3-gateways): the VLAN name
    // lives in `vlanName`, not `name`, so without it values like "s4xanadu"
    // would never be fetched (and thus never matched). The other VLAN
    // columns are added for completeness; any a given table lacks are
    // dropped automatically by the 422 column-recovery.
    "devCount", "stpDomain", "rootId", "networks", "status", "stdStatus",
    // Routing/addressing columns: a route's prefix lives in `network`
    // (e.g. "10.2.10.128/25"); related fields included for completeness.
    // Any a given table lacks are dropped by the 422 column-recovery.
    "network", "prefix", "prefixLength", "nexthop", "nhCount", "protocol",
    // Load-balancing (virtual-servers) columns: a pool's name lives in
    // `poolName` and a member's name in `poolMemberName`, so without these
    // a value like "tg-tcp-80-private" would never be fetched (and thus
    // never matched) when the scanner falls back to an explicit column
    // list. Related member fields are included for completeness; any a
    // given table lacks are dropped automatically by the 422 recovery.
    "poolName", "poolMemberName", "memberIp", "memberIpV6", "availability", "state", "port",
  ];

  // Explicit, documented column lists for specific tables (keyed by UI
  // path). When present, these are requested FIRST — guaranteeing that the
  // key searchable fields are fetched without relying on column discovery
  // or the omit-columns default (which may not include every column for
  // every IP Fabric version). Sourced from IP Fabric's table descriptions.
  const TABLE_COLUMN_OVERRIDES = {
    // VLAN tables — vlanName holds values like "s4xanadu"; l3-gateways has
    // no vlanName (only vlanId), per the table description.
    "/technology/vlans/network-summary": ["vlanId", "vlanName", "devCount", "dscr"],
    "/technology/vlans/site-summary":    ["vlanId", "vlanName", "siteName", "devCount", "dscr"],
    "/technology/vlans/l3-gateways":     ["vlanId", "networks", "stpDomain", "rootId"],
    "/technology/vlans/device-detail":   ["vlanId", "vlanName", "hostname", "siteName", "sn", "status", "stdStatus", "stpDomain"],
    // IPv4/IPv6 routing tables — the route prefix lives in `network`
    // (e.g. "10.2.10.128/25").
    "/technology/routing/routes":        ["network", "prefix", "protocol", "nexthop", "hostname", "siteName", "vrf"],
    "/technology/routing/routes/ipv6":   ["network", "prefix", "protocol", "nexthop", "hostname", "siteName", "vrf"],
  };

  async function discoverSnapshotId(abortSignal) {
    if (snapshotIdCache) return snapshotIdCache;
    // The /api/snapshots endpoint returns a list of snapshots. We want
    // the most recent "loaded" one. Spec is loose, so we tolerate a
    // few shapes and pick the first id we can find.
    try {
      const res = await fetch("/api/snapshots", {
        method: "GET",
        credentials: "include",
        headers: { "Accept": "application/json" },
        signal: abortSignal,
      });
      if (!res.ok) return null;
      const json = await res.json();
      const list = Array.isArray(json) ? json :
                   (Array.isArray(json?.data) ? json.data : []);
      // Prefer status==='loaded'/'done', otherwise just take the first.
      const ranked = list.slice().sort((a, b) => {
        const ap = (a && (a.status === "loaded" || a.status === "done")) ? 0 : 1;
        const bp = (b && (b.status === "loaded" || b.status === "done")) ? 0 : 1;
        return ap - bp;
      });
      const first = ranked.find((s) => s && (s.id || s.snapshotId));
      if (first) {
        snapshotIdCache = first.id || first.snapshotId;
        return snapshotIdCache;
      }
    } catch (err) {
      if (err.name === "AbortError") throw err;
    }
    return null;
  }

  // Try one API URL against the IP Fabric server. Returns:
  //   { ok: true, rows: [...] } on success (200 + parseable body),
  //   { ok: false, status: NNN } otherwise (used to try the next candidate).
  //
  // Request body matches the shape the IP Fabric UI itself sends:
  //   {
  //     "columns": ["hostname", "siteName", ...],
  //     "snapshot": "<uuid>",
  //     "filters": {},
  //     "pagination": { "limit": N, "start": 0 },
  //     "reports": "<UI path>"
  //   }
  //
  // The API requires `columns` and validates each entry. Unknown
  // columns return 422 with a per-field error listing the bad names.
  // We start with a broad common-columns list and, on 422 with a
  // column validation error, drop the invalid entries and retry once.
  async function fetchTable(apiPath, uiPath, snapshotId, abortSignal) {
    // Column strategy, in order of preference:
    //   phase -1: if this UI path has a documented column override, request
    //             exactly those columns FIRST (guarantees key fields like a
    //             VLAN's `vlanName` or a route's `network` are fetched).
    //   phase 0:  request ALL columns by omitting `columns` entirely. Modern
    //             IP Fabric returns every column this way.
    //   phase 1:  on 422, discover the table's real columns from the error,
    //             else fall back to the broad COMMON_COLUMNS list.
    //   phase 2:  if that 422s on specific invalid column indices, drop them
    //             and retry once with the valid subset.
    const overrideCols = TABLE_COLUMN_OVERRIDES[uiPath] || null;
    let phase = overrideCols ? -1 : 0;
    let columns = overrideCols ? overrideCols.slice() : null; // null => omit
    let triedDiscovered = false;   // whether we've tried discovered columns
    for (let attempt = 0; attempt < 6; attempt++) {
      const body = {
        snapshot: snapshotId,
        filters: {},
        pagination: { limit: 1000, start: 0 },
        reports: uiPath,
      };
      // Only include `columns` when we actually have a list (not phase 0).
      if (columns) body.columns = columns;

      let res;
      let bodyJson;         // parsed response body (ok or 422), read under timeout
      let badJson = false;  // true if an OK response had an unparseable body
      // Per-request timeout: abort this single attempt if it neither resolves
      // nor rejects within TABLE_FETCH_TIMEOUT_MS. We wire up a dedicated
      // controller that fires on EITHER the scan-wide abortSignal (user
      // cancelled / new search) OR the timeout, so a hung request — whether
      // it stalls before the response headers OR midway through the body —
      // can never block a worker. We then disambiguate: a scan-wide abort
      // propagates (throws AbortError) to stop the worker; a timeout is a
      // soft failure so the scan continues to the next candidate/table.
      const reqController = new AbortController();
      let timedOut = false;
      const onParentAbort = () => reqController.abort();
      if (abortSignal) {
        if (abortSignal.aborted) reqController.abort();
        else abortSignal.addEventListener("abort", onParentAbort, { once: true });
      }
      const timer = setTimeout(() => { timedOut = true; reqController.abort(); }, TABLE_FETCH_TIMEOUT_MS);
      try {
        res = await fetch(apiPath, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json", "Accept": "application/json" },
          body: JSON.stringify(body),
          signal: reqController.signal,
        });
        // Read the body while the timeout is still armed, so a mid-body
        // stall is caught too. We only need JSON for OK and 422 responses.
        // If the timeout (or parent abort) fires during the read, res.json()
        // rejects with AbortError — we rethrow so the outer catch classifies
        // it as a timeout / propagates a real cancel, rather than treating it
        // as an unparseable body.
        if (res.ok) {
          try { bodyJson = await res.json(); }
          catch (e) {
            if (e && e.name === "AbortError") throw e;
            badJson = true;
          }
        } else if (res.status === 422) {
          try { bodyJson = await res.json(); }
          catch (e) {
            if (e && e.name === "AbortError") throw e;
            bodyJson = null;
          }
        }
      } catch (err) {
        // If the parent scan was aborted, propagate so the worker stops.
        if (abortSignal && abortSignal.aborted && !timedOut) throw err;
        // Otherwise this was our per-request timeout (or a transient network
        // error): report a soft failure so the caller tries the next
        // candidate and the scan keeps moving.
        return { ok: false, status: 0, reason: timedOut ? "timeout" : err.message };
      } finally {
        clearTimeout(timer);
        if (abortSignal) abortSignal.removeEventListener("abort", onParentAbort);
      }
      if (res.ok) {
        if (badJson) return { ok: false, status: 0, reason: "bad json" };
        const rows = Array.isArray(bodyJson?.data) ? bodyJson.data : [];
        return { ok: true, rows };
      }

      // Recover from a 422. Behaviour depends on which phase we're in.
      if (res.status === 422) {
        const errJson = bodyJson;

        if (phase === -1) {
          // The documented column override was rejected by this server
          // version. Fall through to the omit-all-columns request.
          phase = 0;
          columns = null;
          continue;
        }
        if (phase === 0) {
          // The server requires an explicit columns list. Try to discover
          // the table's REAL columns from the validation error (IP Fabric
          // often enumerates the allowed columns). We UNION the discovered
          // columns with COMMON_COLUMNS so we never lose the common fields,
          // then the 422 column-recovery drops any the table rejects. This
          // fetches every column the table has — table-specific fields like
          // a routing table's `network` or a VLAN's `vlanName` included.
          const discovered = discoverColumnsFromError(errJson);
          if (discovered && discovered.length) {
            phase = 1;
            triedDiscovered = true;
            const merged = [];
            const seen = new Set();
            for (const c of discovered.concat(COMMON_COLUMNS)) {
              if (c && !seen.has(c)) { seen.add(c); merged.push(c); }
            }
            columns = merged;
            continue;
          }
          phase = 1;
          columns = COMMON_COLUMNS.slice();
          continue;
        }
        if (phase === 1) {
          // First, try dropping any specifically-invalid column indices and
          // retry — this keeps the discovered table-specific columns (e.g.
          // `network`, `vlanName`) while removing only the ones this table
          // doesn't support.
          const filtered = filterInvalidColumns(columns, errJson);
          if (filtered && filtered.length && filtered.length < columns.length) {
            phase = 2;
            columns = filtered;
            continue;
          }
          // If we can't pinpoint invalid indices but we'd tried the
          // discovered/merged set, fall back to the plain COMMON_COLUMNS
          // list once before giving up.
          if (triedDiscovered) {
            triedDiscovered = false;
            phase = 1;
            columns = COMMON_COLUMNS.slice();
            continue;
          }
        }
      }
      return { ok: false, status: res.status };
    }
    return { ok: false, status: 422 };
  }

  // Parse a 422 column-validation response and return the columns
  // that are NOT mentioned as invalid. Returns null if we can't tell.
  //
  // Real example (the user's report):
  //   { "code": "API_VALIDATION_FAILED",
  //     "errors": [{ "code": "invalid_type", "field": ["columns"],
  //                  "message": "Required" }] }
  // That one says "columns Required" — meaning the whole field is
  // missing, not that individual entries are wrong. We send columns
  // now so we won't see that. Instead we expect entries like:
  //   { "errors": [{ "field": ["columns", 5], "message": "..." }, ...] }
  // i.e. the field path points at a specific index in our columns
  // array. We drop those indices.
  function filterInvalidColumns(columns, errJson) {
    if (!errJson || !Array.isArray(errJson.errors)) return null;
    const badIndices = new Set();
    let sawColumnError = false;
    for (const e of errJson.errors) {
      const f = e && e.field;
      if (Array.isArray(f) && f[0] === "columns") {
        sawColumnError = true;
        if (typeof f[1] === "number") badIndices.add(f[1]);
      }
    }
    if (!sawColumnError) return null;
    // If the API said "columns is required" without indices, all
    // columns are invalid (or none were sent).
    if (badIndices.size === 0) return null;
    return columns.filter((_, i) => !badIndices.has(i));
  }

  // Extract the table's actual valid column names from a 422 response.
  // IP Fabric's validation errors frequently enumerate the allowed
  // columns, e.g. a message like:
  //   '"columns[0]" must be one of [id, network, prefix, nexthop, ...]'
  // Discovering the real columns lets us request EVERY column the table
  // has — so table-specific fields (a routing table's `network`, a VLAN's
  // `vlanName`, etc.) are fetched and therefore searchable, without having
  // to hard-code each one. Returns an array of column names, or null.
  function discoverColumnsFromError(errJson) {
    if (!errJson) return null;
    const names = new Set();
    const harvest = (text) => {
      if (typeof text !== "string") return;
      // Match "must be one of [a, b, c]" (and similar) lists.
      const m = text.match(/one of\s*\[([^\]]+)\]/i);
      if (m) {
        for (const raw of m[1].split(",")) {
          const name = raw.trim().replace(/^['"]|['"]$/g, "");
          if (name && /^[a-zA-Z0-9_]+$/.test(name)) names.add(name);
        }
      }
    };
    if (Array.isArray(errJson.errors)) {
      for (const e of errJson.errors) {
        harvest(e && e.message);
        if (Array.isArray(e && e.expected)) {
          for (const c of e.expected) if (typeof c === "string") names.add(c);
        }
      }
    }
    harvest(errJson.message);
    return names.size ? Array.from(names) : null;
  }

  // ---------------------------------------------------------------------
  // Deep-link-aware cell matching.
  //
  // Most IP Fabric columns return a plain string/number that the old
  // matcher handled fine. But some columns — notably the Host IP address
  // column in Inventory → Hosts, plus device/neighbor columns elsewhere —
  // are rendered by the UI as a clickable "Device Explorer" deep link
  // (the green chip with the link icon in the screenshots). For those
  // columns the API does not always return a bare dotted string in a
  // single field. The searchable value can instead be:
  //
  //   • nested inside a structured object/array cell, e.g.
  //       { "ip": { "data": "172.16.61.60", "url": "/inventory/hosts?..." } }
  //     or one level deeper than a naive top-level scan would reach;
  //   • present only inside a deep-link URL that is PERCENT-ENCODED, e.g.
  //       "/inventory/hosts?options=%7B%22...172.16.61.60...%22%7D"
  //     (the dots survive, but surrounding punctuation is escaped, and in
  //     some builds the value itself is escaped, e.g. "172%2E16%2E61%2E60");
  //   • split so that the human-readable form the UI shows is composed by
  //     the front-end from adjacent fields.
  //
  // A single top-level `JSON.stringify(cell)` substring test — the old
  // behaviour — can miss these. To robustly match "any item that appears
  // in any table column", including deep-link-encoded ones, we:
  //
  //   1. Recursively walk every cell (objects and arrays included) and
  //      collect every primitive leaf (string / number / boolean) as text.
  //   2. For every string leaf, ALSO test a URL-decoded copy, so a term
  //      embedded in a percent-encoded deep-link URL is found. Decoding is
  //      best-effort and never throws.
  //   3. Keep the previous whole-cell JSON.stringify test as a final
  //      safety net, so anything that matched before still matches now.
  //
  // The needle is compared case-insensitively. Matching is deliberately a
  // superset of the old logic: it never removes a match, it only adds the
  // ability to find values the old scan could not see.
  // ---------------------------------------------------------------------

  // Best-effort URL decode. decodeURIComponent throws on malformed input
  // (e.g. a lone "%"), so we guard it and fall back to the raw string.
  function safeDecodeURIComponent(s) {
    if (typeof s !== "string" || s.indexOf("%") === -1) return s;
    try { return decodeURIComponent(s); }
    catch { return s; }
  }

  // ---------------------------------------------------------------------
  // IP-address-aware search terms.
  //
  // The Host IP address column in Inventory → Hosts (and some other IP
  // columns) is rendered by the UI as a value that the API does NOT
  // necessarily return as the plain dotted-decimal string the user typed.
  // Depending on table and version it can come back as:
  //
  //   • the plain dotted string  "172.16.61.60"            (matched already)
  //   • a packed 32-bit INTEGER  2886745404                (needs expansion)
  //   • a zero-padded form       "172.016.061.060"         (needs expansion)
  //   • the dotted string embedded in a deep-link URL       (handled by the
  //     recursive + URL-decode logic below)
  //
  // So when the user's term parses as an IPv4 (or IPv6) address we expand
  // it into every equivalent representation and match a cell if it contains
  // ANY of them. This is purely additive: for non-IP terms the set is just
  // the original term, so behaviour for hostnames, MACs, VLAN names, etc.
  // is completely unchanged.
  // ---------------------------------------------------------------------

  // Parse a strict dotted-decimal IPv4 into its unsigned 32-bit integer, or
  // return null if the string isn't a valid IPv4 address.
  function ipv4ToInt(s) {
    if (typeof s !== "string") return null;
    const parts = s.split(".");
    if (parts.length !== 4) return null;
    let n = 0;
    for (const part of parts) {
      if (!/^\d{1,3}$/.test(part)) return null;
      const oct = parseInt(part, 10);
      if (oct < 0 || oct > 255) return null;
      n = (n * 256) + oct;
    }
    // >>> 0 keeps it an unsigned 32-bit value.
    return n >>> 0;
  }

  // Expand an IPv6 address into several normalized string forms so a
  // fully-expanded API value matches a compressed user term and vice-versa.
  // Best-effort only; returns [] when the string isn't a plausible IPv6.
  function ipv6Variants(s) {
    if (typeof s !== "string" || s.indexOf(":") === -1) return [];
    const raw = s.trim().toLowerCase();
    // Basic sanity: only hex digits, colons (and at most one "::").
    if (!/^[0-9a-f:]+$/.test(raw)) return [];
    if ((raw.match(/::/g) || []).length > 1) return [];
    let head, tail;
    if (raw.includes("::")) {
      const [h, t] = raw.split("::");
      head = h ? h.split(":") : [];
      tail = t ? t.split(":") : [];
    } else {
      head = raw.split(":");
      tail = [];
    }
    const missing = 8 - (head.length + tail.length);
    if (missing < 0) return [];
    const groups = head.concat(Array(missing).fill("0")).concat(tail);
    if (groups.length !== 8) return [];
    if (!groups.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return [];
    const full = groups.map((g) => g.padStart(4, "0")).join(":");        // fully expanded
    const stripped = groups.map((g) => g.replace(/^0+(?=.)/, ""));        // no leading zeros per group
    const compact = stripped.join(":");                                   // no leading zeros, no :: compression

    // RFC-5952-style "::" compression: collapse the longest run (length ≥ 2)
    // of all-zero groups. This makes an expanded term match a compressed
    // API value and vice-versa.
    let bestStart = -1, bestLen = 0, curStart = -1, curLen = 0;
    for (let i = 0; i < 8; i++) {
      if (stripped[i] === "0") {
        if (curStart === -1) { curStart = i; curLen = 1; } else { curLen++; }
        if (curLen > bestLen) { bestLen = curLen; bestStart = curStart; }
      } else { curStart = -1; curLen = 0; }
    }
    let collapsed = compact;
    if (bestLen >= 2) {
      const before = stripped.slice(0, bestStart).join(":");
      const after = stripped.slice(bestStart + bestLen).join(":");
      collapsed = before + "::" + after;
    }
    return [full, compact, collapsed];
  }

  // Given the user's raw search term, return the lower-cased set of strings
  // to match against. For an IPv4/IPv6 term this includes equivalent
  // encodings (integer, zero-stripped, expanded); for anything else it is
  // just the term itself.
  function buildNeedleSet(term) {
    const base = String(term).toLowerCase();
    const set = new Set([base]);

    const asInt = ipv4ToInt(term.trim());
    if (asInt !== null) {
      // Integer-encoded IPv4 columns.
      set.add(String(asInt));
      // Zero-stripped canonical form (in case the term had padded octets,
      // e.g. "172.016.061.060" → "172.16.61.60").
      const canonical = term.trim().split(".").map((o) => String(parseInt(o, 10))).join(".");
      set.add(canonical.toLowerCase());
    }

    for (const v of ipv6Variants(term)) set.add(v);

    return Array.from(set).filter(Boolean);
  }

  // Walk a cell value and test the needle set against every primitive leaf
  // (recursing through nested objects/arrays). Returns true on first hit.
  // `needles` is a lower-cased array (see buildNeedleSet). `depth` guards
  // against pathological or cyclic structures; IP Fabric cells are shallow.
  function cellContainsNeedle(value, needles, depth) {
    if (value == null) return false;
    const t = typeof value;
    if (t === "string") {
      const lower = value.toLowerCase();
      for (const n of needles) if (lower.includes(n)) return true;
      // Deep-link URLs frequently percent-encode their payload; test the
      // decoded form too (covers "%2E"-escaped dots and escaped braces).
      const decoded = safeDecodeURIComponent(value);
      if (decoded !== value) {
        const dl = decoded.toLowerCase();
        for (const n of needles) if (dl.includes(n)) return true;
      }
      // If the cell itself is a zero-padded dotted-decimal IPv4
      // (e.g. "172.016.061.060"), compare its canonical form too, so a
      // canonical search term still matches. Cheap: only fires on strings
      // shaped exactly like a padded IPv4.
      if (/^\d{1,3}(\.\d{1,3}){3}$/.test(value.trim())) {
        const canon = value.trim().split(".").map((o) => String(parseInt(o, 10))).join(".");
        if (canon !== value.trim()) {
          for (const n of needles) if (canon === n) return true;
        }
      }
      return false;
    }
    if (t === "number" || t === "boolean") {
      // For numbers, test substring (covers "661" inside a value) AND exact
      // string equality against each needle — the latter is what catches an
      // integer-encoded IPv4 stored as e.g. 2886745404.
      const s = String(value).toLowerCase();
      for (const n of needles) if (s === n || s.includes(n)) return true;
      return false;
    }
    if (t !== "object" || depth <= 0) return false;
    if (Array.isArray(value)) {
      for (const item of value) {
        if (cellContainsNeedle(item, needles, depth - 1)) return true;
      }
      return false;
    }
    for (const nested of Object.values(value)) {
      if (cellContainsNeedle(nested, needles, depth - 1)) return true;
    }
    return false;
  }

  // Search every cell of every row for the term (case-insensitive
  // substring). Returns up to `max` matched rows. Handles strings,
  // numbers, booleans, nested objects/arrays, deep-link-encoded columns,
  // and IP addresses encoded as integers or in normalized/expanded forms
  // (see the block comments above).
  function findMatchesInRows(rows, term, max = 5) {
    const needles = buildNeedleSet(term);   // lower-cased term + IP variants
    const primary = needles[0];             // the plain lower-cased term
    const out = [];
    for (const row of rows) {
      if (!row || typeof row !== "object") continue;
      let matched = false;
      for (const v of Object.values(row)) {
        if (v == null) continue;
        // Fast paths (plain columns), then a recursive walk that also
        // reaches deep-link / nested values.
        if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
          if (cellContainsNeedle(v, needles, 1)) { matched = true; break; }
        } else if (cellContainsNeedle(v, needles, 6)) {
          matched = true;
          break;
        }
      }
      // Final safety net: whole-row stringify. This preserves the old
      // JSON.stringify-based matching exactly, so no prior match is lost
      // even for value shapes the recursive walk does not anticipate.
      if (!matched) {
        let rowStr = "";
        try { rowStr = JSON.stringify(row); } catch { rowStr = ""; }
        if (rowStr) {
          const lower = rowStr.toLowerCase();
          if (lower.includes(primary)) {
            matched = true;
          } else {
            const decoded = safeDecodeURIComponent(rowStr).toLowerCase();
            if (decoded !== lower && decoded.includes(primary)) matched = true;
          }
        }
      }
      if (matched) out.push(row);
      if (out.length >= max) break;
    }
    return out;
  }

  async function scanOnePath(uiPath, term, snapshotId, abortSignal) {
    const candidates = uiPathToApi(uiPath);
    let lastStatus = 0;
    for (const apiPath of candidates) {
      const r = await fetchTable(apiPath, uiPath, snapshotId, abortSignal);
      if (r.ok) {
        const matches = findMatchesInRows(r.rows, term);
        return {
          uiPath,
          apiPath,
          status: "ok",
          totalRows: r.rows.length,
          matchCount: matches.length,
          sampleMatches: matches.slice(0, 3),
        };
      }
      lastStatus = r.status;
      // 404 → try next candidate (likely hyphenation variant).
      // 401/403 → no point retrying.
      if (r.status === 401 || r.status === 403) break;
    }
    return { uiPath, status: "fail", httpStatus: lastStatus };
  }

  async function startTableScan(query, uiPaths, scanId) {
    if (!query || !Array.isArray(uiPaths) || !uiPaths.length) return;
    // Cancel any previous scan automatically.
    for (const oldId of activeScans.keys()) cancelActiveScan(oldId);

    const ac = new AbortController();
    activeScans.set(scanId, ac);

    const total = uiPaths.length;
    let done = 0;
    const matches = [];

    postScanMsg(scanId, { event: "start", total });

    // Discover the current snapshot UUID before fanning out. Without
    // it, every table request would 400. If discovery fails, surface
    // a clear error to the user rather than silently churning through
    // every table as a failure.
    let snapshotId = null;
    try {
      snapshotId = await discoverSnapshotId(ac.signal);
    } catch (err) {
      if (err.name === "AbortError") { activeScans.delete(scanId); return; }
    }
    if (!snapshotId) {
      postScanMsg(scanId, {
        event: "done", done: 0, total, matches: [],
        error: "Could not discover the current IP Fabric snapshot ID " +
               "(no response from /api/snapshots). The scan was aborted. " +
               "Make sure you're logged into IP Fabric in this tab.",
      });
      activeScans.delete(scanId);
      return;
    }

    // Simple concurrency pool: keep up to CONCURRENCY in flight.
    // Multiple UI paths can resolve to the same API endpoint (e.g. the
    // four /inventory/devices/{models,platforms,families,vendors} tabs
    // all back onto /api/tables/inventory/devices via parent-fallback).
    // We dedupe so the user sees each underlying table once, with the
    // most-specific UI path used as the link target.
    const seenApiPaths = new Set();
    let index = 0;
    async function worker() {
      while (index < uiPaths.length && !ac.signal.aborted) {
        const i = index++;
        const uiPath = uiPaths[i];
        try {
          const result = await scanOnePath(uiPath, query, snapshotId, ac.signal);
          done++;
          if (result.status === "ok" && result.matchCount > 0) {
            if (seenApiPaths.has(result.apiPath)) {
              // Duplicate of a previously-matched table — skip emit.
              postScanMsg(scanId, { event: "progress", done, total, result });
            } else {
              seenApiPaths.add(result.apiPath);
              matches.push(result);
              postScanMsg(scanId, { event: "match", done, total, match: result });
            }
          } else {
            postScanMsg(scanId, { event: "progress", done, total, result });
          }
        } catch (err) {
          if (err.name === "AbortError") return;
          done++;
          postScanMsg(scanId, {
            event: "progress", done, total,
            result: { uiPath, status: "fail", httpStatus: 0, reason: err.message },
          });
        }
      }
    }

    const workers = [];
    for (let i = 0; i < CONCURRENCY; i++) workers.push(worker());
    await Promise.all(workers);

    if (!ac.signal.aborted) {
      postScanMsg(scanId, { event: "done", done, total, matches });
    }
    activeScans.delete(scanId);
  }

  /* ---- 4. Messages from the background service worker ------------ */

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === "PING") { sendResponse({ ok: true }); return; }
    if (msg.type === "FOCUS_INPUT") {
      if (iframe.contentWindow) {
        iframe.contentWindow.postMessage({ type: "FOCUS" }, "*");
      }
      sendResponse({ ok: true });
      return;
    }
    if (msg.type === "LLM_PROGRESS") {
      // Forward LLM streaming progress from the background service worker
      // to the iframe so the UI can update as Claude works.
      if (iframe.contentWindow) {
        iframe.contentWindow.postMessage(msg, "*");
      }
      sendResponse({ ok: true });
      return;
    }
    return false;
  });

  /* ---- 5. Dismiss results when user clicks the page beneath ------- */

  // The iframe captures clicks within its bounds; the host page
  // captures clicks below. Use this to clear results when the user
  // clicks back onto the page.
  document.addEventListener("mousedown", (e) => {
    // Clicks on the host-page CVE control are not "clicks on the page
    // beneath" — they drive the CVE evaluation, so don't dismiss the
    // iframe dropdowns (which would hide the CVE results we're about to
    // show / are already showing).
    const t = e.target;
    if (t && t.closest && t.closest("#" + CVE_CTRL_ID)) return;
    if (iframe.contentWindow) {
      iframe.contentWindow.postMessage({ type: "PAGE_MOUSEDOWN" }, "*");
    }
  }, true);
})();
