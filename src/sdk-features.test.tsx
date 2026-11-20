// Sheet View wiring for the App SDK 0.91 features:
//   - unlock a restricted panel in place (REQUEST_OUTPUT_UNLOCK, HQ app_blocks_sdk_e982);
//   - use a finished panel as the character's reference portrait with no publish
//     dialog (PERSIST_GENERATION_SOURCE, HQ app_blocks_sdk_x7dw);
//   - queue position, ETA and progress on a generating panel (snapshot `eta`,
//     HQ app_blocks_sdk_1gm9).
//
// Poll replies are scripted per workflow, and the unlock / persist hooks are
// spies, through a partial mock of @civitai/blocks-react. Everything else runs
// against the SDK mock host. This file imports only modules that predate the
// features, so on the pre-change code it fails on the missing behaviour, not on
// an import.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import type { BlockWorkflowSnapshot } from '@civitai/app-sdk/blocks';

const host = vi.hoisted(() => ({
  replies: new Map<string, unknown[]>(),
  unlockCalls: [] as Array<[string, number]>,
  unlockResult: null as unknown,
  persistCalls: [] as unknown[],
  persistResult: null as unknown,
}));

vi.mock('@civitai/blocks-react', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@civitai/blocks-react')>();
  return {
    ...mod,
    useBuzzWorkflow: () => {
      const real = mod.useBuzzWorkflow();
      return {
        ...real,
        poll: async (workflowId: string) => {
          const queue = host.replies.get(workflowId);
          if (!queue || queue.length === 0) throw new Error('unscripted poll');
          // The last scripted reply repeats.
          return (queue.length > 1 ? queue.shift() : queue[0]) as BlockWorkflowSnapshot;
        },
      };
    },
    useOutputUnlock: () => ({
      unlockOutput: async (workflowId: string, position: number) => {
        host.unlockCalls.push([workflowId, position]);
        return host.unlockResult;
      },
    }),
    usePersistGenerationSource: () => ({
      persist: async (args: unknown) => {
        host.persistCalls.push(args);
        return host.persistResult;
      },
      isPending: false,
      error: null,
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

const UNLOCKED_URL = 'https://image.example.test/unlocked-side.png';
const PANEL_URL = 'https://image.example.test/front-panel.png';
const PERSISTED_URL = 'https://image.example.test/persisted-source.jpeg';

const snap = (over: Record<string, unknown>): BlockWorkflowSnapshot =>
  ({ workflowId: 'wf-a', status: 'processing', ...over }) as BlockWorkflowSnapshot;

const char: Character = {
  id: 'char-1',
  name: 'Kaida',
  description: 'A cyberpunk street samurai',
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
    status: 'running',
    outputs: [],
    submitNonce: 1,
    ...over,
  };
}

function sheetWith(panels: SheetPanel[]): SheetJob {
  return {
    id: 'sheet-1',
    name: 'Kaida sheet',
    characterId: 'char-1',
    stackId: 'stack-1',
    seed: 42,
    account: 'blue',
    useReference: false,
    status: 'running',
    panels,
    createdAt: '2026-10-01T22:00:00.000Z',
    updatedAt: '2026-10-01T22:00:00.000Z',
  };
}

function renderSheet(sheet: SheetJob, saved: SheetJob[], savedChars: Character[] = []) {
  const library: SheetLibrary = {
    ready: true,
    characters: [char],
    stacks: [stack],
    sheets: [sheet],
    settings: DEFAULT_SETTINGS,
    quota: null,
    saveCharacter: async (c) => {
      savedChars.push(c);
      return null;
    },
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

const lastPanel = (saved: SheetJob[], id = 'p1') => saved.at(-1)?.panels.find((p) => p.id === id);

describe('Sheet View with the App SDK 0.91 features', () => {
  let uninstall: (() => void) | undefined;
  afterEach(() => {
    uninstall?.();
    uninstall = undefined;
    host.replies.clear();
    host.unlockCalls.length = 0;
    host.unlockResult = null;
    host.persistCalls.length = 0;
    host.persistResult = null;
  });

  it('unlock: a pool-restricted panel unlocks in place at the restricted POSITION and saves the url', async () => {
    uninstall = installMockMoneyHost({ consentGranted: true });
    // Position 0 is a moderation block, position 1 the pool-restricted output:
    // the unlock must name 1, never 0 or an imageUrls index.
    host.replies.set('wf-a', [
      snap({
        status: 'succeeded',
        imageUrls: [],
        outputs: [{ blocked: true }, { restricted: true, reason: 'pool' }],
      }),
    ]);
    host.unlockResult = {
      outcome: 'unlocked',
      snapshot: snap({
        status: 'succeeded',
        imageUrls: [UNLOCKED_URL],
        outputs: [{ blocked: true }, { url: UNLOCKED_URL, nsfwLevel: 'r' }],
      }),
    };
    const saved: SheetJob[] = [];
    renderSheet(sheetWith([panel({ workflowId: 'wf-a', status: 'done', locked: 'pool' })]), saved);

    const unlock = await screen.findByRole('button', { name: 'Unlock with Yellow Buzz' });
    fireEvent.click(unlock);

    const img = await screen.findByRole('img', { name: 'Side view' }, { timeout: 8000 });
    expect(img).toHaveAttribute('src', UNLOCKED_URL);
    expect(host.unlockCalls).toEqual([['wf-a', 1]]);
    expect(lastPanel(saved)).toMatchObject({ status: 'done', outputs: [UNLOCKED_URL], locked: undefined });
  }, 15000);

  it('unlock: a ceiling-restricted panel that links out to civitai.red says so and saves nothing', async () => {
    uninstall = installMockMoneyHost({ consentGranted: true });
    host.replies.set('wf-a', [
      snap({ status: 'succeeded', imageUrls: [], outputs: [{ restricted: true, reason: 'ceiling' }] }),
    ]);
    host.unlockResult = { outcome: 'linked-out' };
    const saved: SheetJob[] = [];
    renderSheet(sheetWith([panel({ workflowId: 'wf-a', status: 'done', locked: 'ceiling' })]), saved);

    fireEvent.click(await screen.findByRole('button', { name: 'Where can I see it?' }));

    const notice = await screen.findByTestId('se-panel-notice', {}, { timeout: 8000 });
    expect(notice).toHaveTextContent(
      'Opened on civitai.red, where this image can be shown. Nothing was charged.',
    );
    expect(host.unlockCalls).toEqual([['wf-a', 0]]);
    expect(saved.some((s) => s.panels[0].outputs.length > 0)).toBe(false);
  }, 15000);

  it('a moderation-blocked panel offers no unlock', async () => {
    uninstall = installMockMoneyHost({ consentGranted: true });
    renderSheet(sheetWith([panel({ workflowId: 'wf-a', status: 'done', locked: 'blocked' })]), []);
    await screen.findByTestId('se-panel-locked');
    expect(screen.queryByTestId('se-panel-unlock')).toBeNull();
  });

  it('use as reference: persists the panel output at its POSITION, with no publish, and saves it on the character', async () => {
    uninstall = installMockMoneyHost({ consentGranted: true });
    // The panel's image sits at position 1 (position 0 is restricted).
    host.replies.set('wf-a', [
      snap({
        status: 'succeeded',
        imageUrls: [PANEL_URL],
        outputs: [{ restricted: true, reason: 'ceiling' }, { url: PANEL_URL, nsfwLevel: 'pg' }],
      }),
    ]);
    host.persistResult = { url: PERSISTED_URL, width: 832, height: 1216, imageId: 987654, ready: true };
    const savedChars: Character[] = [];
    renderSheet(
      sheetWith([panel({ workflowId: 'wf-a', status: 'done', outputs: [PANEL_URL] })]),
      [],
      savedChars,
    );

    fireEvent.click(await screen.findByTestId('se-panel-more'));
    fireEvent.click(await screen.findByRole('button', { name: 'Use as reference' }));

    const notice = await screen.findByTestId('se-panel-notice', {}, { timeout: 8000 });
    expect(notice).toHaveTextContent('Now Kaida’s reference portrait.');
    expect(host.persistCalls).toEqual([{ workflowId: 'wf-a', imageIndex: 1 }]);
    expect(savedChars).toHaveLength(1);
    // The host's scan flag is kept (civitai#9189); imageId is not needed.
    expect(savedChars[0].referenceImage).toEqual({ url: PERSISTED_URL, width: 832, height: 1216, ready: true });
  }, 15000);

  it('use as reference: a source still being scanned says the next run may wait', async () => {
    uninstall = installMockMoneyHost({ consentGranted: true });
    host.replies.set('wf-a', [
      snap({ status: 'succeeded', imageUrls: [PANEL_URL], outputs: [{ url: PANEL_URL, nsfwLevel: 'pg' }] }),
    ]);
    host.persistResult = { url: PERSISTED_URL, width: 640, height: 960, imageId: 5, ready: false };
    renderSheet(sheetWith([panel({ workflowId: 'wf-a', status: 'done', outputs: [PANEL_URL] })]), []);

    fireEvent.click(await screen.findByTestId('se-panel-more'));
    fireEvent.click(await screen.findByRole('button', { name: 'Use as reference' }));

    const notice = await screen.findByTestId('se-panel-notice', {}, { timeout: 8000 });
    expect(notice).toHaveTextContent('It is still being checked');
    expect(host.persistCalls).toEqual([{ workflowId: 'wf-a', imageIndex: 0 }]);
  }, 15000);

  it('queue ETA: a queued panel shows its position, then a running one shows progress', async () => {
    uninstall = installMockMoneyHost({ consentGranted: true });
    host.replies.set('wf-a', [
      snap({
        status: 'pending',
        eta: {
          stepName: '$0',
          queuedAhead: 7,
          startsAt: null,
          completesAt: null,
          progress: null,
          support: 'available',
        },
      }),
      snap({
        status: 'processing',
        eta: {
          stepName: '$0',
          queuedAhead: null,
          startsAt: null,
          completesAt: null,
          progress: 0.37,
          support: null,
        },
      }),
    ]);
    renderSheet(sheetWith([panel({ workflowId: 'wf-a' })]), []);

    const eta = await screen.findByTestId('se-panel-eta', {}, { timeout: 8000 });
    expect(eta).toHaveTextContent('7 ahead in queue');
    await waitFor(() => expect(screen.getByTestId('se-panel-eta')).toHaveTextContent('37% done'), {
      timeout: 8000,
    });
    expect(screen.getByRole('progressbar', { name: 'Side view progress' })).toHaveAttribute(
      'aria-valuenow',
      '37',
    );
  }, 20000);
});
