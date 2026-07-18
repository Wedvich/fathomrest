# Handoff: Fathomrest UI — core screens (v1 direction)

## Overview

UI design direction for Fathomrest's React panel layer and Pixi HUD overlays, covering the five committed surfaces of the vertical slice:

1. **Island view** — the home screen (design `1a`)
2. **Welcome-back dialog** — offline catch-up summary (design `2a`, standalone content in `1d`)
3. **Research panel** — global timed tree ("star chart", design `3a`)
4. **Island skill tree** — per-island plan ("surveyor's plan", design `3c`)
5. **Archipelago map** — discovery + routes ("captain's chart", design `4a`)

Plus a **UI spec sheet** (`5a`) and **screen map** (`5b`) that consolidate the palette, type, component language, and navigation model. Non-committed alternates (`1b`, `1c`, `3b`, `4b`) are kept in the file as reference — several of their ideas (route table, flow view) are flagged as "later" below.

## About the Design Files

`Fathomrest UI Explorations.dc.html` is a **design reference created in HTML** — a static mock document, not production code. It was authored in a design tool's component format: the real markup is everything between `<x-dc>` and `</x-dc>`, plain HTML with **all styling inline** (no stylesheets). Each design option is a `.dv-opt` block with an id badge (`1a`, `2a`, `3a`, `3c`, `4a`, `5a`, `5b`).

**The task is to recreate these designs in the Fathomrest codebase** (`packages/app`: React + PixiJS, per CLAUDE.md), using its established split: React for panels/trees/dialogs, Pixi canvas for islands/world map. Do not ship the HTML.

## Fidelity

**High-fidelity for layout, color, type, and component treatments** — recreate panel structure, hexes, and typography faithfully. **Placeholder-fidelity for art**: island blobs, building icons, resource monograms, crest, and compass are explicit placeholders (striped fills / letter chips) to be replaced when the art bible lands. All mock data (island names, rates, node names) is illustrative.

## Technical constraints (from the repo, restated)

- React panels are **event-driven**: open/close/click. Live numbers in React panels tick on a coarse timer (≥250 ms), never per frame.
- Live in-canvas readouts (bars filling, timers) update **imperatively in Pixi** — the frame loop must not trigger React re-renders or per-frame allocation.
- The sim core is the source of truth for jam/starvation causality — the UI **renders** the solver's root-cause chain, it never infers it.

## Screens / Views

### 1. Island view (`1a`) — home screen

**Purpose:** the primary play surface. Player sees the island, its slots and deposits (Pixi), and the island's economy in a right dock (React). The returning player's first job — find and fix the jam — starts here.

**Layout:** full viewport, min target 1280×720.

- **Top HUD bar** (React or Pixi-anchored, 52 px tall, full width): ocean chrome gradient `#22414d → #1a323c`, 2 px bottom border `#0d1d23`. Left→right: crest (34 px circle placeholder), game title (Caveat Brush 17 px), divider, current-island resource quick-stocks (chip + `cur/cap` + rate), spacer, **global Knowledge pill**, divider, icon buttons (research ⚗ / map 🗺 / menu, 30 px square, 1 px border `#39525c`).
- **Canvas region** (Pixi): fills remaining space left of the dock. Radial ocean background (`#1e3d49` center → `#132630`).
- **Right dock** (React, 352 px wide, full height under HUD): parchment gradient `#f2e9d4 → #e8dcc3`, 3 px left border `#0d1d23` + inset 3 px `#a08a5f` (brass edge). Sections top→bottom: island header, WAREHOUSE POOLS, DEPOSITS, BUILD.
- **Harbormaster's log** (React overlay, bottom-left of canvas, 390 px wide): dark translucent panel `rgba(16,28,34,.92)`, 1 px border `#39525c`, radius 8.

**Components:**

- **Island header:** island name (Caveat Brush 19 px ink), scope label (`HOME ISLAND · Lv 4`, 11 px, letterspaced, driftwood), right-aligned XP state (`XP paused ⏸` when jammed).
- **Warehouse pool row** (one per resource on the island — one pool per resource per island, always):
  - label row: resource chip (17 px rounded square, resource color, white monogram) + bold name + `cur / cap` (tabular) + rate or JAM tag
  - bar: 13 px tall, track `#dfd2b2`, 1 px border `#8a744a`, radius 3; fill = vertical gradient of the resource color
  - **jammed state:** bar 100% full with a 3 px right cap-stripe `#b5563d`, `JAM` tag (rust bg, white, 10 px 800), sub-line in rust: `+0.0/s — accumulation blocked · deposit paused`
  - outflow to a converter shown as a driftwood sub-line: `−0.2/s → Refinery (iron ingot)`
- **Deposit card:** parchment-darker card (`#efe4c9`, border `#cbbf9e`): name + richness badge (`×2.0` on heartwood `#5a4a30`, sailcloth text) + `remaining / total`; 7 px reserve bar; sub-line with pause state, next richness step, and floor: `⏸ paused by jam · steps to ×1.5 after 920 more · floor ×0.25`.
- **Build card:** icon placeholder (34 px), name (13 px bold), **cost chips** (one per cost resource: `40 wood ✓` on `#dfd2b2`; unaffordable: `120 — need 32` on `#eecfc3`, border `#cf8f79`, text `#a04a33`, bold), Build button. Affordable card: border `#a08a5f`, gold primary button. Unaffordable: muted bg `#e9dec4`, dashed-feel border `#cbbf9e`, disabled gray button, and when computable a moss ETA line: `affordable in ~23s at current rate`. Buildings that feed the global pool get a violet suffix tag `→ GLOBAL K`.
- **Pixi HUD elements** (imperative layer): slot markers — occupied: 56 px square, `#5a4a30` fill, 2 px `#c9a856` border, radius 6; empty: 52 px, 2 px dashed `rgba(255,255,255,.5)`, radius 8, centered `+`. **JAM badge** anchored to a blocked building: pill, `#b5563d` bg, 1 px `#7e3423` border, white 10 px 800, `JAM ⛔`. **Deposit badge:** dark pill `rgba(20,32,26,.85)`, 1 px border in resource color, chip + `Pine stand ×2.0`. **Slot tooltip** (React, on hover): parchment card, title (Caveat Brush 13 px), adjacency line (`Adjacency: next to Iron seam. A Delver here gains +15% yield.` — the bonus in Current teal, bold).
- **Harbormaster's log:** title (Caveat Brush 14 px, gold `#e3cd8a`) + count (`2 jams · 1 notice`, mist). Rows: 8 px severity dot (rust `#e0846a` = jam, gold `#c9a856` = notice), 12.5 px text with bold subject + duration, right-aligned outline action button (1 px `#c9a856`, gold text). Ordered: root causes first.

### 2. Welcome-back dialog (`2a`; content detail in `1d`)

**Purpose:** re-entry summary after ≥15 min away. Turns "you were away" into a triage starting point.

**Behavior:** modal over whichever map view loads; the view behind is dimmed `rgba(8,16,20,.62)` + slight blur, sim paused until dismissed. ✕ top-right. **Fix buttons deep-link**: close dialog → navigate to the bottleneck (island view, camera on the jammed building/pool) with the fix menu open.

**Layout:** centered parchment sheet, 560 px wide, radius 8, heavy shadow, padding 22/26. Sections:

- **Header** (centered, 36 px side padding so the ✕ never collides): `Welcome back, Harbormaster` (Caveat Brush 22 px), sub-line `Since you were last active — 6h 24m ago:` (12.5 px driftwood).
- **GAINED WHILE AWAY:** row of equal cards, one per resource with offline gains: chip, `+112` (16 px 800), status sub-line — `hit cap after 1h 40m` (rust) / `still flowing` (moss) / `global · at cap` (violet). Gains are bounded by caps; the status line is the honest part — always show _when_ it capped.
- **FINISHED:** research completions row (⚗ + name + effect), `queue now empty` right-aligned.
- **⛔ THE JAM WAITING FOR YOU** (label in rust): numbered rows, root causes first, each with a colored action button — `Fix` (rust) for jams, `Spend` (violet `#5c4f96`) for knowledge-at-cap, `Later` (outline) for notices.
- **Footer:** primary gold `Unpick the jam →` + secondary outline `Just look around` (nowrap).

### 3. Research panel (`3a`) — "star chart"

**Purpose:** the global, cumulative, timed research tree. Order is the strategy; knowledge + expedition samples pace it.

**Visual identity:** entirely in the **Scholar-violet global language** — bg radial `#221c3d → #141126`, panel borders `#322a55`, so it can never be confused with island-scoped UI.

**Layout:** full-screen overlay. Rows top→bottom:

- **Header** (border-bottom `#322a55`): `Research` (Caveat Brush 20 px, `#cfc4ef`) + label `GLOBAL · CUMULATIVE` + spacer + Knowledge pill + ✕.
- **Queue strip** (`QUEUE 2/2`): slot 1 = active node card (violet border `#6a5c9e`, name + progress bar `#8d7fc4 → #b3a6e0` + `41m left ⏱`); slot 2 = queued card (**dashed** border `#4a3f7a`, `paid ✓ · banked past cap`). Note text: timers run offline (the one blessed exception).
- **Body:** left **SELECTED detail column** (300 px, border-right): selected node card with name (Caveat Brush 16 px), effect description, `COST — PAID UPFRONT` chips (knowledge chip with round violet icon; **sample gates** as rust chips `🝆 Kraken chitin ×1`), research time, and a state-dependent action: gold `Queue` / disabled `Sample missing — sail for it` / violet `Open research`-style. Right: **tree canvas** — tier columns (`TIER I…IV`, 10 px letterspaced labels) with `→` connectors.

**Node card states** (violet card `#221c3d`, radius 7, 12 px title, nowrap):

| state         | treatment                                                                               |
| ------------- | --------------------------------------------------------------------------------------- |
| researched    | border `#8d7fc4`, opacity .75, moss ✓, sub-line "researched"                            |
| researching   | border `#b3a6e0` + violet glow, 5 px progress bar, `41m ⏱`                              |
| queued        | bg `#1b1731`, **dashed** border `#6a5c9e`, `QUEUED` tag, `paid ✓`                       |
| affordable    | border **gold** `#c9a856`, cost chip with ✓, gold `Queue` button                        |
| sample-gated  | rust `🝆 SAMPLE` tag; detail shows the missing sample chip                               |
| too expensive | bg `#1b1731`, border `#322a55`, dim text; cost in rust; hint `over cap — queue to bank` |
| future tier   | same + column at opacity .5                                                             |

### 4. Island skill tree (`3c`) — "surveyor's plan"

**Purpose:** per-island progression: shared trunk → **exclusive research-gated junction** → branches. Nodes cost island-local stock (no skill points); levels gate when, stockpiles gate whether.

**Visual identity:** full **parchment** (`#f4ecd9 → #e8dcc3`), ink text — deliberately the opposite of research's violet.

**Layout:** full-screen overlay. Header: `<Island> — Island plan` (Caveat Brush 20 px, nowrap) + `PER-ISLAND · Lv 4` + **XP bar** (180 px, Current-teal fill `#3d7a8c → #58a3b5`, `XP 450/1,000` tabular) + paused state in rust (`⏸ paused — island jammed`) + note `nodes cost island stock` + ✕.

Vertical flow, centered, connected by 2 px `#a08a5f` stems:

- **Trunk row:** 3 cards (210 px). Bought: border `#8a744a`, opacity .8, moss ✓. Purchasable: 2 px gold border, cost chips (wrap allowed, chips nowrap), level requirement top-right (`Lv 3 ✓`).
- **Junction block** (640 px, 2 px `#8a744a` border, floating heartwood ribbon tag **`EXCLUSIVE JUNCTION — PICK ONE, PERMANENT`**): two identity cards separated by a hand-written "or". Available identity: 2 px Current-teal border, name in Caveat Brush teal, effect text, cost chip + gold `Commit`. Research-locked identity: dashed brass border, dimmed, violet lock pill **`🔒 RESEARCH: ISLAND CHARTERS`** (the one-way research→island gate). Warning line below in rust: `⚠ a wrong pick costs one island, not the save`.
- **Branch columns** (Extraction / Refinement): column label letterspaced (available branch label in teal); node cards 166–340 px with level gates; the branch locked behind the junction renders at opacity .55 with dashed borders.

### 5. Archipelago map (`4a`) — "captain's chart"

**Purpose:** the between-islands layer: discovered islands, transport routes with live rates, discovery rings, expedition rumors.

**Layout:** full-screen Pixi scene styled as a parchment sea chart (radial `#efe6cf → #e3d5b4`), with React overlays.

- **Rings:** concentric dashed circles (2 px `#c0ae87`) centered on home; labels on the line (`RING I — HOME WATERS`, `RING II — CHARTED BY CARTOGRAPHY II`, 10 px 800 letterspaced brass, parchment-bg chip). Beyond the last ring: hatched fog band + handwritten note `uncharted — Cartography III`.
- **Islands:** blob placeholder (biome-tinted stripes, 2 px ink border; home gets 3 px gold border + gold halo), **name banner** below (heartwood bg `#5a4a30`, sailcloth text, radius 4, shadow; home prefixed `⌂`; jam-count pill `2⛔` rust), sub-label `HOME · Lv 4 · XP ⏸` (10 px letterspaced driftwood).
- **Routes:** lines between islands. Flowing: `#3d7a8c`, 3 px, long dash. Starved/jammed: `#b5563d`, 3 px, tight dash. Each route carries a **rate chip** at its midpoint (parchment pill, nowrap): resource chip + `6 / 8·min` + status (`flowing →` moss / `STARVED` rust 800; border matches status).
- **Rumor markers:** 34 px dashed brass circle with handwritten `?`, italic caption quoting the rumor (`"iron-red water" 🝆` — 🝆 hints a sample source).
- **Route popover** (React, on route click, 250 px parchment card): `A → B` title (nowrap) + resource chip; body `Stone · cap 12/min · flowing 0` + causal line **`Source jammed: Stone full on Greyhollow — the route isn't the bottleneck.`** (the popover always names the true cause); actions: gold `Fix source` (deep-link) + outline `Raise cap` / `Delete`.
- **Bottom toolbar** (58 px, ocean chrome like the HUD): fleet name (Caveat Brush gold), counts (`3 islands · 2 routes · 2 rumors`), spacer, outline `＋ New route` (with the no-cycles hint), primary gold `⛵ Outfit expedition`.
- **Compass rose:** placeholder circle, top-left.

**Navigation:** click island → island view (1a). Toolbar ⛵ → expedition UI (not yet designed).

## Interactions & Behavior

- **Jam propagation is always actionable:** every surface that states a jam offers the fix (log rows → View/Spend; triage → Upgrade warehouse; route popover → Fix source; dialog → Fix). Root causes are labeled/ordered first; symptoms (starved pools, dry routes) point at their cause by name.
- **Deep links:** log/dialog/popover fix actions navigate to the island view, focus the offending entity, and open its action menu.
- **Panels** (research, island plan) are full-screen overlays with ✕ and (recommended) Esc; opened from the HUD ⚗ / Knowledge pill and the island header Lv/XP respectively.
- **Welcome-back dialog** only after ≥15 min away; sim resumes on dismiss.
- Hover states were not designed in detail: recommended default = 1 px border brightening + slight bg lift, no motion. Transitions ≤150 ms ease-out. No idle animations in React panels (perf rule); bar-fill motion lives in Pixi.
- **Later (designed, not committed):** Flow view overlay (`1c`, toggle F) and logistics route table (`4b`, toggle L) — keep their affordances in mind but don't build yet.

## State Management

All display state derives from the sim core (`query(t)`), read event-driven + coarse timer:

- per island: pools (`cur/cap`, net rate, jam flag, block reason), deposits (reserve, richness tier, paused flag, next-step ETA, floor), buildable list with cost-vector affordability (+ ETA when rates allow), XP (value, level, paused-by-jam flag)
- global: knowledge (`cur/cap`, at-cap flag), research (active node + progress + ETA, queue slots, per-node state incl. sample gates), offline summary (away duration, per-resource gains + cap-hit times, completions, ranked jam list with root-cause chains)
- routes: per route `flow/cap`, status (flowing / starved / dry-source / jammed-dest) with cause reference
- UI-local: selected island, open panel, selected research node, selected route, dialog visibility.

## Design Tokens

**Type** (Google Fonts):

- Headings/flavor: **Caveat Brush** 400 — screen titles, island names, panel titles, handwritten notes. Always `white-space:nowrap`.
- Body/data: **Playpen Sans**, variable `wght 300–800` — everything else. Data uses `font-variant-numeric:tabular-nums`, 12–14 px. Playpen Sans is wide: keep short status chips/titles nowrap.
- Section labels: 10–11 px / 800 / +1.2 px tracking / uppercase / driftwood `#7a6a4c` (parchment) or mist-violet `#8d7fc4`/`#7d949c` (dark).

**Parchment ramp** (island-scoped surfaces): Sailcloth `#f4ecd9` · Parchment `#e8dcc3` · Aged fold `#dfd2b2` · Deck shadow `#cbbf9e` · Brass edge `#a08a5f` · Driftwood `#7a6a4c` · Heartwood `#5a4a30` · Ink `#3a2f1f`. Card bg `#efe4c9`; muted/disabled card `#e9dec4`.

**Ocean chrome ramp** (HUD, canvas surround): Abyss `#0d1d23` · Deep water `#14282f` · Harbor slate `#1a323c` · Shoal `#22414d` · Tide line `#39525c` (alt `#2c4a56`, `#3d5a66`) · Mist `#7d949c` · Foam `#9db4bc` · Moonlight `#dfe8e5`.

**Accents:**

- Ship's brass (primary actions, home marker): `#c9a856`, hi `#d8b96a`, deep `#8a744a`, text-on-dark `#e3cd8a`
- Current (flowing, XP, positive structure): `#3d7a8c`, `#58a3b5`, `#8fc7d6`; ink-side `#2a5c6b`
- Jam rust (**only** meaning: blocked/full): `#b5563d`, light `#e0846a`, deep `#7e3423`; on parchment `#a04a33`, tint bg `#eecfc3`/`#f0ded1`, tint border `#cf8f79`
- Amber (symptoms, warnings, trickle floors): `#c98a3d`, light `#e8b56a`, ink-side `#8c6b3d`
- Moss (flowing rates, affordable ✓): `#527a3b`, light `#9fc48f`
- Scholar violet (**GLOBAL scope only** — knowledge, research): core `#5c4f96`, `#8d7fc4`, light `#b3a6e0`, pale `#cfc4ef`, bg `#221c3d`/`#1b1731`/`#141126`, border `#322a55`/`#4a3f7a`/`#6a5c9e`, icon radial `#b3a6e0 → #5c4f96`

**Resource colors** (placeholder chips: rounded square, white monogram, 700): wood `#8a6b3f` W · stone `#8c8c86` S · iron ore `#7a8a99` Fe · iron ingot `#5f7d8c` Ig · knowledge = **circle**, violet radial, K.

**Radii:** bars 3 · chips/buttons 4–5 · cards 5–7 · panels 8 · pills 10–20. **Bar heights:** 13 px (dock), 9 px (tables), 7 px (deposits), 5 px (micro).

**Hard rules:**

1. Island-scoped = parchment/ink; global = violet + round icon — knowledge is never rendered as an island bar.
2. Rust means blocked, nowhere else. Symptoms are amber. Root causes get the `ROOT` tag.
3. One bar per resource per island, everywhere.
4. Every jam surface offers the fix, not just the fact.
5. Buildings = parchment cards with cost vectors; skill nodes = bordered plan boxes — two visually distinct kinds of upgrade.
6. Missing costs always state the shortfall (`need 32`) and, when knowable, the ETA.

## Assets

No real assets exist yet — everything visual is a placeholder by design (striped blobs for islands/biomes, striped squares for building icons, letter monograms for resources, drawn circle for crest/compass). The art bible (parchment/ocean ramps above are its UI foundation) will replace these; layouts are placeholder-agnostic.

Fonts: Google Fonts — `Caveat Brush` and `Playpen Sans:wght@300..800`.

## Files

- `Fathomrest UI Explorations.dc.html` — the full exploration document. Committed designs: sections tagged `1a`, `2a` (+`1d`), `3a`, `3c`, `4a`, and the spec sections `5a`/`5b`. Alternates kept for reference: `1b` (dense IA), `1c` (flow view), `3b` (research ledger), `4b` (logistics mode).
