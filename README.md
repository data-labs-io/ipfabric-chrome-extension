# IP Fabric Chrome Extension — Global Search + LLM Interactive Session + CVE Security Status + Diff Dashboard

A single **Manifest V3** Chrome extension that overlays four tools directly onto
the IP Fabric web UI:

- **Global Search** (top-left of the toolbar) — find every table that contains a
  value, either by scanning the data in your browser session or by asking an LLM.
- **LLM Interactive Session** (top-right of the toolbar) — a free-form prompt bar
  that drives Claude (or any OpenAI-compatible model) through the IP Fabric MCP
  server.
- **CVE Security Status** (centered on the header row) — cross-references the
  deployment's devices and OS versions against published CVE sources.
- **Diff Dashboard** (header-row button) — compares any Technology or Inventory
  table **column** between the current snapshot and another snapshot you choose,
  showing what was added, removed, or changed.

Each overlay can be shown or hidden independently from the extension's Options
page.

---

## Repository layout

```
ipfabric-combined-extension/
├── background.js      Service worker (commands, options relay)
├── content.js         Global Search + LLM + CVE content script
├── diff-content.js    Diff Dashboard content script
├── manifest.json      MV3 manifest
├── options.html       Options page markup
├── options.js         Options page logic
├── overlay.css        Global Search / LLM / CVE iframe styles
├── overlay.html       Global Search / LLM / CVE iframe markup
├── overlay.js         Global Search / LLM / CVE iframe logic
├── README.md          This file
├── rules.json         declarativeNetRequest CORS header rules
└── icons/
    ├── icon16.png
    ├── icon48.png
    └── icon128.png
```

The extension loads as-is — there is **no build step**, no bundler, and no
dependencies to install.

---

## Prerequisites

- Google Chrome, or any Chromium-based browser (Edge, Brave, Vivaldi) that
  supports `chrome://extensions` and Manifest V3.
- Access to an IP Fabric instance and a normal IP Fabric login.
- (Optional, for the LLM and CVE features only) an Anthropic API key or any
  OpenAI-compatible endpoint, and an IP Fabric API token.

---

## Install from the repository

1. **Get the code.** Clone the repository (or download it as a ZIP and extract
   it):

   ```bash
   git clone <your-repository-url>
   ```

   You should end up with an `ipfabric-combined-extension/` folder containing
   `manifest.json` at its top level.

2. **Open the extensions page.** In Chrome, go to `chrome://extensions`.

3. **Enable Developer mode** using the toggle in the top-right corner.

4. **Load the extension.** Click **Load unpacked** and select the
   `ipfabric-combined-extension` folder (the folder that directly contains
   `manifest.json` — not its parent).

5. **Pin it** (optional). Click the puzzle-piece toolbar icon and pin the
   extension so its button is always visible.

6. **Reload your IP Fabric tab.** Reload any already-open IP Fabric tab — the
   toolbar bar appears at the top of the page once the content scripts run.

That's it. Global Search's *Cycle every table* mode and the Diff Dashboard work
immediately using your existing IP Fabric login session — no keys required.

---

## First-time configuration (LLM and CVE features only)

The **LLM Interactive Session**, Global Search's *LLM and MCP Server* mode, and
**CVE Security Status** need credentials. Right-click the toolbar icon →
**Options** (or open `chrome://extensions` → the extension → **Extension
options**) and provide:

- **IP Fabric MCP Authorization header** — `Bearer <token>`, where `<token>` is
  generated in IP Fabric under **Settings → Integration → API Tokens**
  (Read / Discovery scope is enough).
- **Anthropic API key** — or the Base URL, model, and key for any
  OpenAI-compatible provider.

Click **Save**, then use **Test connection** to verify the IP Fabric MCP
credentials. Keys are stored only in your own browser (`chrome.storage.sync`) and
are never sent anywhere except the provider you configure.

> For full, step-by-step configuration — including OpenAI-compatible providers
> and troubleshooting — see **Installation_and_Configuration_Guide.docx**. For
> day-to-day usage of each tool, see **User_Guide.docx**.

---

## Pointing the extension at your own IP Fabric instance

This build is scoped to a single IP Fabric host. To use a different deployment,
edit `manifest.json` and replace every occurrence of the demo host with your own
URL, then reload the extension:

- `host_permissions` — the IP Fabric entry.
- **Both** `content_scripts[].matches` entries (one for `content.js`, one for
  `diff-content.js`).

After editing, return to `chrome://extensions` and click the **reload** icon on
the extension card, then reload your IP Fabric tab.

---

## Keyboard shortcuts

- **Ctrl + Shift + F** (`⌘ + Shift + F` on macOS) — focus the Global Search
  input.
- **Ctrl + Shift + D** (`⌘ + Shift + D` on macOS) — show or hide the Diff
  Dashboard panel (also toggled by its header-row button).

Shortcuts can be customized at `chrome://extensions/shortcuts`.

---

## Updating

Pull the latest code and reload the extension:

```bash
git pull
```

Then open `chrome://extensions` and click the **reload** icon on the extension
card. Reload any open IP Fabric tabs to pick up the new version.

---

## Notes

- **No build / no telemetry.** The extension ships as plain files; nothing is
  compiled, and it sends no data anywhere other than your IP Fabric instance and
  the LLM provider you explicitly configure.
- **Credentials stay local.** All keys live in `chrome.storage.sync` in your
  browser profile.
- **Version 5.1.3.**
