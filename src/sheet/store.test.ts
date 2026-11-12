import { describe, expect, it } from 'vitest';

import { StorageError } from '@civitai/sdk';
import { createFakeStorage, type FakeStorage } from '@civitai/sdk/testing';

import { createAppFakeStorage, seedKv } from './fake-doc-storage.js';
import { KV_COLLECTION, createKvStorage, type KvDocument } from './kv-store.js';
import { SheetStore, classifyStoreError } from './store.js';
import {
  DEFAULT_SETTINGS,
  characterKey,
  newCharacter,
  newModelStack,
  newSheetJob,
  sheetKey,
} from './types.js';

// The store runs over the REAL document-store client (`createKvStorage` on
// the SDK's `createFakeStorage`, which enforces the committed manifest and
// the server's rules) — not over a hand-rolled KV double.

function makeStore(fake: FakeStorage = createAppFakeStorage()) {
  return { fake, store: new SheetStore(createKvStorage(() => fake.storage)) };
}

/** The raw document the store wrote at `key`. */
async function rawDoc(fake: FakeStorage, key: string) {
  return fake.storage.collection<KvDocument>(KV_COLLECTION).get(key);
}

describe('SheetStore characters', () => {
  it('round-trips save / get / list / delete', async () => {
    const { store } = makeStore();
    const c = newCharacter({ name: 'Mira' });
    expect(await store.getCharacter(c.id)).toBeNull();
    await store.saveCharacter(c);
    expect(await store.getCharacter(c.id)).toMatchObject({ id: c.id, name: 'Mira' });
    expect(await store.listCharacters()).toHaveLength(1);
    await store.deleteCharacter(c.id);
    expect(await store.listCharacters()).toHaveLength(0);
    // Idempotent delete: no throw on a missing row.
    await store.deleteCharacter(c.id);
  });

  it('stamps updatedAt on save', async () => {
    const { store } = makeStore();
    const c = { ...newCharacter({ name: 'M' }), updatedAt: '2000-01-01T00:00:00.000Z' };
    await store.saveCharacter(c);
    const saved = await store.getCharacter(c.id);
    expect(saved?.updatedAt).not.toBe('2000-01-01T00:00:00.000Z');
  });

  it('drops malformed rows when listing', async () => {
    const { fake, store } = makeStore();
    await seedKv(fake, { [characterKey('bad')]: { nope: true }, [characterKey('alsobad')]: 'a string' });
    await store.saveCharacter(newCharacter({ name: 'Good' }));
    const list = await store.listCharacters();
    expect(list).toHaveLength(1);
    expect(list[0]?.name).toBe('Good');
  });

  it('pages through cursor results', async () => {
    const { fake, store } = makeStore();
    for (let i = 0; i < 125; i++) {
      await store.saveCharacter(newCharacter({ name: `char-${i}` }));
    }
    // The store requests limit 100 (the server's max), so 125 rows is two
    // pages — the cursor loop must return every row exactly once.
    const before = fake.calls.length;
    const list = await store.listCharacters();
    expect(list).toHaveLength(125);
    expect(new Set(list.map((c) => c.id)).size).toBe(125);
    // Whole documents come back per page: two list requests, no per-key gets.
    const reads = fake.calls.slice(before);
    expect(reads).toHaveLength(2);
    expect(reads.every((c) => c.method === 'GET' && c.query.keyPrefix === 'v1:char:')).toBe(true);
  });

  it('refuses to build an over-long key', async () => {
    const { store } = makeStore();
    const c = { ...newCharacter({ name: 'M' }), id: 'x'.repeat(300) };
    await expect(store.saveCharacter(c)).rejects.toThrow(/exceeds/);
    await expect(store.getCharacter(c.id)).rejects.toThrow(/exceeds/);
  });
});

describe('SheetStore stacks and sheets', () => {
  it('round-trips stacks', async () => {
    const { store } = makeStore();
    const s = newModelStack({
      name: 'Mira look',
      checkpoint: { modelId: 1, modelVersionId: 2, baseModel: 'SDXL' },
      loras: [{ modelVersionId: 10, strength: 0.8, triggerWords: ['mira'] }],
    });
    await store.saveStack(s);
    expect(await store.getStack(s.id)).toMatchObject({ name: 'Mira look' });
    expect(await store.listStacks()).toHaveLength(1);
    await store.deleteStack(s.id);
    expect(await store.listStacks()).toHaveLength(0);
  });

  it('round-trips sheets with workflow ids intact', async () => {
    const { fake, store } = makeStore();
    const job = newSheetJob({ name: 's', characterId: 'c', stackId: 'k', seed: 7 });
    job.panels[0] = { ...job.panels[0]!, workflowId: 'wf-123', status: 'running' };
    await store.saveSheet(job);
    const loaded = await store.getSheet(job.id);
    expect(loaded?.panels[0]?.workflowId).toBe('wf-123');
    expect(loaded?.panels[0]?.status).toBe('running');
    // The raw row keeps the resumability anchor: a reloaded batch can
    // re-attach to the still-running workflow.
    const raw = (await rawDoc(fake, sheetKey(job.id)))?.data.value as {
      panels: { workflowId?: string }[];
    };
    expect(raw.panels[0]?.workflowId).toBe('wf-123');
  });
});

describe('SheetStore settings and quota', () => {
  it('returns defaults when settings were never saved', async () => {
    const { store } = makeStore();
    expect(await store.getSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it('round-trips settings', async () => {
    const { store } = makeStore();
    await store.saveSettings({
      imageWidth: 768,
      imageHeight: 1024,
      quantity: 2,
      defaultPanels: ['front', 'back'],
    });
    expect(await store.getSettings()).toEqual({
      imageWidth: 768,
      imageHeight: 1024,
      quantity: 2,
      defaultPanels: ['front', 'back'],
    });
  });

  it('answers the quota from info(): the viewer usage and the per-viewer limits', async () => {
    // Pairwise-distinct literals, so a swapped field cannot pass.
    const { store } = makeStore(createAppFakeStorage({ limits: { viewerBytes: 777_777, viewerDocs: 333 } }));
    await store.saveSettings(DEFAULT_SETTINGS);
    const q = await store.getQuota();
    expect(q.limitBytes).toBe(777_777);
    expect(q.limitRows).toBe(333);
    expect(q.rowCount).toBe(1);
    expect(q.usedBytes).toBeGreaterThan(0);
  });
});

describe('classifyStoreError', () => {
  const refusal = (code: string, status = 400) => new StorageError(status, code, code, { code });

  it('maps document-store codes onto the app set', () => {
    expect(classifyStoreError(refusal('too_large', 413))).toBe('value-too-large');
    expect(classifyStoreError(refusal('quota_exceeded', 413))).toBe('quota-exceeded');
    expect(classifyStoreError(refusal('insufficient_scope', 403))).toBe('not-permitted');
    expect(classifyStoreError(refusal('consent_required', 403))).toBe('not-permitted');
    expect(classifyStoreError(refusal('collection_not_declared', 404))).toBe('not-permitted');
    expect(classifyStoreError(refusal('not_eligible', 403))).toBe('not-permitted');
    expect(classifyStoreError(refusal('rate_limited', 429))).toBe('request-failed');
    expect(classifyStoreError(refusal('service_unavailable', 503))).toBe('request-failed');
    // A dropped connection: `fetch` itself rejects with a TypeError.
    expect(classifyStoreError(new TypeError('Failed to fetch'))).toBe('request-failed');
  });

  it('answers unknown for anything it does not recognize (incl. an anonymous viewer)', () => {
    expect(classifyStoreError(refusal('sign_in_required', 401))).toBe('unknown');
    expect(classifyStoreError(new Error('some random failure'))).toBe('unknown');
    expect(classifyStoreError(null)).toBe('unknown');
    expect(classifyStoreError('the database hamster is tired')).toBe('unknown');
  });

  it('classifies the REAL refusals the store sends', async () => {
    // Over the per-viewer document ceiling.
    const full = makeStore(createAppFakeStorage({ limits: { viewerDocs: 1 } }));
    await full.store.saveSettings(DEFAULT_SETTINGS);
    const overQuota = await full.store
      .saveCharacter(newCharacter({ name: 'one too many' }))
      .then(() => null, (e: unknown) => e);
    expect(classifyStoreError(overQuota)).toBe('quota-exceeded');

    // A document over the 64 KiB cap.
    const big = makeStore();
    const tooBig = await big.store
      .saveCharacter(newCharacter({ name: 'big', description: 'x'.repeat(70_000) }))
      .then(() => null, (e: unknown) => e);
    expect(classifyStoreError(tooBig)).toBe('value-too-large');

    // A manifest that does not declare the collection.
    const undeclared = makeStore(
      createFakeStorage({ manifest: { scopes: ['apps:storage'], storage: { collections: {} } } }),
    );
    const notDeclared = await undeclared.store.getSettings().then(() => null, (e: unknown) => e);
    expect(classifyStoreError(notDeclared)).toBe('not-permitted');
  });
});
