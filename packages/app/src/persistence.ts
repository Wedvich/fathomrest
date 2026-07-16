// IndexedDB persistence for the sim world. IndexedDB (never localStorage — that is
// synchronous and blocks the main thread) holds one record: the app's SavedWorld
// envelope (core SaveDocument + UI view model). Structured clone stores the envelope's
// plain arrays/objects directly, so there is no JSON step. The DB handle is opened per
// operation rather than held for the component's lifetime — writes are infrequent
// (autosave + lifecycle events), so the open cost is irrelevant and nothing leaks.

import type { SavedWorld } from "./sim/world.ts";

const DB_NAME = "fathomrest";
const DB_VERSION = 1;
const STORE = "world";
const KEY = "current";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (): void => {
      req.result.createObjectStore(STORE);
    };
    req.onsuccess = (): void => resolve(req.result);
    req.onerror = (): void => reject(req.error ?? new Error("indexedDB open failed"));
  });
}

export async function loadSavedWorld(): Promise<SavedWorld | null> {
  const db = await openDb();
  try {
    return await new Promise<SavedWorld | null>((resolve, reject) => {
      const req = db.transaction(STORE, "readonly").objectStore(STORE).get(KEY);
      req.onsuccess = (): void => resolve((req.result as SavedWorld | undefined) ?? null);
      req.onerror = (): void => reject(req.error ?? new Error("indexedDB read failed"));
    });
  } finally {
    db.close();
  }
}

export async function writeSavedWorld(saved: SavedWorld): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(saved, KEY);
      tx.oncomplete = (): void => resolve();
      tx.onerror = (): void => reject(tx.error ?? new Error("indexedDB write failed"));
    });
  } finally {
    db.close();
  }
}
