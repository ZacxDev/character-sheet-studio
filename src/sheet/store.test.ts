import { describe, expect, it } from 'vitest';

import {
  APP_STORAGE_ERROR_REQUEST_FAILED,
  APP_STORAGE_ERROR_USER_QUOTA_EXCEEDED,
  APP_STORAGE_ERROR_USER_ROW_LIMIT,
  APP_STORAGE_ERROR_VALUE_TOO_LARGE,
} from '@civitai/app-sdk/blocks';
import type {
  AppStorageKeyEntry,
  AppStorageListResult,
  AppStorageQuota,
  UseAppStorage,
} from '@civitai/blocks-react';

import { SheetStore, classifyStoreError } from './store.js';
import {
  DEFAULT_SETTINGS,
  characterKey,
  newCharacter,
  newModelStack,
  newSheetJob,
  sheetKey,
} from './types.js';

/** In-memory `UseAppStorage` with real cursor pagination. */
class FakeStorage implements UseAppStorage {
  private rows = new Map<string, { value: unknown; updatedAt: Date }>();
  pageSize = 100;

  async get<T = unknown>(key: string): Promise<T | null> {
    const row = this.rows.get(key);
    return row ? (row.value as T) : null;
  }

  async set<T = unknown>(key: string, value: T): Promise<{ ok: true; sizeBytes?: number }> {
    this.rows.set(key, { value, updatedAt: new Date() });
    return { ok: true as const };
  }

  async delete(key: string): Promise<{ ok: true; deleted: boolean }> {
    const deleted = this.rows.delete(key);
    return { ok: true as const, deleted };
  }

  async list(opts?: {
    prefix?: string;
    limit?: number;
    cursor?: string;
  }): Promise<AppStorageListResult> {
    const prefix = opts?.prefix ?? '';
    const limit = Math.min(opts?.limit ?? this.pageSize, this.pageSize);
    const keys = [...this.rows.keys()].filter((k) => k.startsWith(prefix)).sort();
    const start = opts?.cursor ? Number(Buffer.from(opts.cursor, 'base64').toString('utf8')) : 0;
    const slice = keys.slice(start, start + limit);
    const entries: AppStorageKeyEntry[] = slice.map((key) => ({
      key,
      updatedAt: this.rows.get(key)!.updatedAt,
    }));
    const result: AppStorageListResult = { keys: entries };
    if (start + limit < keys.length) {
      result.nextCursor = Buffer.from(String(start + limit), 'utf8').toString('base64');
    }
    return result;
  }

  async getQuota(): Promise<AppStorageQuota> {
    return {
      usedBytes: 0,
      rowCount: this.rows.size,
      limitBytes: 1_000_000,
      limitRows: 1000,
    };
  }

  /** Bypass the store to plant raw (possibly malformed) rows. */
  plant(key: string, value: unknown): void {
    this.rows.set(key, { value, updatedAt: new Date() });
  }
}

describe('SheetStore characters', () => {
  it('round-trips save / get / list / delete', async () => {
    const store = new SheetStore(new FakeStorage());
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
    const fake = new FakeStorage();
    const store = new SheetStore(fake);
    const c = { ...newCharacter({ name: 'M' }), updatedAt: '2000-01-01T00:00:00.000Z' };
    await store.saveCharacter(c);
    const saved = await store.getCharacter(c.id);
    expect(saved?.updatedAt).not.toBe('2000-01-01T00:00:00.000Z');
  });

  it('drops malformed rows when listing', async () => {
    const fake = new FakeStorage();
    fake.plant(characterKey('bad'), { nope: true });
    fake.plant(characterKey('alsobad'), 'a string');
    const store = new SheetStore(fake);
    await store.saveCharacter(newCharacter({ name: 'Good' }));
    const list = await store.listCharacters();
    expect(list).toHaveLength(1);
    expect(list[0]?.name).toBe('Good');
  });

  it('pages through cursor results', async () => {
    const fake = new FakeStorage();
    fake.pageSize = 50;
    const store = new SheetStore(fake);
    for (let i = 0; i < 125; i++) {
      await store.saveCharacter(newCharacter({ name: `char-${i}` }));
    }
    // The store requests limit 100; the fake caps pages at 50 — either way,
    // the cursor loop must return every row exactly once.
    const list = await store.listCharacters();
    expect(list).toHaveLength(125);
    expect(new Set(list.map((c) => c.id)).size).toBe(125);
  });

  it('refuses to build an over-long key', async () => {
    const store = new SheetStore(new FakeStorage());
    const c = { ...newCharacter({ name: 'M' }), id: 'x'.repeat(300) };
    await expect(store.saveCharacter(c)).rejects.toThrow(/exceeds/);
    await expect(store.getCharacter(c.id)).rejects.toThrow(/exceeds/);
  });
});

describe('SheetStore stacks and sheets', () => {
  it('round-trips stacks', async () => {
    const store = new SheetStore(new FakeStorage());
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
    const fake = new FakeStorage();
    const store = new SheetStore(fake);
    const job = newSheetJob({ name: 's', characterId: 'c', stackId: 'k', seed: 7 });
    job.panels[0] = { ...job.panels[0]!, workflowId: 'wf-123', status: 'running' };
    await store.saveSheet(job);
    const loaded = await store.getSheet(job.id);
    expect(loaded?.panels[0]?.workflowId).toBe('wf-123');
    expect(loaded?.panels[0]?.status).toBe('running');
    // The raw row keeps the resumability anchor: a reloaded batch can
    // re-attach to the still-running workflow.
    const raw = (await fake.get(sheetKey(job.id))) as { panels: { workflowId?: string }[] };
    expect(raw.panels[0]?.workflowId).toBe('wf-123');
  });
});

describe('SheetStore settings and quota', () => {
  it('returns defaults when settings were never saved', async () => {
    const store = new SheetStore(new FakeStorage());
    expect(await store.getSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it('round-trips settings', async () => {
    const store = new SheetStore(new FakeStorage());
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

  it('passes the quota reply through untouched', async () => {
    const store = new SheetStore(new FakeStorage());
    const q = await store.getQuota();
    expect(q.limitBytes).toBe(1_000_000);
    expect(q.limitRows).toBe(1000);
    expect(q.rowCount).toBe(0);
  });
});

describe('classifyStoreError', () => {
  it('maps the SDK ceiling classifications onto the app set', () => {
    expect(classifyStoreError(new Error(APP_STORAGE_ERROR_VALUE_TOO_LARGE))).toBe(
      'value-too-large',
    );
    expect(classifyStoreError(new Error(APP_STORAGE_ERROR_USER_QUOTA_EXCEEDED))).toBe(
      'quota-exceeded',
    );
    expect(classifyStoreError(new Error(APP_STORAGE_ERROR_USER_ROW_LIMIT))).toBe(
      'row-limit',
    );
    expect(classifyStoreError(new Error(APP_STORAGE_ERROR_REQUEST_FAILED))).toBe(
      'request-failed',
    );
  });

  it('answers unknown for anything the SDK does not recognize', () => {
    expect(classifyStoreError(new Error('some random failure'))).toBe('unknown');
    expect(classifyStoreError(null)).toBe('unknown');
    expect(classifyStoreError('the database hamster is tired')).toBe('unknown');
  });

  it('detects the host scope-denied failure as not-permitted', () => {
    // The exact bridge shape the host returns when the manifest lacks the
    // storage scope: { message, code: -32003, data: { code: 'FORBIDDEN', … } }.
    const bridgeRejection = {
      message: 'storage set requires the apps:storage:write scope',
      code: -32003,
      data: { code: 'FORBIDDEN', httpStatus: 403, path: 'apps.storage.set' },
    };
    expect(classifyStoreError(bridgeRejection)).toBe('not-permitted');
    expect(
      classifyStoreError(
        new Error('storage get requires the apps:storage:read scope'),
      ),
    ).toBe('not-permitted');
    expect(
      classifyStoreError('storage list requires the apps:storage:read scope'),
    ).toBe('not-permitted');
    // Near-misses must not be swallowed: the SDK owns every other wording.
    expect(classifyStoreError(new Error('storage set requires a scope'))).toBe(
      'unknown',
    );
  });
});
