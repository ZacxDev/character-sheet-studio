// The private `kv` mapping is a contract with the cutover copy script
// (`copy-kv-to-appdata.sql`): collection `kv`, key = the legacy key verbatim,
// data = `{ value: <legacy value> }`. These cases pin all three with LITERALS,
// against the SDK's own fake store built from the COMMITTED manifest — so an
// undeclared or renamed collection fails here as `collection_not_declared`
// rather than passing against a phantom store.

import { describe, expect, it } from 'vitest';

import { readFileSync } from 'node:fs';

import { createAppFakeStorage } from './fake-doc-storage.js';
import { KV_COLLECTION, KV_LIST_LIMIT_MAX, createKvStorage, type KvDocument } from './kv-store.js';
import { SheetStore } from './store.js';
import {
  CHARACTER_PREFIX,
  SETTINGS_KEY,
  SHEET_PREFIX,
  STACK_PREFIX,
  characterKey,
} from './types.js';

const kvOf = (fake: ReturnType<typeof createAppFakeStorage>) =>
  fake.storage.collection<KvDocument>('kv');

describe('the copy-script contract', () => {
  it('names the collection and the legacy keys literally', () => {
    expect(KV_COLLECTION).toBe('kv');
    // The legacy keys the production rows sit under; renaming any strands them.
    expect(SETTINGS_KEY).toBe('v1:settings');
    expect(CHARACTER_PREFIX).toBe('v1:char:');
    expect(STACK_PREFIX).toBe('v1:stack:');
    expect(SHEET_PREFIX).toBe('v1:sheet:');
    expect(KV_LIST_LIMIT_MAX).toBe(100);
  });

  it('the committed manifest declares `kv` private, with no indexes, and only the document-store scope', () => {
    const manifest = JSON.parse(
      readFileSync(new URL('../../block.manifest.json', import.meta.url), 'utf8'),
    ) as { scopes: string[]; storage?: { collections?: Record<string, unknown> } };
    expect(manifest.storage?.collections?.kv).toEqual({ visibility: 'private' });
    expect(manifest.scopes).toContain('apps:storage');
    for (const legacy of ['apps:storage:read', 'apps:storage:write', 'apps:storage:shared:read', 'apps:storage:shared:write']) {
      expect(manifest.scopes).not.toContain(legacy);
    }
  });

  it('reads records exactly as the copy script lays them down', async () => {
    const fake = createAppFakeStorage();
    const character = { id: 'c-1', name: 'Kaida', seedPolicy: 'locked' };
    const settings = { imageWidth: 768, imageHeight: 1024, quantity: 2, defaultPanels: ['front'] };
    await kvOf(fake).put('v1:char:c-1', { value: character });
    await kvOf(fake).put('v1:settings', { value: settings });

    const kv = createKvStorage(() => fake.storage);
    expect(await kv.get('v1:char:c-1')).toEqual(character);
    expect(await kv.get('v1:settings')).toEqual(settings);

    // …and through the app's own store, so a key-scheme drift fails too.
    const store = new SheetStore(kv);
    expect((await store.listCharacters()).map((c) => c.name)).toEqual(['Kaida']);
    expect((await store.getSettings()).imageWidth).toBe(768);
  });

  it('writes the wrapped shape under the legacy key, so a copy re-run and the app agree', async () => {
    const fake = createAppFakeStorage();
    const kv = createKvStorage(() => fake.storage);
    await kv.set('v1:stack:s-9', { id: 's-9', name: 'look' });

    const doc = await kvOf(fake).get('v1:stack:s-9');
    expect(doc?.data).toEqual({ value: { id: 's-9', name: 'look' } });
    // The wire body is the document data, wrapped.
    const put = fake.calls.find((c) => c.method === 'PUT');
    expect(put?.path).toContain('/kv/');
    expect(put?.body).toEqual({ data: { value: { id: 's-9', name: 'look' } } });
  });

  it('lists whole documents under a prefix, unwrapped, and deletes', async () => {
    const fake = createAppFakeStorage();
    const kv = createKvStorage(() => fake.storage);
    await kv.set(characterKey('a'), { id: 'a' });
    await kv.set(characterKey('b'), { id: 'b' });
    await kv.set('v1:settings', { imageWidth: 1 });

    const page = await kv.list({ prefix: 'v1:char:', limit: 500 });
    expect(page.entries.map((e) => [e.key, e.value])).toEqual([
      ['v1:char:a', { id: 'a' }],
      ['v1:char:b', { id: 'b' }],
    ]);
    // A requested limit above the server's max is clamped, not refused.
    const list = fake.calls.find((c) => c.method === 'GET' && c.query.keyPrefix === 'v1:char:');
    expect(list?.query.limit).toBe('100');

    expect(await kv.delete(characterKey('a'))).toEqual({ ok: true, deleted: true });
    expect(await kv.get(characterKey('a'))).toBeNull();
  });

  it('answers null for a key never written (not an error)', async () => {
    const kv = createKvStorage(() => createAppFakeStorage().storage);
    expect(await kv.get('v1:settings')).toBeNull();
  });

  it('is private: one viewer never reads another viewer’s record', async () => {
    const fake = createAppFakeStorage();
    await createKvStorage(() => fake.storage).set('v1:settings', { imageWidth: 1 });
    const bob = createKvStorage(() => fake.as({ viewer: { username: 'bob' } }).storage);
    expect(await bob.get('v1:settings')).toBeNull();
  });

  it('REJECTS an anonymous viewer rather than reporting "nothing stored"', async () => {
    const kv = createKvStorage(() => createAppFakeStorage({ viewer: null }).storage);
    await expect(kv.get('v1:settings')).rejects.toMatchObject({ code: 'sign_in_required' });
    await expect(kv.set('v1:settings', {})).rejects.toMatchObject({ code: 'sign_in_required' });
  });
});
