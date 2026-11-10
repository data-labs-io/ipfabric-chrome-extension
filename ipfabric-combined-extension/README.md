# IP Fabric Global Search + LLM Interactive Session + CVE + Diff Dashboard

A single Manifest V3 Chrome extension that overlays **four** tools onto the IP
Fabric UI:

1. **Global Search** (top-left of the toolbar) — find every table that contains
   a value, by scanning the data or asking an LLM.
2. **LLM Interactive Session** (top-right of the toolbar) — a free-form prompt
   bar that drives Claude (or any OpenAI-compatible model) via the IP Fabric MCP
   server.
3. **CVE Security Status** (centered on the header row) — cross-references the
   deployment's devices/OS versions against published CVE sources.
4. **Diff Dashboard** (header-row button) — compares any Technology/Inventory
   table **column** between the current snapshot and another snapshot you pick,
   showing what was added, removed, or changed.

This is the merge of the *IP Fabric Global Search + LLM Interactive + CVE*
extension (v4.0.1) and the standalone *Diff Dashboard* extension into one
package. **Every feature of both originals is preserved and works together.**

---

## Each overlay can be shown or hidden independently

Options → **Display** has four checkboxes (all on by default):

- Show Global Search (top-left)
- Show LLM Interactive Session (top-right)
- Show CVE Security Status
- **Show Diff Dashboard** ← new

Turning **Show Diff Dashboard** off hides its header-row button and panel
completely — exactly the same show/hide mechanism the other three use. The
change applies live, no reload needed.

---

## The Diff Dashboard

- Hidden by default behind a brand-styled **Diff Dashboard** button on the IP
  Fabric header row. Click it (or press `Ctrl+Shift+D`) to open/close the panel.
- The button **auto-positions to avoid the Global Search bar and the CVE
  control** — it sits below the bar and beside the CVE control, repositioning
  live as those overlays load, unload, or are toggled.
- In the panel: pick a **column** and a second **snapshot**, press **Compare**,
  and see **Only in A / Only in B / Changed / Unchanged** for that column. Rows
  are matched by a per-table primary key (shown as *"Rows matched on …"*),
  mirroring the IP Fabric Python SDK's `table.compare()`. Includes deep links
  back into IP Fabric and CSV export.
- Diff-specific settings live in Options → **Diff Dashboard**: *Ignore volatile
  fields (age, uptime)* and *Reset Diff Dashboard position & size*.
- Uses your existing IP Fabric session cookie — no token needed for the diff.

---

## Toolbar icon & keyboard shortcuts

- **Toolbar icon** — focuses the Global Search input (unchanged from v4.0.1).
- **`Ctrl+Shift+F`** (`⌘+Shift+F`) — focus Global Search.
- **`Ctrl+Shift+D`** (`⌘+Shift+D`) — show/hide the Diff Dashboard (also via its
  header-row button).

---

## Install

1. Open `chrome://extensions`, enable **Developer mode**.
2. **Load unpacked** → select the `ipfabric-combined-extension` folder.
3. Pin the extension and reload any open `demo2.eu.ipfabric.io` tab.

### First-time setup (for LLM features only)

The Global Search *Cycle every table* mode and the Diff Dashboard use your
browser session and need no keys. The **LLM Interactive Session**, the *LLM and
MCP Server* search mode, and **CVE Security Status** need credentials — open
Options and provide:

- **IP Fabric MCP Authorization header** — `Bearer <token>` from IP Fabric →
  Settings → Integration → API Tokens (Read/Discovery is enough).
- **Anthropic API key** (or an OpenAI-compatible provider's Base URL/model/key).

Keys are stored only in your browser (`chrome.storage.sync`).

### Pointing at your own IP Fabric instance

This build is scoped to `https://demo2.eu.ipfabric.io`. Edit `manifest.json` and
replace every `https://demo2.eu.ipfabric.io/*` (under `host_permissions` and
**both** `content_scripts[].matches`) with your URL, then reload.

---

## Files

```
ipfabric-combined-extension/
├── manifest.json      MV3 manifest (both content scripts, both commands)
├── background.js      GS service worker + Diff Dashboard command/options relay
├── content.js         Global Search + LLM + CVE content script  (v5.1.0: table catalog reconciled)
├── diff-content.js    Diff Dashboard content script (relabeled; Show-Diff-Dashboard toggle; v5.1.0 catalog)
├── overlay.html/.css/.js   Global Search / LLM / CVE iframe UI  (overlay.js v5.1.0: table catalog reconciled)
├── options.html/.js   merged Options (4 Display toggles + Diff settings)
├── rules.json         Anthropic CORS header rules  (unchanged from v4.0.1)
├── icons/             IP Fabric brand icons
└── README.md
```

## What changed in the merge (and what didn't)

- **Unchanged, byte-identical:** `content.js`, `overlay.js`, `overlay.css`,
  `overlay.html`, `rules.json` — the entire Global Search / LLM / CVE runtime.
- **background.js:** the v4.0.1 worker, plus two additive hooks — the
  `IPFSD_OPEN_OPTIONS` message and the `toggle-diff-dashboard` command both open
  / toggle the Diff Dashboard. GS message routing, LLM/CVE/MCP logic, the
  toolbar action, and the `focus-search` command are untouched.
- **diff-content.js:** the Diff Dashboard, relabeled "Diff Dashboard", now
  honoring the `showDiffDashboard` Display toggle.
- **options.html / options.js:** the v4.0.1 options, plus the *Show Diff
  Dashboard* checkbox and a *Diff Dashboard* settings card. The existing
  save/test flow is unchanged.

## v5.1.0 — table catalog reconciled with IP Fabric webPages

The table definitions used by **Global Search** (`IPF_TECH_PATHS` in `overlay.js`
plus `API_PATH_OVERRIDES` in `content.js`) and the **Diff Dashboard**
(`API_PATH_OVERRIDES` in `diff-content.js`) were reconciled against IP Fabric's
authoritative `webPages.yaml` catalog (350 tables):

- **Coverage:** all 350 current API tables are now reachable (previously 181).
  87 new scan paths were added and 80 existing paths that resolved to dead
  endpoints were corrected to their real API tables.
- **Corrections:** IPv6 Routes now use `/api/tables/networks/ipv6-routes` and
  IPv6 Hosts `/api/tables/addressing/ipv6-hosts` (the old guessed paths are kept
  as fallbacks).
- **Diff on parent pages:** every IP Fabric page path now resolves to one of its
  own tabs, so the Diff Dashboard opens the correct table on pages like
  `/technology/vlans` or `/technology/platforms/fex`.
- These are **data-only** changes (path/override tables). No search, LLM, CVE,
  or Diff logic was modified; all original scan paths and overrides are retained.

## v5.1.1 — Diff Dashboard column list shows every comparable column

The Diff Dashboard's **"Column to compare"** dropdown previously showed only a
subset of a table's columns: for Routes and the VLAN tables it was capped by the
curated per-table list, and for other tables it reflected only the API's
default (omit-columns) projection.

It now lists the table's **complete comparable column set**. Column discovery
(`fetchFirstPage` in `diff-content.js`) asks IP Fabric for the table's full
allowed-column list via the server's own validation enumeration (one invalid
column → the 422 response enumerates every column) and unions it with the
columns that actually appear in returned rows. Internal row-identifier fields
(`id`, `key`, `_id`, `niId`, `siteKey`) are still hidden, since diffing them is
meaningless.

- Scope: **only** the Diff Dashboard's column-discovery path changed. The
  compare engine, snapshot handling, deep links, CSV export, launcher/placement,
  Global Search, LLM, and CVE are byte-identical to v5.1.0.
- Verified: on the Routes table the dropdown now exposes the full column set
  (e.g. `nhCount`, `vrfLeak`, `communities`, `snHw`, …) rather than the former 7;
  VLAN tables likewise show their complete column set.

## v5.1.2 — authoritative column catalog from IP Fabric's OpenAPI spec

v5.1.1's validation-enumeration probe was unreliable on some IP Fabric versions
(e.g. 8.1.7), so the dropdown could still be incomplete — on the Routes table it
was missing `region`, `nhLowestAge`, `nhLowestMetric`, `devLabels` (the "Labels"
column) and `deviceId`, and the `network` field wasn't recognizable as the "Route"
column.

Column discovery now reads IP Fabric's **OpenAPI specification**
(`/api/static/oas/openapi-internal.json`) — the exact catalog the IP Fabric
Python SDK's `get_columns()` uses. For the current table it takes the complete
column list (`x-table.columns[].key` in UI order, unioned with
`requestBody…columns.items.enum`), so the dropdown shows **every comparable
column, in the UI's order**, version-matched to the instance. It is fetched once
per session and cached, with a graceful fallback to the previous discovery if the
spec can't be read.

- **Labels match the UI:** each column is labeled from the OAS column label when
  present, otherwise the rendered table header text, otherwise a prettified field
  name — so `network` now appears as **"Route"**, `devLabels` as "Labels", etc.
- Scope: **only** the Diff Dashboard's column-discovery/label path in
  `diff-content.js` changed. The compare engine, snapshot handling, deep links,
  CSV export, launcher/placement, Global Search, LLM, and CVE are byte-identical
  to v5.1.1.
- Verified against Routes (`tables/networks/routes`: 14 UI columns + `id`) and
  VLAN tables using the version-matched OAS catalog; internal row-id fields
  remain hidden.

## v5.1.3 — match-key chooser + consistent result labels

**Match-key chooser.** The Diff Dashboard matches rows between the two snapshots
by a primary key. Previously that key was auto-derived and fixed, which could be
too coarse (e.g. on MPLS Forwarding it collapsed 48 label entries into ~10
device groups) or surface an unrelated key-column change as an add/remove. The
panel now shows **"Rows matched on: … · auto"** with an **Edit match key** button
that opens a checkbox list of the table's columns. You can pick exactly which
columns form the key (e.g. key MPLS Forwarding on the label columns for a true
per-entry diff), and **Reset to auto** restores the derived default. The compare
column is always excluded from the key; choosing no key compares the column's
values across all rows.

- The chosen key drives row matching, the "Row (…)" headers, the deep links, and
  the CSV export. It resets to the auto default when you change the compare
  column or open a different table.

**Consistent labels.** The "Rows matched on…" line and the results/CSV headers
now use the **same** column labels (OAS → rendered-header → prettified), so a
column reads identically everywhere (e.g. "Route" rather than "Network / Prefix"
in one place and "Route" in another).

- Scope: **only** `diff-content.js` changed; the compare engine, snapshot
  handling, deep links, CSV export, launcher/placement, OAS column discovery,
  Global Search, LLM, and CVE are byte-identical to v5.1.2.

**Version 5.1.3**
