// IndexedDB persistence for the sim world. IndexedDB (never localStorage — that is
// synchronous and blocks the main thread) holds one record: the app's SavedWorld
// envelope (core SaveDocument + UI view model). Structured clone stores the envelope's
// plain arrays/objects directly, so there is no JSON step.
//
// The DB connection is opened once and held for the app's lifetime (module-level
// singleton) rather than per operation: WebKit does not reliably deliver an open()
// request's success event to a page mid-teardown, so a pagehide save that has to open
// the DB from scratch is silently dropped — every lifecycle save was lost this way.
// Reusing an already-open connection turns the pagehide save into a single
// transaction+put with no async open hop, which stands a real chance of completing
// before the page is gone.
//
// Firefox is harsher still: it aborts every IndexedDB write issued from pagehide —
// even a synchronous transaction+put on this already-open connection (verified
// empirically, Jul 2026). There, only the interval autosave and save-on-command
// persist; teardown saves are a WebKit-only best effort.

import type { SavedWorld } from "./sim/world.ts";

const DB_NAME = "fathomrest";
const DB_VERSION = 1;
const STORE = "world";
const KEY = "current";

function openDbOnce(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (): void => {
      req.result.createObjectStore(STORE);
    };
    req.onsuccess = (): void => resolve(req.result);
    req.onerror = (): void => reject(req.error ?? new Error("indexedDB open failed"));
  });
}

// Safari intermittently fails the first open() right after navigation
// ("Connection to Indexed Database server lost"); a retried open typically succeeds.
// Callers must not mistake this transient failure for "no save exists" — see
// loadSavedWorld's caller in PixiReadout.tsx.
async function openDbWithRetry(retries = 2): Promise<IDBDatabase> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await openDbOnce();
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("indexedDB open failed");
}

let dbPromise: Promise<IDBDatabase> | null = null;

function getDb(): Promise<IDBDatabase> {
  dbPromise ??= openDbWithRetry().catch((error: unknown) => {
    dbPromise = null; // let the next caller retry instead of caching a rejected promise
    throw error;
  });
  return dbPromise;
}

export async function loadSavedWorld(): Promise<SavedWorld | null> {
  const db = await getDb();
  return new Promise<SavedWorld | null>((resolve, reject) => {
    const req = db.transaction(STORE, "readonly").objectStore(STORE).get(KEY);
    req.onsuccess = (): void => resolve((req.result as SavedWorld | undefined) ?? null);
    req.onerror = (): void => reject(req.error ?? new Error("indexedDB read failed"));
  });
}

// Guarded write: a document whose epoch is lower than the stored save's is refused.
// Epoch only grows in a live world, so a regression means a stale writer — a second
// tab, an old service-worker-pinned bundle, a fresh world racing a real save — and
// skipping beats clobbering real progress.
export async function writeSavedWorld(saved: SavedWorld): Promise<void> {
  const db = await getDb();
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    let written = false;
    const existing = store.get(KEY);
    existing.onsuccess = (): void => {
      const current = existing.result as SavedWorld | undefined;
      if (current !== undefined && current.doc.epoch > saved.doc.epoch) {
        console.warn(
          `Skipped save: epoch would regress ${current.doc.epoch} -> ${saved.doc.epoch} (stale writer?).`,
        );
        return;
      }
      store.put(saved, KEY);
      written = true;
    };
    tx.oncomplete = (): void => {
      if (written) writeBreadcrumb(saved);
      resolve();
    };
    tx.onerror = (): void => reject(tx.error ?? new Error("indexedDB write failed"));
  });
}

// Preserve an unrestorable save for post-mortem (inspectable in devtools under the
// side key) and clear the main slot so the fresh world's saves aren't refused by the
// epoch guard above.
export async function quarantineCorruptSave(saved: SavedWorld): Promise<void> {
  const db = await getDb();
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    store.put(saved, "corrupt-backup");
    store.delete(KEY);
    tx.oncomplete = (): void => resolve();
    tx.onerror = (): void => reject(tx.error ?? new Error("indexedDB write failed"));
  });
}

// Tiny marker written alongside every successful save. localStorage, deliberately —
// the header's "never localStorage" rule is about the world payload; this is ~60
// bytes at save time. It survives independently of the IndexedDB record, so a boot
// that finds no save can tell "never saved" apart from "save existed and was lost"
// (eviction, corruption, a privacy setting wiping site data).
const BREADCRUMB_KEY = "fathomrest:last-save";

export interface SaveBreadcrumb {
  readonly epoch: number;
  readonly wallTime: number;
}

export function readSaveBreadcrumb(): SaveBreadcrumb | null {
  try {
    const raw = localStorage.getItem(BREADCRUMB_KEY);
    return raw === null ? null : (JSON.parse(raw) as SaveBreadcrumb);
  } catch {
    return null; // diagnostics only — unavailable storage must never break the app
  }
}

function writeBreadcrumb(saved: SavedWorld): void {
  try {
    localStorage.setItem(
      BREADCRUMB_KEY,
      JSON.stringify({ epoch: saved.doc.epoch, wallTime: saved.doc.wallTime }),
    );
  } catch {
    // diagnostics only
  }
}

// Opt the origin out of best-effort storage: without this the browser may evict the
// whole database under quota pressure — a wiped save indistinguishable from "no save
// exists". Firefox may prompt the user once; a denial is logged, not fatal.
export function ensurePersistentStorage(): void {
  if (!("storage" in navigator) || typeof navigator.storage.persist !== "function") return;
  void navigator.storage.persist().then(
    (granted) => {
      if (!granted) {
        console.warn(
          "Persistent storage denied; the browser may evict the save under quota pressure.",
        );
      }
    },
    () => {},
  );
}
