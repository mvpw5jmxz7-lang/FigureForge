import { describe, expect, it } from 'vitest';
import { memoryApiKeyStore } from './apiKeyStore.js';

describe('memoryApiKeyStore', () => {
  it('starts empty when given no initial value', async () => {
    const store = memoryApiKeyStore();
    expect(await store.load()).toBeNull();
  });

  it('seeds from an initial value', async () => {
    const store = memoryApiKeyStore('sk-ant-seeded');
    expect(await store.load()).toBe('sk-ant-seeded');
  });

  it('round-trips a saved key', async () => {
    const store = memoryApiKeyStore();
    await store.save('sk-ant-mine');
    expect(await store.load()).toBe('sk-ant-mine');
  });

  it('clears a stored key back to null', async () => {
    const store = memoryApiKeyStore('sk-ant-seeded');
    await store.clear();
    expect(await store.load()).toBeNull();
  });

  it('save overwrites a previously stored key', async () => {
    const store = memoryApiKeyStore('sk-ant-old');
    await store.save('sk-ant-new');
    expect(await store.load()).toBe('sk-ant-new');
  });
});
