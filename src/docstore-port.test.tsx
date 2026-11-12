// 0.2.0 — the library moved from the legacy per-viewer KV (`useAppStorage`,
// bridge messages APP_STORAGE_*) to the document store's private `kv`
// collection. These drive the REAL <App/> against the mock host for the
// bridge and the SDK's `createFakeStorage` for the document store (installed
// per test by ./test-setup.ts), and pin:
//   1. a viewer's library as the cutover copy laid it down renders;
//   2. a delete reaches `kv` under the legacy key (the `{ value }` write shape
//      is pinned in ./sheet/kv-store.test.ts);
//   3. an anonymous viewer sends the store nothing;
//   4. in production wiring (no override) the requests go to the HOST origin's
//      `/api/v1/blocks/storage/kv`, with the block token.
// test-setup's tripwire additionally fails ANY test that speaks the legacy
// store, so the pre-port app cannot pass these by answering from the mock host.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { App } from './App.js';
import { installMockMoneyHost } from './mock-buzz.js';
import { configureDocumentStorage } from './sheet/doc-storage.js';
import { seedKv } from './sheet/fake-doc-storage.js';
import { KV_COLLECTION, type KvDocument } from './sheet/kv-store.js';
import { testDocStore } from './test-doc-store.js';

const kaida = {
  id: 'c-kaida',
  name: 'Kaida',
  description: 'A cyberpunk street samurai',
  traits: ['neon-blue undercut hair'],
  triggerWords: ['kaida_cyber'],
  negativePrompt: '',
  seedPolicy: 'locked',
  createdAt: '2026-10-01T22:00:00.000Z',
  updatedAt: '2026-10-01T22:00:00.000Z',
};

describe('library on the document store (0.2.0)', () => {
  let uninstall: (() => void) | undefined;
  afterEach(() => {
    uninstall?.();
    uninstall = undefined;
  });

  it('renders a library exactly as the copy script wrote it (kv, legacy key, { value })', async () => {
    await seedKv(testDocStore(), { 'v1:char:c-kaida': kaida });
    uninstall = installMockMoneyHost();
    render(<App />);
    expect(await screen.findByText('Kaida')).toBeInTheDocument();
    // It was read from the private collection, by listing the legacy prefix.
    const lists = testDocStore().calls.filter(
      (c) => c.method === 'GET' && c.path.endsWith(`/${KV_COLLECTION}`),
    );
    expect(lists.map((c) => c.query.keyPrefix)).toEqual(
      expect.arrayContaining(['v1:char:', 'v1:stack:', 'v1:sheet:']),
    );
  });

  it('a delete removes the `kv` document under the legacy key', async () => {
    await seedKv(testDocStore(), { 'v1:char:c-kaida': kaida });
    uninstall = installMockMoneyHost();
    const user = userEvent.setup();
    render(<App />);
    await screen.findByText('Kaida');

    await user.click(screen.getByTestId('char-menu'));
    await user.click(screen.getByTestId('char-menu-delete'));
    await user.click(await screen.findByTestId('char-confirm-delete'));

    const kv = testDocStore().storage.collection<KvDocument>(KV_COLLECTION);
    await waitFor(async () => expect(await kv.get('v1:char:c-kaida')).toBeNull());
    const del = testDocStore().calls.find((c) => c.method === 'DELETE');
    expect(del?.path).toBe(`blocks/storage/${KV_COLLECTION}/v1%3Achar%3Ac-kaida`);
  });

  it('an anonymous viewer never reaches the store (private reads refuse them)', async () => {
    uninstall = installMockMoneyHost({ viewer: null });
    render(<App />);
    await screen.findByRole('button', { name: 'Characters' });
    // Give any hydration a chance to run.
    await new Promise((r) => setTimeout(r, 50));
    expect(testDocStore().calls).toEqual([]);
  });

  it('production wiring: the HOST origin’s /api/v1/blocks/storage/kv, with the block token', async () => {
    configureDocumentStorage(null);
    const seen: { url: string; auth: string | null }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        const headers = new Headers(init?.headers);
        seen.push({ url, auth: headers.get('authorization') });
        const body = url.includes('/blocks/storage/kv?')
          ? { items: [], nextCursor: null }
          : url.endsWith('/blocks/storage')
            ? {
                collections: {},
                limits: { viewerBytes: 1, viewerDocs: 1 },
                usage: { app: { bytes: 0, docs: 0 }, viewer: { bytes: 0, docs: 0 } },
              }
            : { code: 'not_found', message: 'not found' };
        const status = url.includes('/blocks/storage/kv/') ? 404 : 200;
        return new Response(JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json' },
        });
      }),
    );
    uninstall = installMockMoneyHost();
    render(<App />);
    await waitFor(() => expect(seen.some((s) => s.url.includes('/blocks/storage/kv'))).toBe(true));
    const storageCalls = seen.filter((s) => s.url.includes('/blocks/storage'));
    for (const call of storageCalls) {
      expect(call.url.startsWith(`${window.location.origin}/api/v1/blocks/storage`)).toBe(true);
      expect(call.auth).toMatch(/^Bearer \S+/);
    }
  });
});
