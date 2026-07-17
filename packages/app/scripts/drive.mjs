// Post-commit live drive: headless Chromium against the dev server, walking the storage-upgrade
// flow end-to-end (fresh world -> build base economy -> buy the knowledge observatory -> buy
// storage rung 1 -> IndexedDB reopen).
// A verification harness, not a test suite — Vitest owns scenario coverage. Pool readout bars are
// Pixi CANVAS text and cannot be asserted from the DOM: assertions target the <button> elements;
// screenshots capture the bars for visual inspection.
//
// Run with node (Playwright's driver misbehaves under bun): `bun run drive` from packages/app
// (the script entry invokes node). Requires the dev server to be running (`bun run dev`).
//
// Env knobs:
//   DRIVE_URL      target origin (default http://localhost:5173/)
//   DRIVE_PROFILE  Chromium profile dir to reuse; default is a fresh temp profile per run,
//                  which the fresh-world assertions (30/30 seed) depend on.
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const BASE_URL = process.env.DRIVE_URL ?? "http://localhost:5173/";
const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "drive-output");
const ephemeralProfile = process.env.DRIVE_PROFILE === undefined;
const profile = process.env.DRIVE_PROFILE ?? mkdtempSync(join(tmpdir(), "fathomrest-drive-"));

const pageErrors = [];

function wire(page) {
  page.on("console", (m) => {
    if (m.type() === "error") pageErrors.push(`console: ${m.text()}`);
  });
  page.on("pageerror", (e) => pageErrors.push(`pageerror: ${e.message}`));
}

function assert(cond, msg) {
  if (!cond) throw new Error(`drive assertion failed: ${msg}`);
}

async function open() {
  const ctx = await chromium
    .launchPersistentContext(profile, {
      headless: true,
      viewport: { width: 900, height: 900 },
    })
    .catch((error) => {
      if (/Executable doesn't exist/i.test(String(error))) {
        throw new Error(
          "Chromium build missing — run `bunx playwright install chromium` from packages/app " +
            "(idempotent: no-op when the build is already cached).",
        );
      }
      throw error;
    });
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  wire(page);
  try {
    await page.goto(BASE_URL);
  } catch (error) {
    throw new Error(
      `could not reach ${BASE_URL} — is the dev server running? (bun run --filter '@fathomrest/app' dev)\n${error}`,
    );
  }
  return { ctx, page };
}

async function storageButton(page) {
  const btn = page.getByRole("button", { name: /home storage/ });
  await btn.waitFor({ timeout: 15_000 });
  return btn;
}

// Wait until a button whose label contains `text` is present and enabled.
async function waitEnabled(page, text, timeout = 45_000) {
  await page.waitForFunction(
    (needle) => {
      const btn = [...document.querySelectorAll("button")].find((b) =>
        b.textContent?.includes(needle),
      );
      return btn !== undefined && !btn.disabled;
    },
    text,
    { timeout },
  );
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });

  // --- Session 1: fresh world — build the base economy, buy the first storage rung ---
  const { ctx, page } = await open();
  const storage = await storageButton(page);

  const startLabel = await storage.textContent();
  assert(
    /Upgrade home storage → 250/.test(startLabel ?? ""),
    `fresh-world label, got "${startLabel}"`,
  );
  assert(await storage.isDisabled(), "storage button disabled at the 30/30 seed");

  await page.getByRole("button", { name: /Build extractor · Wood A vein/ }).click();
  await page.getByRole("button", { name: /Build extractor · Stone A vein/ }).click();
  await page.screenshot({ path: join(OUT_DIR, "1-before-upgrade.png") });

  // The knowledge observatory (the first global-scoped resource) is cost-gated only: 40 wood + 40
  // stone, unaffordable at the 10/10 the base builds leave behind.
  const observatory = page.getByRole("button", { name: /Build extractor · Knowledge deposit/ });
  await observatory.waitFor({ timeout: 15_000 });
  assert(await observatory.isDisabled(), "observatory disabled before the base economy funds it");

  // Base extractors produce 2/s each; 40/40 is reachable from 10/10 by ~t=15.
  await waitEnabled(page, "Build extractor · Knowledge deposit");

  // Buy the observatory first: it drains the 40/40, so the storage rung (also 40/40) must wait for
  // a second accrual — a live check that the observatory is paid from the home pools, not the
  // global knowledge pool it fills.
  await observatory.click();
  // The button's label flips to the built state, so re-locate by the new name rather than
  // reusing the pre-build locator (which no longer matches).
  await page
    .getByRole("button", { name: /Knowledge deposit — extractor built/ })
    .waitFor({ timeout: 5_000 });
  await page.screenshot({ path: join(OUT_DIR, "2-observatory-built.png") });

  // Storage rung 1: re-accrue to 40/40 after the observatory spent the stock, then upgrade.
  await waitEnabled(page, "Upgrade home storage");
  await storage.click();
  await page.waitForTimeout(600);
  const afterLabel = await storage.textContent();
  assert(/→ 500/.test(afterLabel ?? ""), `ladder advanced to → 500, got "${afterLabel}"`);
  assert(await storage.isDisabled(), "storage button disabled again after spending the stock");
  await page.screenshot({ path: join(OUT_DIR, "3-after-upgrade.png") });

  await page.waitForTimeout(1_500); // ~90 frames: the label must not thrash
  assert((await storage.textContent()) === afterLabel, "label stable after the upgrade");
  await ctx.close();

  // --- Session 2: reopen the same profile — IndexedDB restore + offline catch-up ---
  const { ctx: ctx2, page: page2 } = await open();
  const storage2 = await storageButton(page2);
  await page2.waitForTimeout(1_000);
  const reopenLabel = await storage2.textContent();
  assert(/→ 500/.test(reopenLabel ?? ""), `restored rung after reopen, got "${reopenLabel}"`);
  await page2.screenshot({ path: join(OUT_DIR, "4-reopen.png") });
  await ctx2.close();

  assert(pageErrors.length === 0, `no console/page errors, got:\n${pageErrors.join("\n")}`);
  console.log(`drive PASS — screenshots in ${OUT_DIR}`);
}

try {
  await main();
} catch (error) {
  console.error(String(error instanceof Error ? error.message : error));
  process.exitCode = 1;
} finally {
  if (ephemeralProfile) rmSync(profile, { recursive: true, force: true });
}
