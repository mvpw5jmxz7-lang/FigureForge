/**
 * Where the browser remembers the working directory between sessions.
 *
 * This is the first browser-storage use anywhere in `apps/web` — nothing else
 * touches IndexedDB, `localStorage` or `sessionStorage` — and that is why it
 * sits behind an interface rather than being called inline. The vitest suite
 * runs in `environment: 'node'` on purpose (a jsdom default would let an
 * accidental DOM import into `packages/render` pass), so there is no
 * `indexedDB` global and no structured clone of a directory handle to test
 * against. An injected store is the same seam `ProjectFileSystem` itself
 * already is, for the same reason.
 *
 * IndexedDB rather than `localStorage` is forced, not preferred: a
 * `FileSystemDirectoryHandle` is a live capability that survives only
 * structured cloning, and `localStorage` holds strings.
 *
 * `indexedDbDirectoryStore` has no unit test, deliberately — it *is* the
 * untestable half this seam exists to isolate, the same standing as
 * `bakePointCloud`'s `OffscreenCanvas` and `encodeCrop`. It is verified by
 * driving a real browser instead.
 */

/**
 * The one member ever read off a stored handle.
 *
 * Narrow on purpose: because nothing here calls `queryPermission`,
 * `requestPermission` or any entry-listing method, a plain `{ name }` object
 * satisfies it structurally — so the memory double below needs no
 * `structuredClone`, no fake-indexeddb and no jsdom. It also states the
 * privacy claim in the type: this app never looks inside the folder.
 */
export interface StoredDirectory {
  readonly name: string;
}

export interface DirectoryStore {
  /** Null when nothing is stored, or when storage is unavailable. */
  load(): Promise<StoredDirectory | null>;
  save(handle: StoredDirectory): Promise<void>;
  clear(): Promise<void>;
}

const DB_NAME = 'figureforge';
const STORE_NAME = 'handles';
const KEY = 'working-directory';

/** Promisify one IndexedDB request. */
function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
  });
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(DB_NAME, 1);
    open.onupgradeneeded = () => {
      if (!open.result.objectStoreNames.contains(STORE_NAME)) {
        open.result.createObjectStore(STORE_NAME);
      }
    };
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error ?? new Error('IndexedDB could not be opened'));
  });
}

async function withStore<T>(mode: IDBTransactionMode, body: (store: IDBObjectStore) => Promise<T>) {
  const db = await openDb();
  try {
    return await body(db.transaction(STORE_NAME, mode).objectStore(STORE_NAME));
  } finally {
    db.close();
  }
}

/**
 * The real store.
 *
 * Touches `indexedDB` only inside its methods, never at construction: the
 * exported `browserProjectFileSystem` const is built at import time, including
 * in the Node suite, where the global does not exist. Every method degrades to
 * null or a no-op rather than throwing — a working directory that cannot be
 * remembered is a lost convenience, and the same stance `loadRecent`'s own
 * try/catch already takes on the desktop side.
 */
export function indexedDbDirectoryStore(): DirectoryStore {
  const unavailable = (): boolean => typeof indexedDB === 'undefined';

  return {
    async load() {
      if (unavailable()) return null;
      try {
        const stored = await withStore('readonly', (store) =>
          request<StoredDirectory | undefined>(store.get(KEY)),
        );
        return stored ?? null;
      } catch {
        return null;
      }
    },

    async save(handle) {
      if (unavailable()) return;
      try {
        await withStore('readwrite', (store) => request(store.put(handle, KEY)));
      } catch {
        // Private browsing, a storage quota, or a user who has denied site
        // data. The directory still works for this session — the caller keeps
        // it in memory — it simply will not survive a reload.
      }
    },

    async clear() {
      if (unavailable()) return;
      try {
        await withStore('readwrite', (store) => request(store.delete(KEY)));
      } catch {
        // As above: failing to forget is not worth an error message.
      }
    },
  };
}

/** An in-memory double, for tests. */
export function memoryDirectoryStore(initial: StoredDirectory | null = null): DirectoryStore {
  let held = initial;
  return {
    load: async () => held,
    save: async (handle) => {
      held = handle;
    },
    clear: async () => {
      held = null;
    },
  };
}
