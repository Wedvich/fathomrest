# CLAUDE.md

**Fathomrest** — browser-based hybrid idle/active game: resource extraction across an archipelago,
paced by a research tree. TypeScript, React + PixiJS, headless simulation core.

## Documents

- [DESIGN.md](DESIGN.md) — canonical design record: core loop, economy, research
  tree, technical architecture, vertical-slice milestone. **Read before making any
  design or architecture decision; update it when a decision changes.**
- [docs/adr-0001-game-loop-and-state-model.md](docs/adr-0001-game-loop-and-state-model.md) —
  event-driven analytic sim core (no fixed timestep), EC data model, clock/RNG/
  persistence rules, and the litmus test every new mechanic must pass.
- [docs/browser-performance.md](docs/browser-performance.md) — browser/engine
  guidance: hot-path allocation rules, shape stability, table access boundary,
  Safari lifecycle, float-determinism caveats. Read before writing core or
  render-loop code.
- Future decision docs (ADRs, balancing notes) live in `docs/` — add them to this
  list as they appear.

## Working in this repo

- [TODO.md](TODO.md) is the session handoff doc. At the end of every working session,
  **replace** its contents (never append) with the concrete next steps, and include it
  in that session's commit. Read it at the start of a session to pick up where the
  last one left off. Next steps only — long-term plans belong in DESIGN.md.

- Design decisions in DESIGN.md are settled unless the user reopens them. Flag
  conflicts between a requested change and the design doc instead of silently
  picking one.
- Simulation logic must stay in the headless core package — pure TS, no React/Pixi
  imports, fully unit-testable. Online ticking and offline catch-up share one math
  core; never fork the math.

## Workspace

Bun workspaces. Runtime is the browser; Bun is build-time only (install, workspace
orchestration). TypeScript 7, ESM throughout.

- `packages/core` — `@fathomrest/core`, the headless sim. Pure TS, zero UI deps
  (an oxlint `no-restricted-imports` rule blocks react/react-dom/pixi.js here).
  Exports its `src/index.ts` directly; consumers transpile it, no build step.
- `packages/app` — `@fathomrest/app`, the React + PixiJS + Vite host. Depends on
  core; core depends on nothing.

Tooling: **oxlint** (lint) + **oxfmt** (format) — no ESLint/Prettier. **Vitest**
for tests (`*.test.ts` colocated with source). TS 7's `tsc` is typecheck-only
(`noEmit` in `tsconfig.base.json`); Vite/esbuild does the actual transpile.
The app typechecks as two programs (`tsconfig.app.json` = browser `src/`,
`tsconfig.tools.json` = `vite.config.ts`) via solution `tsconfig.json` +
`tsc -b`; the root `tsconfig.json` covers `vitest.config.ts`. Keep tooling
configs out of the browser programs — their types leak non-browser globals.

Commands (from repo root):

- `bun install` — install all workspace deps.
- `bun run dev` — Vite dev server (run in `packages/app`, or `bun run --filter '@fathomrest/app' dev`).
- `bun run build` — production build of the app.
- `bun run typecheck` — root config files + both packages.
- `bun run test` — Vitest across the workspace.
- `bun run lint` / `bun run format` — oxlint / oxfmt over the repo.

## Merging

`main` requires **linear history** (enforced by a GitHub ruleset) — a merge commit
can never land on it. Integrate feature branches by fast-forward only:

- Branch off `main` for standalone work (never reuse an unrelated branch).
- Before merging, rebase the branch onto the latest `main` so it fast-forwards
  cleanly: `git rebase main` on the branch.
- Merge locally with `git merge --ff-only <branch>` from `main`, then `git push`.
  No PR is required; SHAs are preserved. A non-FF merge (`git merge` producing a
  merge commit) will be rejected on push.
- Don't use GitHub's PR merge button — its methods either add a merge commit
  (blocked) or rewrite SHAs (rebase/squash). Merge from the CLI instead.
- Push over SSH (the keychain HTTPS token is read-only).
