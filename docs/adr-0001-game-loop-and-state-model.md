# ADR-0001: Game loop and state model

**Status**: Accepted (2026-07-14)

## Context

DESIGN.md committed to "fixed UPS + event-jump catch-up": a fixed-timestep accumulator
online, analytic event-jumping offline, sharing one math core. Grilling that decision
exposed a latent contradiction: per-tick numeric integration (`amount += rate × dt`) and
closed-form offline solving are _two_ implementations of the same economy — exactly the
math fork DESIGN.md forbids. One had to be the source of truth.

A second question rode along: whether a classic ECS (as in the prior
[empire loop](https://github.com/Wedvich/empire/blob/main/src/core/loop.ts) — rAF,
accumulator, once/fixed/render system phases, interpolation alpha) fits this game.

Reference: [Fix Your Timestep](https://gafferongames.com/post/fix_your_timestep/) — its
fixed-dt-plus-interpolation pattern exists to tame _numeric integration_ (dt-sensitivity
→ fixed dt → discrete state → stutter → interpolation). Remove numeric integration and
the whole chain dissolves.

## Decision

### 1. Pure event-driven analytic core — no fixed timestep

Simulation state between events is a closed-form function of time (piecewise-linear
flows; closed-form decay curves). Discontinuities — warehouse fills, deposit crosses
floor, research completes, voyage decision point — are events with solvable times, held
in a queue.

The core exposes two operations:

- `advance(t)` — pop and apply every event due ≤ t (closed-form state update at each),
  reschedule affected events. Mutates state; usually a no-op per frame.
- `query(t)` — pure read; evaluates amounts/progress at exact time t. Never mutates.

There is no accumulator, no UPS constant, no frame-time clamp, no interpolation alpha.
The renderer evaluates the real continuous function at frame time — strictly smoother
than blending discrete ticks, at any FPS.

**Consequence — one code path for all time gaps.** A 16 ms frame, a background-throttled
tab, a laptop asleep for an hour, and a 3-day absence are the same call: `advance(t)`
with a bigger gap. "Online and offline share one math core" holds by construction, not
by discipline. Offline catch-up is not a mode.

### 2. Litmus test for new mechanics

Every gameplay mechanic must satisfy all four; if not, redesign it (the design already
did this: instant flows, rate caps, shallow chains, no simulated ships):

1. Between events, every quantity has a closed-form `f(t)`.
2. Threshold crossings ("when does it fill/deplete/complete?") are solvable —
   analytically, or by numeric root-find _at scheduling time_ as a last resort.
3. Event count scales with **structural state changes** (jams, completions, commands),
   never with throughput (items produced). Otherwise a long absence is millions of
   events and the tick loop has been rebuilt with extra steps.
4. Randomness is expressed as "sample the time/outcome of the next occurrence and
   schedule it" — never per-item or per-tick rolls.

Forbidden by the test: continuous feedback loops (rate depending on the level it
changes — differential, no closed form; use stepped tiers), per-item RNG (fold into
expected-value rates or next-occurrence sampling), simulated agents, emergent
continuous market dynamics (use scheduled repricing events).

**Saturation is a regime, not an oscillation.** A full warehouse with a consumer still
pulling must not generate block/unblock event churn. Model it as its own piecewise
regime: warehouse pinned at cap, producer throttled to consumer pull rate, deposit
depletion slowed to match (implements DESIGN.md's "full warehouse pauses depletion").

### 3. ECS: entity/component data model, no system scheduler

Classic ECS bundles (a) entities-as-ids + plain-data component tables and (b) systems
iterating component queries every tick. This architecture deletes the tick, so (b) has
nothing to run in — but (a) stands on its own:

- **State** = component tables (`Map<Id, Extractor>`, `Map<Id, Warehouse>`,
  `Map<Id, Route>`, …). Composition-friendly, no class hierarchies, and the IndexedDB
  save document is just the tables serialized — persistence falls out for free.
- **Logic** = pure functions, not tick systems: rate derivation (recompute piecewise
  rates when structure changes), event handlers (`onEvent(state, ev) → patch + new
events`), event schedulers (`nextEvents(state)`).
- **Access boundary**: core code reads/writes tables only through per-table accessor
  modules (get/set/forEach), never raw `Map` operations. Iteration order is owned by
  the table module (deterministic). This localizes any future storage-layout change
  to one module; see docs/browser-performance.md for rationale and limits.

The empire loop's phase machinery (once/fixed/render system arrays) does not carry
over. Its presentation-side ideas (sprite sync, animation) may reappear inside the Pixi
layer, which is free to organize per-frame cosmetic work however it likes — cosmetic
motion uses variable frame dt; dt-sensitivity is irrelevant for things with no gameplay
meaning.

### 4. Clock: trust, but stay sane

- Offline elapsed = `max(0, Date.now() − save.wallTime)` at load — never advance
  backwards.
- While live, sim time advances by `performance.now()` deltas; wall clock is read only
  at load and on visibility-return, so a mid-session system-clock change cannot warp a
  running session.
- No anti-cheat. Single-player, free, no leaderboards; export/import already makes
  saves user-editable by design. Clock-skippers only cheat themselves. No offline caps,
  no plausibility prompts (they false-positive on timezones/DST).

### 5. RNG: seeded, pre-committed

- One seeded PRNG is the only randomness source in the core; its state lives in the
  save document. `Math.random` is banned in the core (untestable, irreproducible).
- Outcomes and random event times are rolled **at scheduling time** and stored as
  scheduled events (expedition rolled at departure; "next storm at T+7382 s" is one
  stored event). Reloading a save rerolls nothing; online and offline replays are
  bit-identical; tests get determinism for free.

### 6. Loop runs on the main thread

rAF drives `frame(now) → sim.advance(t) → render(sim.query(t))`. Background-tab
throttling stops rAF; return is just a bigger `advance()` gap — the offline path.
Per-frame sim cost is µs-scale (events are rare, queries are arithmetic), so a Web
Worker's isolation buys nothing and would make every sim read async with per-frame
structured-clone traffic. Revisit only if profiling ever shows sim cost.

### 7. UI binding: events for structure, sampling for amounts

- **Pixi** reads `query(t)` every frame — smooth continuous values, no interpolation.
- **React panels** subscribe via `useSyncExternalStore` to a version counter bumped
  only when an event fires or a command executes — re-render exactly when structure
  changes. Continuously-varying amounts inside panels re-sample `query(t)` on a coarse
  interval (~4 Hz; per-frame for focal counters).
- No state-library mirror of sim state: the sim is the store. A mirrored copy would be
  stale between syncs and duplicate the state document on every event.

### 8. Persistence: save on command + lifecycle

The sim is deterministic from `(save document, elapsed time)`, so pure idle progress is
**re-derivable** — a crash loses nothing between commands; reload re-advances to the
identical state. The only irreplaceable data is player input. Therefore:

- Save after every player command (post-command, post-rate-recompute — a semantically
  clean point).
- Save on `visibilitychange → hidden` and `pagehide`.
- No periodic autosave timer: it would persist nothing re-advance can't reproduce, and
  can mask determinism bugs.

## Implementation notes

- **Sim time**: double-precision seconds since save epoch. Wall-clock anchor stored
  alongside for computing offline elapsed.
- **Event ordering**: same-timestamp events resolve by a deterministic tiebreak
  (event kind priority, then entity id) so online and offline replay identically.
- **Commands** (build, research pick, outfit expedition, mid-voyage decision) are
  synchronous calls into the core: validate → mutate state → re-derive rates →
  reschedule affected events → bump version → save. Commands are online-only by
  nature; the event queue simply has no next event while a voyage waits on a decision,
  so an absent player's voyage holds at the decision point.
- **Event rescheduling** is the real complexity budget: when an event fires or a
  command lands, downstream rates change and their scheduled events must be
  invalidated/recomputed. The dependency graph stays tractable because refinement
  chains are shallow (1–2 tiers) — a design constraint doing engine work.

## Consequences

- Every mechanic pays a design tax up front: it must pass the litmus test in §2. This
  is the same tax DESIGN.md already levies (rate caps, instant flows) — now with an
  explicit checklist.
- The true one-way door is per-tick feedback coupling across entities. A single
  non-invertible curve can be root-found at scheduling time; continuous mutual feedback
  cannot be retrofitted without reintroducing ticks and forking offline math.
- Determinism is a load-bearing invariant, not a nicety: persistence (§8) and RNG (§5)
  both lean on it. A determinism bug is a data-loss bug; test for it directly
  (e.g. `advance(3 days)` ≡ the same span as thousands of small advances).
