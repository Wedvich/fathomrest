---
name: browser-drive
description: Launch and drive the Fathomrest app in headless Chromium — the standard post-commit live verification (dev server + Playwright drive of the storage-upgrade flow + IndexedDB reopen).
---

# Browser drive

The standard "verify what we just did" step after every commit: launches the real app
against the Vite dev server and drives it with Playwright/Chromium, ending with an
IndexedDB persistence reopen. It is a verification harness, not a test suite — Vitest
owns scenario coverage.

## Setup (fail-driven — don't run speculatively)

Just run the drive. If dependencies are missing it fails fast with the fix:

- `bun install` if node_modules is stale (playwright is a devDependency of
  `@fathomrest/app`).
- If the drive exits with "Chromium build missing", run
  `bunx playwright install chromium` from `packages/app`. The command is idempotent —
  it checks `~/Library/Caches/ms-playwright` for the exact build its playwright version
  pins and is a ~1s no-op when present; it only downloads on a fresh machine or after a
  playwright version bump.

## Run

1. Start the dev server in the background from the repo root:
   `bun run --filter '@fathomrest/app' dev` — wait for "Local: http://localhost:5173".
2. `bun run --filter '@fathomrest/app' drive` — the script entry invokes **node**
   (`node scripts/drive.mjs`); do NOT run the driver under bun, Playwright's driver
   misbehaves there. Takes ~25s (most of it real sim-time accrual waiting for the
   storage upgrade to become affordable).
3. Exit code 0 prints `drive PASS`; any failed assertion or console/page error exits 1
   with the reason.
4. **Read the screenshots** in `packages/app/drive-output/` (gitignored):
   `1-before-upgrade.png` (all pools capped /100), `2-after-upgrade.png` (all pools
   /250, stock spent), `3-reopen.png` (caps restored from IndexedDB). A blank frame
   means the app failed to render — treat it as a failure even if assertions passed.
5. Kill the dev server when done.

## What it asserts

Fresh temp profile per run (the 30/30-seed assertions depend on it): storage button
disabled at start → both base extractors built → button enables after ~15s of accrual →
one click advances the label to "→ 500" and disables it again → label stable for ~90
frames → profile reopen restores the rung from IndexedDB → zero console/page errors.

## Caveats and knobs

- Pool readout bars are Pixi **canvas** text — not DOM-assertable. Only the `<button>`
  elements are in the DOM; bar state is verified by looking at the screenshots.
- `DRIVE_URL` overrides the target origin (default `http://localhost:5173/`);
  `DRIVE_PROFILE` reuses a persistent Chromium profile instead of a fresh temp one
  (fresh-world assertions will fail on a used profile — use it for manual poking, not
  the standard drive).
- When a change adds new UI, extend `packages/app/scripts/drive.mjs` to drive it — the
  session that adds a feature should leave the drive covering it.
