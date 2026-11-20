// Share a sheet by link (HQ app_blocks_sdk_j1gc), the READER side: another
// viewer opens `share/<key>` and sees the sheet with every image url taken from
// the gated image read (`useGatedImages`), never from the shared record. Also
// pins the route, the Back seed, and the manifest schema that keeps urls out of
// the record.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

const host = vi.hoisted(() => ({
  gatedCalls: [] as number[][],
  gated: [] as unknown[],
}));

vi.mock('@civitai/blocks-react', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@civitai/blocks-react')>();
  return {
    ...mod,
    useGatedImages: () => ({
      getImages: async (ids: number[]) => {
        host.gatedCalls.push(ids);
        return host.gated;
      },
    }),
  };
});

import { landingHistorySeed, parseAppRoute, sharedSheetRoute } from './platform/route.js';
import { SharedSheetView } from './screens/SharedSheetView.js';
import { configureDocumentStorage } from './sheet/doc-storage.js';
import { testDocStore } from './test-doc-store.js';

import manifestText from '../block.manifest.json?raw';

const GATED_SIDE_URL = 'https://image.civitai.test/gated/side.jpeg';

afterEach(() => {
  host.gatedCalls.length = 0;
  host.gated = [];
});

describe('Shared sheet (another viewer)', () => {
  it('opens the owner’s record and takes every image url from the gated read', async () => {
    const fake = testDocStore();
    const written = await fake
      .as({ viewer: { username: 'zachlowdenzx' } })
      .storage.collection('shared_sheets')
      .create({
        v: 1,
        characterName: 'Morov',
        sheetName: 'Morov turnaround',
        panels: [
          { label: 'Side view', imageId: 90817 },
          { label: 'Back view', imageId: 31337 },
        ],
      });
    configureDocumentStorage(async () => fake.as({ viewer: { username: 'appdrive_user' } }).storage);
    host.gated = [
      { imageId: 90817, status: 'visible', url: GATED_SIDE_URL, width: 832, height: 1216, nsfwLevel: 1, contentRating: 'pg' },
      { imageId: 31337, status: 'hidden' },
    ];

    render(<SharedSheetView shareKey={written.key} onGallery={() => {}} />);

    expect(await screen.findByTestId('ss-sheet-name', {}, { timeout: 8000 })).toHaveTextContent(
      'Morov turnaround',
    );
    expect(host.gatedCalls).toEqual([[90817, 31337]]);
    expect(screen.getByRole('img', { name: 'Side view' })).toHaveAttribute('src', GATED_SIDE_URL);
    expect(screen.queryByRole('img', { name: 'Back view' })).toBeNull();
    expect(screen.getByTestId('ss-panel-hidden')).toHaveTextContent('Hidden at your content settings.');
  }, 15000);

  it('never renders a url planted in a record by another client', async () => {
    const PLANTED = 'https://evil.example.test/planted.png';
    const planted = {
      v: 1,
      characterName: 'Morov',
      sheetName: 'Planted',
      url: PLANTED,
      panels: [{ label: 'Side view', imageId: 5, url: PLANTED, src: PLANTED }],
    };
    configureDocumentStorage(
      async () =>
        ({
          collection: () => ({ get: async () => ({ key: 'k', data: planted }) }),
        }) as never,
    );
    host.gated = [{ imageId: 5, status: 'hidden' }];

    render(<SharedSheetView shareKey="k" onGallery={() => {}} />);

    await screen.findByTestId('ss-sheet-name', {}, { timeout: 8000 });
    expect(document.body.innerHTML).not.toContain(PLANTED);
    expect(screen.queryByRole('img')).toBeNull();
  }, 15000);

  it('a missing record says so', async () => {
    render(<SharedSheetView shareKey="no-such-key" onGallery={() => {}} />);
    expect(await screen.findByTestId('ss-unavailable', {}, { timeout: 8000 })).toHaveTextContent(
      'This shared sheet isn’t available any more.',
    );
    expect(host.gatedCalls).toEqual([]);
  }, 15000);
});

describe('share route and Back', () => {
  it('share/<key> is the shared-sheet route; a shared landing seeds the gallery under it', () => {
    expect(parseAppRoute('share/01ABC')).toEqual({ name: 'shared-sheet', shareKey: '01ABC' });
    expect(sharedSheetRoute('a b')).toBe('share/a%20b');
    expect(landingHistorySeed('share/01ABC')).toBe('characters');
    expect(landingHistorySeed('sheets/sheet-1')).toBeNull();
    expect(landingHistorySeed('')).toBeNull();
  });
});

describe('manifest: the shared record cannot hold a url', () => {
  const m = JSON.parse(manifestText) as {
    scopes: string[];
    scopeJustifications: Record<string, string>;
    storage: { collections: Record<string, Record<string, unknown>> };
  };

  it('declares shared_sheets as shared, write own, with the publish scope justified', () => {
    const c = m.storage.collections.shared_sheets;
    expect(c.visibility).toBe('shared');
    expect(c.write).toBe('own');
    expect(m.scopes).toContain('apps:storage:publish');
    expect(m.scopeJustifications['apps:storage:publish']).toMatch(/image IDs only, never image URLs/);
  });

  it('its schema closes every object and types imageId as an integer', () => {
    const schema = m.storage.collections.shared_sheets.schema as {
      additionalProperties: unknown;
      properties: Record<string, { items?: { additionalProperties: unknown; properties: Record<string, { type: string }> } }>;
    };
    expect(schema.additionalProperties).toBe(false);
    expect(Object.keys(schema.properties).sort()).toEqual(['characterName', 'panels', 'sheetName', 'v']);
    const item = schema.properties.panels.items!;
    expect(item.additionalProperties).toBe(false);
    expect(Object.keys(item.properties).sort()).toEqual(['imageId', 'label']);
    expect(item.properties.imageId.type).toBe('integer');
  });
});
