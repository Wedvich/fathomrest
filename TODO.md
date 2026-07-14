# TODO

Living handoff doc: replaced (not appended) at the end of every working session with
the concrete next steps. Long-term plans live in DESIGN.md — this is only "what to
pick up next".

## Done last session

Deferred finding 4 from the deposits review (`SAVE_VERSION` handling): decided
**Option B** — saves stay explicitly unversioned pre-release (no save is persisted
yet). Documented in ADR-0001 §8 that `SAVE_VERSION` bump discipline starts only once
persistence ships; no code change needed. Version-gate test already existed in
`serialize.test.ts`.

Prior session: first real mechanic on branch `deposits` (not yet merged; rebase +
`merge --ff-only` when ready): **deposits with stepped depletion-to-floor tiers**.

- `Deposit` component: ordered richness tiers (`{amount, multiplier}`), then a
  perpetual floor multiplier. Extractors gained a required `depositId`; warehouse
  inflow is now `Σ rate × tierMultiplier`. Empty tier list = pure-floor deposit
  (plain perpetual producer — what the toy chain and app demo use).
- Depletion rate = sum of _actual_ (throttle-adjusted) extractor draws, so a
  pinned-full warehouse with zero pull pauses depletion, and partial pull depletes
  proportionally. DESIGN.md updated to record the stepped-tier form.
- Rescheduling reworked from per-warehouse rederive to a global `deriveAll(state)`
  after every event/command: phase 1 warehouses (regimes from tier multipliers),
  phase 2 deposits (depletion from phase-1 throttles) — dependency order, one pass,
  no fixed-point iteration. `advance()` now moves `epoch` to each event's time before
  handling so re-anchoring never evaluates backwards.
- Event dispatch generalized for a second event-bearing table: new kind
  `deposit-tier-depleted` (priority 0 — rate changes resolve before same-instant
  level crossings), per-kind `isStaleEvent`, per-kind save-document entityId checks.
- Serializer: deposits table with deep-copied tier arrays (no aliasing), tierIndex
  integer/range validation, extractor→deposit referential integrity.
- oxlint `no-restricted-properties` now bans `Math.random` in core (ADR-0001 §5
  follow-up done).
- Determinism scenario extended with a tiered deposit; new integration scenarios for
  tier stepping and pause/resume. `typecheck | test | lint` all green.

## Next session

Per DESIGN.md / TODO step order (litmus-test each mechanic against ADR-0001 §2 first):

1. **Transport routes** as instant rate-capped flows between warehouses ("B pulls
   from A, max X/min"). This turns inflow/outflow into a small dependency graph:
   `deriveAll`'s two-phase pass must become a propagation across connected
   warehouses (a route's actual flow depends on the source's regime, which depends
   on its own inflow…). Watch for the pinned-empty source case — same regime
   treatment as pinned-full. `warehouse.pullRate` likely splits into player-set
   sink pull vs derived route pull.
2. **App wiring**: rAF loop → `advance(t)`/`query(t)` → a placeholder Pixi readout
   once the core surface feels stable. Replace the static demo in `App.tsx`.
   Remember the app re-stamps `state.wallTime` at save time (state.ts contract).

Engine follow-ups (do when they start to matter):

- `deriveAll` is global O(entities) per event/command and re-anchors everything —
  fine at design scale; routes work (above) is the natural point to introduce
  targeted downstream invalidation if it ever shows up in a profile.
- Stale events linger in the heap until their time passes (lazy deletion); the
  serializer filters them. If heap size ever matters during very long offline spans,
  consider periodic compaction — not before.
