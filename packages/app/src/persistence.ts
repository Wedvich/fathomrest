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

export async function writeSavedWorld(saved: SavedWorld): Promise<void> {
  const db = await getDb();
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(saved, KEY);
    tx.oncomplete = (): void => resolve();
    tx.onerror = (): void => reject(tx.error ?? new Error("indexedDB write failed"));
  });
}
