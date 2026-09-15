/**
 * Where the browser remembers a user-supplied Anthropic API key.
 *
 * `localStorage`, not IndexedDB: `directoryStore.ts`'s use of IndexedDB is
 * forced by a `FileSystemDirectoryHandle`'s structured-cloning requirement,
 * which a plain string has no analogue of. Otherwise this follows that
 * module's own interface discipline exactly — an injected store, a real
 * implementation that degrades to null/no-op rather than throwing, and a
 * memory double for tests, for the same reason: the vitest suite runs in
 * `environment: 'node'` on purpose, so there is no `localStorage` global to
 * test against directly.
 *
 * The key is namespaced (not a bare string key) because, unlike the
 * IndexedDB store's own database, `localStorage` is a flat, unscoped
 * namespace shared with anything else that might ever write into it.
 */

const STORAGE_KEY = 'figureforge:anthropic-api-key';

export interface ApiKeyStore {
  /** Null when nothing is stored, or when storage is unavailable. */
  load(): Promise<string | null>;
  save(key: string): Promise<void>;
  clear(): Promise<void>;
}

/**
 * The real store.
 *
 * Touches `localStorage` only inside its methods, never at construction, and
 * every method degrades to null/a no-op rather than throwing — a key that
 * cannot be remembered is a lost convenience, not an error, the same stance
 * `indexedDbDirectoryStore` already takes.
 */
export function localStorageApiKeyStore(): ApiKeyStore {
  const unavailable = (): boolean => typeof localStorage === 'undefined';

  return {
    async load() {
      if (unavailable()) return null;
      try {
        return localStorage.getItem(STORAGE_KEY);
      } catch {
        return null;
      }
    },

    async save(key) {
      if (unavailable()) return;
      try {
        localStorage.setItem(STORAGE_KEY, key);
      } catch {
        // Private browsing, a storage quota, or denied site data. The key
        // still works for this session via the caller's own state; it
        // simply will not survive a reload.
      }
    },

    async clear() {
      if (unavailable()) return;
      try {
        localStorage.removeItem(STORAGE_KEY);
      } catch {
        // As above: failing to forget is not worth an error message.
      }
    },
  };
}

/** An in-memory double, for tests. */
export function memoryApiKeyStore(initial: string | null = null): ApiKeyStore {
  let held = initial;
  return {
    load: async () => held,
    save: async (key) => {
      held = key;
    },
    clear: async () => {
      held = null;
    },
  };
}
