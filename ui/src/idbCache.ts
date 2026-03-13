/**
 * idbCache.ts — circuit key cache for the web worker.
 *
 * WHY THIS EXISTS
 * ───────────────
 * The web WASM build of o1js disables `caml_fp_srs_get_lagrange_basis`
 * because the SRS file it requires is ~500 MB.  compile() therefore cannot
 * derive circuit proving/verification keys from scratch in the browser.
 *
 * The solution: pre-build the keys in Node.js with `bun run build:cache`,
 * serve the resulting binary files as static assets from /circuit-cache/,
 * and load them here so compile() hits the cache and never touches the SRS.
 *
 * VISIT FLOW
 * ──────────
 * First visit:
 *   1. IndexedDB is empty.
 *   2. Fetch all key files from /circuit-cache/ (listed in manifest.json).
 *   3. Pre-populate IndexedDB so the next visit skips the download.
 *   4. Load the in-memory map → compile() cache hits → no SRS needed.
 *
 * Repeat visits:
 *   1. Load the in-memory map from IndexedDB (fast, no network).
 *   2. compile() cache hits as before.
 *
 * CACHE INVALIDATION
 * ──────────────────
 * Each cache entry's key is the circuit's `uniqueId`, which encodes the
 * circuit digest.  When circuit source changes, the uniqueIds change, the
 * old IndexedDB entries become dead weight (not read) and the new ones are
 * fetched fresh from the server.
 * Run `bun run build:cache` after any circuit change and redeploy.
 */

const DB_NAME    = 'blind-auction-circuit-cache';
const STORE_NAME = 'entries';
const DB_VERSION = 1;

// A progress callback — called with human-readable status strings.
// When passed through Comlink as a proxy, calling it is async; we
// fire-and-forget (void) since ordering isn't critical for status text.
type OnProgress = (msg: string) => void | Promise<void>;

// ── IndexedDB helpers ────────────────────────────────────────────────────────

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE_NAME);
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

async function idbReadAll(): Promise<Map<string, Uint8Array>> {
  const db  = await openDB();
  const map = new Map<string, Uint8Array>();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(STORE_NAME, 'readonly');
    const cur = tx.objectStore(STORE_NAME).openCursor();
    cur.onsuccess = () => {
      if (cur.result) {
        map.set(cur.result.key as string, cur.result.value as Uint8Array);
        cur.result.continue();
      }
    };
    tx.oncomplete = () => resolve(map);
    tx.onerror    = () => reject(tx.error);
  });
}

async function idbWriteAll(entries: Map<string, Uint8Array>): Promise<void> {
  if (entries.size === 0) return;
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx    = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    for (const [key, val] of entries) store.put(val, key);
    tx.oncomplete = () => resolve();
    tx.onerror    = () => reject(tx.error);
  });
}

// ── Server fetch (first visit) ───────────────────────────────────────────────

async function fetchFromServer(
  onProgress?: OnProgress,
): Promise<Map<string, Uint8Array>> {
  void onProgress?.('Fetching circuit key manifest…');

  const mRes = await fetch('/circuit-cache/manifest.json');
  if (!mRes.ok) {
    throw new Error(
      `Circuit cache manifest not found (HTTP ${mRes.status}). ` +
      `Run: bun run build:cache`,
    );
  }
  const ids: string[] = await mRes.json();
  const total = ids.length;

  // Fetch all files in parallel; report progress as each one completes.
  const entries = new Array<readonly [string, Uint8Array]>(total);
  let done = 0;

  await Promise.all(ids.map(async (id, i) => {
    const r = await fetch(`/circuit-cache/${id}`);
    if (!r.ok) throw new Error(`Circuit cache entry missing: ${id} (HTTP ${r.status})`);
    entries[i] = [id, new Uint8Array(await r.arrayBuffer())];
    done++;
    void onProgress?.(`Downloading circuit keys… ${done} / ${total}`);
  }));

  return new Map(entries);
}

// ── Public API ───────────────────────────────────────────────────────────────

// Minimal shape of the o1js Cache interface — avoids importing the type.
export type O1jsCache = {
  read(header: { uniqueId: string }): Uint8Array | undefined;
  write(header: { uniqueId: string }, data: Uint8Array): void;
  canWrite: boolean;
};

/**
 * Build an o1js Cache ready to pass to compile().
 *
 * Loads existing entries from IndexedDB; falls back to fetching pre-built
 * keys from /circuit-cache/ on the first visit, pre-populating IndexedDB
 * for future visits.
 *
 * `onProgress` is called with human-readable status strings throughout.
 * Pass a Comlink-proxied callback to forward messages back to the main thread.
 *
 * Call this BEFORE compile().  Any entries written during compile() (e.g.
 * from circuits that can't use the pre-built cache) are queued in `pending`
 * and flushed to IndexedDB by calling persist() afterwards.
 */
export async function makeIDBCache(
  onProgress?: OnProgress,
): Promise<{
  cache:   O1jsCache;
  persist: () => Promise<void>;
}> {
  let existing = await idbReadAll();

  if (existing.size === 0) {
    // First visit — bootstrap from pre-built server files.
    void onProgress?.(`Downloading circuit keys (first visit, ~1 GB)…`);
    existing = await fetchFromServer(onProgress);
    await idbWriteAll(existing);   // pre-populate IDB for next visit
  } else {
    void onProgress?.(`Loaded ${existing.size} circuit key files from browser cache`);
  }

  // Entries written during this compile() session (cache misses or uncached
  // circuits) are queued here and flushed to IDB by persist().
  const pending = new Map<string, Uint8Array>();

  const cache: O1jsCache = {
    read({ uniqueId }) {
      return existing.get(uniqueId);
    },
    write({ uniqueId }, data) {
      existing.set(uniqueId, data);   // serve from memory for rest of session
      pending.set(uniqueId, data);    // queue for IDB write
    },
    canWrite: true,
  };

  return { cache, persist: () => idbWriteAll(pending) };
}
