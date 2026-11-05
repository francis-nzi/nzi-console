# NZI — brand & visual foundation (authoritative)

The single source of truth for the NZI look. **Read before any UI, brand, mockup or chart work.** Everything here already exists in the product (`packages/ui/src/styles.css`, `apps/console/public/brand/`); this document names it so nothing is reconstructed from memory. If something here and the code ever disagree, the code wins — and fix this file.

## The logo — never redraw it, use the file

The real logo is a **circular badge with a thin orange outline** holding a **mosaic tree**: foliage of rounded squares in lime and mid greens with **one orange square** as the accent, a **dark forest-green forked trunk**, on a **lime-green ellipse base**. The wordmark reads **"net zero."** in dark forest green with **"international"** beneath it in **orange**.

Canonical assets (served from `/brand/…`):

| File | What it is | Use |
|---|---|---|
| `apps/console/public/brand/netzero-logo.png` / `.webp` | Full lockup (badge + wordmark), drawn for white | Headers, the rail plate, the login surface |
| `apps/console/public/brand/netzero-logo-big-tree.png` / `.webp` | The tree **mark** only | Compact / mark-only placements |

How the app places it (from `styles.css`, decision "BRAND-logo" #420):
- On the **navy rail**, the full lockup sits on a **white rounded plate** (`.nz-brand-plate`, ~148px wide, radius 10, soft shadow) — the lockup is drawn for white.
- On any **dark ground** (collapsed staff rail, admin rail, the login story panel, the portal & account headers) the **mark** sits on a **white disc** (border-radius 50%, 3px padding, soft shadow).
- On white, the lockup needs no plate.

**Rules.** Never hand-draw, re-vector or approximate the logo or the tree mark — reference these files (e.g. `/brand/netzero-logo.webp`). A mockup or any NZI-facing surface uses the real asset. If the asset isn't available in a given context, **stop and get it; do not substitute a drawn version.** Do not recolour it.

## Palette (exact tokens — from `styles.css`)

UI / brand:
- **Emerald `#0BA75E`** — the primary UI green (actions, accent). This is the app's green; use it, not the logo's foliage greens.
- **Deep Pine `#0B7A4B`** · **Midnight `#0B1B2B`** (ink `--t1` and the rail) · **Signal Amber `#FFC24B`** · **Drop Coral `#FF5C48`** · **Mint Tint `#DFF5E9`**.

Surfaces & text:
- Page **Paper `#F6F8F7`** · Card `#FFFFFF` · Lines `#E4EAE7` / `#EDF1EF`.
- Text: `--t1 #0B1B2B` · `--t2 #51605A` · `--t3 #616B65` (muted).
- Rail: `#0B1B2B` (rail) · `#132738` (rail-2) · `#AFC0BC` (rail text).

**Scope identity — brand-locked, never recoloured by rank or state:** Scope 1 **coral `#FF5C48`** · Scope 2 **amber `#FFC24B`** · Scope 3 **emerald `#0BA75E`**. Semantic danger (`#FF5C48` / bg `#FFF7F6`) is kept separate from Scope 1 coral on purpose — never merge them.

> The logo's *own* colours (forest/dark green for "net zero." and trunk, lime greens for foliage, orange for the circle, accent square and "international") are the mark's internal palette. Do **not** substitute them for UI elements, and do not substitute the UI emerald into the logo. Two palettes, two jobs.

## Type, shape, shell
- **Type:** Inter throughout, `system-ui` fallback stack.
- **Radius:** `9px` (`--radius`).
- **Shell:** navy Workspace Rail (236px) · main · right Evidence Drawer (360px). Tokens and components live in `packages/ui` — reuse them; don't re-create `AppShell`, the rail, cards, chips or the drawer.

## Charts
Brand tokens are the single styling source; scope colours as above; one SVG spec renders the same to screen, PDF and portal; charts are derived from data, never captured. Run the dataviz palette validator before adding any categorical colours.
