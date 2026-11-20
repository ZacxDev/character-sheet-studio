// 0.3.3: stopping a share and the share edges 0.3.2 left open.
//   - "Stop sharing" deletes the sheet's shared record, so the link stops
//     working for everyone, and forgets the key on the sheet;
//   - deleting a shared sheet deletes its shared record first;
//   - a sheet whose finished panels can no longer be read (old workflows) says
//     so, instead of "Nothing to share yet";
//   - without the apps:storage:publish grant, Share asks the host for it.
// The store is the SDK fake over the committed manifest (test-setup).

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import type { BlockWorkflowSnapshot } from '@civitai/app-sdk/blocks';

const host = vi.hoisted(() => ({
  replies: new Map<string, unknown[]>(),
  publishCalls: [] as unknown[],
  consentCalls: [] as unknown[],
  grantPublish: true,
}));

vi.mock('@civitai/blocks-react', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@civitai/blocks-react')>();
  return {
    ...mod,
    useBlockToken: () => {
      const real = mod.useBlockToken();
      return host.grantPublish
        ? { ...real, scopes: [...(real.scopes ?? []), 'apps:storage:publish'] }
        : { ...real, scopes: (real.scopes ?? []).filter((s) => s !== 'apps:storage:publish') };
    },
    useRequestConsent: () => ({
      requestConsent: (req: unknown) => {
        host.consentCalls.push(req);
      },
    }),
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
        return [];
      },
    }),
  };
});

import { installMockMoneyHost } from './mock-buzz.js';
import { SharedSheetView } from './screens/SharedSheetView.js';
import { SheetView } from './screens/SheetView.js';
import { DEFAULT_SETTINGS, type SheetJob, type SheetPanel } from './sheet/types.js';
import type { SheetLibrary } from './sheet/useSheetLibrary.js';
import { testDocStore } from './test-doc-store.js';

const RECORD = {
  v: 1,
  characterName: 'Adventure Miner',
  sheetName: 'Adventure Miner sheet',
  panels: [{ label: 'Front view', imageId: 4242 }],
};

function panel(over: Partial<SheetPanel>): SheetPanel {
  return {
    id: 'p1',
    kind: 'front',
    label: 'Front view',
    promptModifier: 'front view',
    seed: 42,
    status: 'done',
    workflowId: 'wf-old',
    outputs: ['https://image.example.test/front.png'],
    submitNonce: 1,
    ...over,
  };
}

function sheetWith(over: Partial<SheetJob>): SheetJob {
  return {
    id: 'sheet-1',
    name: 'Adventure Miner sheet',
    characterId: 'char-1',
    stackId: 'stack-1',
    seed: 42,
    account: 'auto',
    useReference: false,
    status: 'complete',
    panels: [panel({})],
    createdAt: '2026-10-01T22:00:00.000Z',
    updatedAt: '2026-10-01T22:00:00.000Z',
    ...over,
  };
}

function renderSheet(sheet: SheetJob, saved: SheetJob[], deleted: string[] = [], onBack = () => {}) {
  const library: SheetLibrary = {
    ready: true,
    characters: [],
    stacks: [],
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
    deleteSheet: async (id) => {
      deleted.push(id);
      return null;
    },
    saveSettings: async () => null,
    refreshQuota: async () => undefined,
  };
  return render(
    <SheetView library={library} sheetId={sheet.id} onBack={onBack} onNewSheet={() => {}} onRegenerateSheet={() => {}} />,
  );
}

async function sharedRecord(): Promise<string> {
  const doc = await testDocStore().storage.collection('shared_sheets').create(RECORD);
  return doc.key;
}

const recordAt = (key: string) => testDocStore().storage.collection('shared_sheets').get(key);

describe('0.3.3 share edges', () => {
  let uninstall: (() => void) | undefined;
  afterEach(() => {
    uninstall?.();
    uninstall = undefined;
    host.replies.clear();
    host.publishCalls.length = 0;
    host.consentCalls.length = 0;
    host.grantPublish = true;
  });

  it('Stop sharing deletes the shared record and forgets the key', async () => {
    uninstall = installMockMoneyHost({ consentGranted: true });
    const key = await sharedRecord();
    const saved: SheetJob[] = [];
    renderSheet(sheetWith({ shareKey: key }), saved);

    const unshareBtn = await screen.findByTestId('se-unshare-sheet', {}, { timeout: 8000 });
    const savesBefore = saved.length;
    fireEvent.click(unshareBtn);

    await waitFor(async () => expect(await recordAt(key)).toBeNull(), { timeout: 8000 });
    // The key is gone from the SAVED sheet, not just from the screen.
    await waitFor(() => expect(saved.length).toBeGreaterThan(savesBefore));
    expect('shareKey' in saved.at(-1)!).toBe(false);
    expect(screen.queryByTestId('se-copy-link')).toBeNull();
    expect(screen.getByTestId('se-share-notice')).toHaveTextContent(
      'Stopped sharing. The link no longer opens this sheet. Images you published stay on Civitai.',
    );

    // The stopped link, opened by another viewer: not available, no images.
    cleanup();
    render(<SharedSheetView shareKey={key} onGallery={() => {}} />);
    expect(await screen.findByTestId('ss-unavailable', {}, { timeout: 8000 })).toHaveTextContent(
      'This shared sheet isn’t available any more.',
    );
    expect(screen.queryByRole('img')).toBeNull();
  }, 25000);

  it('a share record that cannot be removed keeps the sheet (no orphaned link)', async () => {
    uninstall = installMockMoneyHost({ consentGranted: true });
    // Another author's record: this viewer's delete is refused (write: own).
    const theirs = await testDocStore()
      .as({ viewer: { username: 'someone-else' } })
      .storage.collection('shared_sheets')
      .create(RECORD);
    const deleted: string[] = [];
    renderSheet(sheetWith({ shareKey: theirs.key }), [], deleted);

    fireEvent.click(await screen.findByTestId('se-sheet-menu', {}, { timeout: 8000 }));
    fireEvent.click(await screen.findByTestId('se-sheet-delete'));
    fireEvent.click(await screen.findByTestId('se-sheet-delete-confirm'));

    expect(
      await screen.findByText('Couldn’t remove this sheet’s share link, so the sheet was kept. Try again.', {}, { timeout: 8000 }),
    ).toBeInTheDocument();
    expect(deleted).toEqual([]);
    expect(await recordAt(theirs.key)).not.toBeNull();
  }, 20000);

  it('deleting a shared sheet deletes its shared record too', async () => {
    uninstall = installMockMoneyHost({ consentGranted: true });
    const key = await sharedRecord();
    const deleted: string[] = [];
    renderSheet(sheetWith({ shareKey: key }), [], deleted);

    fireEvent.click(await screen.findByTestId('se-sheet-menu', {}, { timeout: 8000 }));
    fireEvent.click(await screen.findByTestId('se-sheet-delete'));
    fireEvent.click(await screen.findByTestId('se-sheet-delete-confirm'));

    await waitFor(() => expect(deleted).toEqual(['sheet-1']), { timeout: 8000 });
    expect(await recordAt(key)).toBeNull();
  }, 20000);

  it('finished panels whose results are gone say so, not "Nothing to share yet"', async () => {
    uninstall = installMockMoneyHost({ consentGranted: true });
    host.replies.set('wf-old', [{ workflowId: 'wf-old', status: 'failed' }]);
    renderSheet(sheetWith({}), []);

    fireEvent.click(await screen.findByTestId('se-share-sheet', {}, { timeout: 8000 }));
    const notice = await screen.findByTestId('se-share-notice', {}, { timeout: 8000 });
    expect(notice).toHaveTextContent(
      'These panels can’t be shared: Civitai no longer has their results. Regenerate a panel to share it.',
    );
    expect(host.publishCalls).toEqual([]);
  }, 20000);

  it('without the publish grant, Share asks the host for apps:storage:publish', async () => {
    uninstall = installMockMoneyHost({ consentGranted: true });
    host.grantPublish = false;
    renderSheet(sheetWith({}), []);

    fireEvent.click(await screen.findByTestId('se-share-sheet', {}, { timeout: 8000 }));
    expect(await screen.findByTestId('se-share-notice')).toHaveTextContent(
      'Approve sharing in the Civitai dialog, then press Share sheet again.',
    );
    expect(host.consentCalls).toEqual([{ scopes: ['apps:storage:publish'] }]);
    expect(host.publishCalls).toEqual([]);
  }, 20000);
});
