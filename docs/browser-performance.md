# Browser performance & engine guidance

Guidance doc, not an ADR: no decisions here, only constraints and habits that keep the
game fast and low-memory-pressure in real browsers. Assumes the architecture in
[ADR-0001](adr-0001-game-loop-and-state-model.md) (event-driven analytic core, EC
tables, rAF main-thread loop, IndexedDB persistence). If a rule here conflicts with an
ADR, the ADR wins — flag it.

## Where the hot path actually is

`advance(t)` is usually a per-frame no-op; events are rare by design (litmus test §2.3).
The per-frame cost is **`query(t)` evaluated for every visible entity by the Pixi
layer**, ~60×/s. All allocation and monomorphism discipline concentrates there.

- `query(t)` must not allocate: return primitives, or write into caller-owned scratch
  objects/arrays that the render layer reuses across frames. Never build per-entity
  result objects per frame.
- No closures, spreads, `.map()/.filter()`, destructuring-into-new-objects, or
  template-string formatting inside the frame loop. Plain indexed `for` loops
  (iterator protocol allocates per step; V8 often escape-analyzes it away, JSC less
  reliably — indexed loops are the neutral-worst-case choice).
- Number formatting for display is not free: cache formatted strings per counter and
  reformat only when the _displayed_ (rounded) value changes, not every frame.

**Health check**: Chrome DevTools → Performance with Memory enabled. With the game
idle (no events firing), the minor-GC sawtooth should be near-flat. Churn while
nothing happens means something in the frame path allocates.

## Component objects: stable shapes

EC tables are `Map<Id, Component>` (ADR-0001 §3). Small entity counts make this the
right layout — but each component type must keep one hidden class / shape:

- Create every component through one factory that initializes **all** fields, in the
  same order, including optionals (use `0` / `-1` / `null` sentinels, not absent
  fields).
- Never `delete` a property; never add one after creation. Evolve by replacing the
  whole component object (also plays well with patch-style event handlers).
- No getters/setters, no `arguments`, no `eval`/`with` in core code — all three
  engines deoptimize on these.
- Numeric fields hold doubles. In stable-shaped objects V8 stores them unboxed; that
  is the whole reason shape stability matters for an economy sim where nearly every
  field is a `number`.

This is the cheap, engine-neutral 90% of "data-oriented design" — typed-array SoA is
**not** warranted at this entity scale and would fight the Map-table save model
(structured-clone persistence, patch-style handlers, deterministic iteration order).

### Table access boundary (the door to SoA, never the SoA)

Core code never touches raw `Map`s. Each component table lives behind a small module
exposing typed accessors:

- `getWarehouse(state, id)` / `setWarehouse(state, id, component)` (or patch-apply)
- `forEachWarehouse(state, fn)` / `warehouseIds(state)` — iteration only through
  these, so iteration order is owned by the table module (spec-guaranteed `Map`
  insertion order today), keeping determinism replay-safe.
- Creation goes through the factory (stable shape) and registration in one call;
  deletion through one function — no ad-hoc `map.set`/`map.delete` at call sites.

Rationale: this costs almost nothing now and localizes a future storage-layout change
(e.g. giving _one_ oversized numeric table an SoA arena) to a single module instead of
a codebase-wide refactor. It is insurance, not a plan: do not build index arenas,
generational ids, or swap-remove until a profiler shows table access as a cost — at
current design scale (hundreds of entities, no per-tick systems) it will not.

## Event queue

- Binary min-heap over a preallocated array (grow geometrically, never shrink), keyed
  by `(time, kindPriority, entityId)` per ADR-0001's deterministic tiebreak. No
  re-sorting arrays on insert.
- Rescheduling invalidates events; prefer lazy deletion (mark stale, skip on pop) over
  heap removal — simpler and allocation-free, fine at these event volumes.
- Event objects themselves may allocate (they're rare, structural); do not pool them
  prematurely.

## Determinism and floating point

Determinism is load-bearing (ADR-0001 §5, §8, Consequences). Two float rules keep it
true:

1. **Always evaluate `f(t)` from the last event's anchor** — absolute closed form,
   never incremental accumulation between queries. Incremental accumulation makes
   `advance(3 days)` diverge from thousands of small advances, which the determinism
   test must catch.
2. **Cross-engine caveat**: `+ − × ÷` and `Math.sqrt` are bit-identical everywhere
   (IEEE 754). `Math.pow/exp/log/sin/…` are **not** guaranteed identical across
   V8/SpiderMonkey/JSC. Within one browser, saves re-derive exactly; a save exported
   from Chrome and imported in Safari may re-derive with ulp-level differences if
   decay curves use transcendental functions. If bit-identical cross-browser replay
   ever becomes a requirement, restrict curves to arithmetic-closed forms or ship a
   deterministic approximation. Until then: known, accepted, documented here.

## Timers, tabs, and lifecycle (the Safari section)

iOS WebKit policy makes every iOS browser JavaScriptCore + Safari lifecycle rules —
assume a large slice of idle-game sessions live there.

- rAF stops in background tabs; `setInterval` clamps to ≥1 s (worse when hidden).
  The architecture already treats return-from-background as a big `advance()` gap —
  keep it that way; never add a catch-up loop or a background heartbeat timer.
- Save on `visibilitychange → hidden` and `pagehide` (ADR-0001 §8). Do **not** rely
  on `beforeunload`; iOS frequently never fires it.
- Handle `pageshow` with `event.persisted === true` (back-forward cache): the page
  resumes with live JS state but stale sim time. Treat it like visibility-return —
  re-read the wall clock, `advance()`, re-render.
- iOS can evict a background tab outright at a few hundred MB of memory. Low
  steady-state heap is a survival requirement there, not just a GC-pause nicety.
- `performance.now()` is coarsened in Safari (~1 ms or worse for fingerprinting
  mitigation). Fine for frame deltas; never build logic assuming sub-ms resolution.
- The 4 Hz panel re-sampling interval (ADR-0001 §7) also throttles when hidden —
  harmless, since panels aren't visible; just don't attach sim-meaningful work to it.

## React binding pitfalls

- `useSyncExternalStore`'s `getSnapshot` must return the **same reference** until the
  version counter bumps — cache the snapshot against the version, or React loops.
- The coarse amount re-sampling happens _inside_ components (local interval → local
  state), never by bumping the store version — the version counter means "structure
  changed" and nothing else.
- Keep Pixi objects out of React state and vice versa. Pixi holds long-lived display
  objects updated in place from `query(t)`; React owns panels. Rebuilding display
  lists or DOM per frame is the classic idle-game memory leak (detached nodes,
  orphaned listeners).

## Persistence formats

- IndexedDB structured clone serializes `Map` natively — component tables persist
  as-is. Writes are async and off the main thread's critical path (never use
  localStorage for saves; it's synchronous).
- JSON export/import (and future cloud sync) cannot represent `Map` directly. The
  canonical wire format is tables as arrays of `[id, component]` entries; define one
  serializer used by both export and (future) sync so the schema never forks.
- Serialize once per save, whole document — no per-property writes, no debounced
  partials. Saves are rare (per command + lifecycle), so size is not a concern.

## TypeScript-level habits (core package)

- `const enum` or string-literal unions instead of regular `enum` (which compiles to
  a runtime object).
- `interface` + factory functions for components, not classes — matches the EC model
  and avoids method-bearing instances in tables.
- Avoid optional chaining / nullish coalescing in the innermost `query` math on
  fields that are structurally always present — model "not present" with sentinels in
  the stable shape instead. Elsewhere, use them freely.
- Strict mode already enforced; additionally treat `any` in the core as a review
  flag — untyped values are how mixed-shape objects sneak into hot paths.

## What NOT to optimize

- No object pooling for events, commands, or component patches — they scale with
  structural changes, not throughput, by litmus-test construction.
- No Web Worker for the sim (ADR-0001 §6) — revisit only on profiler evidence.
- No typed-array/SoA rewrite of the EC tables at current entity scale. The table
  access boundary above is the only concession; if one table ever grows huge and
  purely numeric (e.g. mass-generated trickle-islands in far expedition rings), give
  _that table_ an SoA layout inside its module — never convert the architecture.
- No manual memoization webs in React panels before measuring; version-gated
  re-render already bounds them.

## Test-rotation note

Develop in Chrome, but test in Safari (real iOS device if possible) early and
regularly. V8 is the most forgiving engine and Chrome the most forgiving lifecycle;
smooth-in-Safari implies smooth everywhere. The reverse is false.
