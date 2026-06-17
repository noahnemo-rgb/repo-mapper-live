# Repo Mapper Static — Changelog

## 2026-06-17 — ONE Multiverse Mode

### Summary
Added a standalone **ONE Multiverse** mode to the static GitHub Pages build. All changes are purely additive; no existing modes were modified.

---

### app-static.js

- **`ONE_MULTIVERSE_RAW`** — inline YAML template literal added after `ONE_UNIVERSE_RAW`, containing the full multiverse manifest (3 universes, 4 structural gaps, HASEOS governance block).
- **`MULTIVERSE_DATA`** — pre-parsed JS object constant (same data as `ONE_MULTIVERSE_RAW`) so multiverse mode requires no YAML parsing at runtime.
- **`CURRENT_MULTIVERSE`** — new state variable (`let CURRENT_MULTIVERSE = null`) added alongside existing state vars.
- **`setMode()`** — extended to handle `'multiverse'`: initialises `CURRENT_MULTIVERSE` from `MULTIVERSE_DATA` and calls `renderMultiverseView()`.
- **Hash routing** — `'multiverse'` added to valid modes array in the `load` event listener.
- **`renderMultiverseView(data)`** — new function that renders into `#multiverseView`:
  - Multiverse header (title, tagline, HASEOS governance badge)
  - Hierarchy breadcrumb (Multiverse → Child Universes → Container Layers → Ecosystems → MVPs/Products)
  - Universe cards grid (maturity chip, reference-impl badge, repo link, gap list)
  - Structural gaps panel (severity-coloured left-border rows: critical / major / minor)
- **`renderUniverse()`** — injects a `hierarchy-breadcrumb` element above the stats row with a clickable "ONE Multiverse →" back-link when a universe is rendered.

### index.html

- `<title>` updated from `Repo Mapper — MultiVerse` to `Repo Mapper — ONE Multiverse`.
- **`<button class="mode-pill" data-mode="multiverse">ONE Multiverse</button>`** added as the first pill in the nav (before Single Repo).
- **`<section class="view" data-view="multiverse" hidden>`** added as the first view section (before Single Repo), containing `<div id="multiverseView"></div>`.

### app.css

- Appended `/* ===== ONE MULTIVERSE MODE ===== */` block (~90 lines) covering:
  - `.multiverse-header`, `.multiverse-title`, `.multiverse-tagline`
  - `.haseos-badge`
  - `.hierarchy-breadcrumb`, `.crumb`, `.crumb--active`, `.crumb-sep`
  - `.universe-cards-grid`, `.universe-card`, `.universe-card--reference`
  - `.universe-card-header`, `.universe-card-name`, `.badge-reference`, `.maturity-chip`
  - `.universe-card-desc`, `.universe-card-repo`
  - `.gap-badge`, `.universe-gap-list`
  - `.section-label`, `.gap-count-badge`
  - `.structural-gaps-panel`, `.structural-gap`
  - Severity modifiers: `.gap-severity-critical/major/minor`
  - `.gap-severity-label`, `.gap-layer`, `.gap-desc`

### New files

- **`multiverse.yaml`** — the YAML source for the ONE Multiverse manifest (same content as `ONE_MULTIVERSE_RAW`).

---

### What was NOT changed

- `one-universe.yaml` — copied unchanged.
- All existing modes (Single Repo, Universe, Scaffold, Gap Dashboard) — untouched.
- No Express/Node.js backend dependencies introduced.
- No `/api/*` fetch calls added.
- Manifest pickers (universe/scaffold/gaps) are unchanged — multiverse is a fully standalone mode.
