// Share a sheet by link (HQ app_blocks_sdk_j1gc), the OWNER side: "Share sheet"
// writes a shared record of image IDs and "Copy link" asks the host for the
// link. The reader side is shared-sheet-view.test.tsx. This file imports only
// modules that predate the feature, so on the pre-change code it fails on the
// missing behaviour, not on an import.
//
// 🔴 The guarded failure is a shared document carrying an image URL: shared
// records are readable by every viewer of the app, so a stored url would show
// one viewer's image to another past their content level. The record must hold
// IDs only, and the reader must take urls only from `getImages`.
//
// The store is the SDK fake over the COMMITTED manifest (test-setup), so the
// `shared_sheets` collection must really be declared. Publish, poll and share
// are spies through a partial mock of @civitai/blocks-react.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import type { BlockWorkflowSnapshot } from '@civitai/app-sdk/blocks';

const host = vi.hoisted(() => ({
  replies: new Map<string, unknown[]>(),
  publishCalls: [] as unknown[],
  publishIds: [] as number[][],
  shareCalls: [] as unknown[],
  publishRejects: false,
}));

vi.mock('@civitai/blocks-react', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@civitai/blocks-react')>();
  return {
    ...mod,
    useBlockToken: () => {
      const real = mod.useBlockToken();
      return { ...real, scopes: [...(real.scopes ?? []), 'apps:storage:publish'] };
    },
    useBuzzWorkflow: () => {
      const real = mod.useBuzzWorkflow();
      return {
        ...real,
        poll: async (workflowId: string) => {
          const queue = host.replies.get(workflowId);
          if (!queue || queue.length === 0) throw new Error('unscripted poll');
          return (queue.length > 1 ? queue.shift() : queue[0]) as BlockWorkflowSnapshot;
        },
      };
    },
    usePublishGenerationOutputs: () => ({
      publish: async (args: unknown) => {
        host.publishCalls.push(args);
        if (host.publishRejects) throw new Error('dismissed');
        return host.publishIds.shift() ?? [];
      },
    }),
    useShareLink: () => ({
      share: async (target: unknown) => {
        host.shareCalls.push(target);
        return { url: 'https://civitai.com/apps/run/character-sheet-studio/x', copied: true, method: 'clipboard' };
      },
      isPending: false,
      error: null,
      lastResult: null,
    }),
  };
});

import { installMockMoneyHost } from './mock-buzz.js';
import { SheetView } from './screens/SheetView.js';
import {
  DEFAULT_SETTINGS,
  type Character,
  type ModelStack,
  type SheetJob,
  type SheetPanel,
} from './sheet/types.js';
import type { SheetLibrary } from './sheet/useSheetLibrary.js';
import { testDocStore } from './test-doc-store.js';

const SIDE_URL = 'https://image.example.test/side-private.png';
const BACK_URL = 'https://image.example.test/back-private.png';

const snap = (over: Record<string, unknown>): BlockWorkflowSnapshot =>
  ({ workflowId: 'wf-side', status: 'succeeded', ...over }) as BlockWorkflowSnapshot;

const char: Character = {
  id: 'char-1',
  name: 'Morov',
  description: 'An old lighthouse keeper',
  traits: [],
  triggerWords: [],
  negativePrompt: '',
  seedPolicy: 'locked',
  createdAt: '2026-10-01T22:00:00.000Z',
  updatedAt: '2026-10-01T22:00:00.000Z',
};

const stack: ModelStack = {
  id: 'stack-1',
  name: 'Zeta Stack',
  checkpoint: { modelId: 101055, modelVersionId: 128078, baseModel: 'SDXL 1.0', name: 'SDXL 1.0' },
  loras: [],
  notes: '',
  createdAt: '2026-10-01T22:00:00.000Z',
  updatedAt: '2026-10-01T22:00:00.000Z',
};

function panel(over: Partial<SheetPanel>): SheetPanel {
  return {
    id: 'p1',
    kind: 'side',
    label: 'Side view',
    promptModifier: 'side view',
    seed: 42,
    status: 'done',
    outputs: [],
    submitNonce: 1,
    ...over,
  };
}

function sheetWith(panels: SheetPanel[]): SheetJob {
  return {
    id: 'sheet-1',
    name: 'Morov turnaround',
    characterId: 'char-1',
    stackId: 'stack-1',
    seed: 42,
    account: 'auto',
    useReference: false,
    status: 'complete',
    panels,
    createdAt: '2026-10-01T22:00:00.000Z',
    updatedAt: '2026-10-01T22:00:00.000Z',
  };
}

function renderSheet(sheet: SheetJob, saved: SheetJob[]) {
  const library: SheetLibrary = {
    ready: true,
    characters: [char],
    stacks: [stack],
    sheets: [sheet],
    settings: DEFAULT_SETTINGS,
    quota: null,
    saveCharacter: async () => null,
    deleteCharacter: async () => null,
    saveStack: async () => null,
    deleteStack: async () => null,
    saveSheet: async (s) => {
      saved.push(s);
      return null;
    },
    deleteSheet: async () => null,
    saveSettings: async () => null,
    refreshQuota: async () => undefined,
  };
  return render(
    <SheetView
      library={library}
      sheetId="sheet-1"
      onBack={() => {}}
      onNewSheet={() => {}}
      onRegenerateSheet={() => {}}
    />,
  );
}

afterEach(() => {
  host.replies.clear();
  host.publishCalls.length = 0;
  host.publishIds.length = 0;
  host.shareCalls.length = 0;
  host.publishRejects = false;
});

describe('Share sheet (owner)', () => {
  let uninstall: (() => void) | undefined;
  afterEach(() => {
    uninstall?.();
    uninstall = undefined;
  });

  it('writes a shared record of image IDs only, publishing just the unpublished panel at its position', async () => {
    uninstall = installMockMoneyHost({ consentGranted: true });
    // The side panel's image is at position 1 of its workflow (0 is restricted).
    host.replies.set('wf-side', [
      snap({ outputs: [{ restricted: true, reason: 'ceiling' }, { url: SIDE_URL, nsfwLevel: 'pg' }] }),
    ]);
    host.publishIds.push([90817]);
    const saved: SheetJob[] = [];
    renderSheet(
      sheetWith([
        panel({ id: 'p1', label: 'Side view', workflowId: 'wf-side', outputs: [SIDE_URL] }),
        // Already published: reused, never published again.
        panel({
          id: 'p2',
          kind: 'back',
          label: 'Back view',
          workflowId: 'wf-back',
          outputs: [BACK_URL],
          published: true,
          publishedImageId: 31337,
        }),
        // Not finished: left out.
        panel({ id: 'p3', kind: 'front', label: 'Front view', status: 'failed', workflowId: 'wf-front' }),
      ]),
      saved,
    );

    fireEvent.click(await screen.findByTestId('se-share-sheet'));
    await screen.findByText('Shared 2 panels. Press Copy link to send it.', {}, { timeout: 8000 });

    expect(host.publishCalls).toEqual([{ workflowId: 'wf-side', imageIndexes: [1], title: 'Side view' }]);

    const page = await testDocStore().storage.collection('shared_sheets').list();
    expect(page.items).toHaveLength(1);
    const record = page.items[0];
    expect(record.data).toEqual({
      v: 1,
      characterName: 'Morov',
      sheetName: 'Morov turnaround',
      panels: [
        { label: 'Side view', imageId: 90817 },
        { label: 'Back view', imageId: 31337 },
      ],
    });
    // 🔴 No url of any kind reaches the shared record.
    const raw = JSON.stringify(record.data);
    expect(raw).not.toContain('://');
    expect(raw).not.toContain(SIDE_URL);
    expect(raw).not.toContain(BACK_URL);

    // The sheet remembers its record and the new image ID.
    expect(saved.at(-1)?.shareKey).toBe(record.key);
    expect(saved.at(-1)?.panels.find((p) => p.id === 'p1')?.publishedImageId).toBe(90817);

    // Copy link asks the host for exactly the share route, from the click.
    fireEvent.click(await screen.findByTestId('se-copy-link'));
    expect(host.shareCalls).toEqual([{ subPath: `share/${record.key}` }]);
  }, 20000);

  it('a closed publish confirm writes no record', async () => {
    uninstall = installMockMoneyHost({ consentGranted: true });
    host.replies.set('wf-side', [snap({ outputs: [{ url: SIDE_URL, nsfwLevel: 'pg' }] })]);
    host.publishRejects = true;
    renderSheet(
      sheetWith([panel({ id: 'p1', workflowId: 'wf-side', outputs: [SIDE_URL] })]),
      [],
    );
    fireEvent.click(await screen.findByTestId('se-share-sheet'));
    await screen.findByTestId('se-share-notice', {}, { timeout: 8000 });
    expect(screen.getByTestId('se-share-notice')).toHaveTextContent('Couldn’t share the sheet.');
    expect(screen.queryByTestId('se-copy-link')).toBeNull();
    const page = await testDocStore().storage.collection('shared_sheets').list();
    expect(page.items).toHaveLength(0);
  }, 20000);
});
