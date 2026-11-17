// Rating-pending / restricted-output contract (civitai#8994 host behaviour).
//
// The host can answer a finished generation with `status: 'succeeded'` while
// its only image is still being rated: the unrated output is withheld from
// `imageUrls` and the snapshot carries `ratingPending: true` (+ `outputs`
// entries `{ pending: true }`). An app that stops polling at the first
// `succeeded` saves an empty panel for good — the viewer paid and got nothing.
// A later host build may instead report a NON-terminal status while rating is
// pending; both shapes must keep the panel polling.
//
// `outputs` can also carry `{ restricted: true, reason }` / `{ blocked: true }`
// entries — no url, shown as a locked tile, never as "No image yet".
//
// Poll replies are scripted per workflow through a partial mock of
// useBuzzWorkflow().poll; everything else runs against the SDK mock host.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

import type { BlockWorkflowSnapshot } from '@civitai/app-sdk/blocks';

const pollScript = vi.hoisted(() => ({
  replies: new Map<string, unknown[]>(),
  calls: [] as string[],
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
          pollScript.calls.push(workflowId);
          const queue = pollScript.replies.get(workflowId);
          if (!queue || queue.length === 0) throw new Error('unscripted poll');
          // The last scripted reply repeats.
          return (queue.length > 1 ? queue.shift() : queue[0]) as BlockWorkflowSnapshot;
        },
      };
    },
  };
});

import { installMockMoneyHost } from './mock-buzz.js';
import { startPollLoop } from './money/pollLoop.js';
import { SheetView } from './screens/SheetView.js';
import { panelPatchForFinal } from './sheet/batch.js';
import {
  DEFAULT_SETTINGS,
  type Character,
  type ModelStack,
  type SheetJob,
  type SheetPanel,
} from './sheet/types.js';
import type { SheetLibrary } from './sheet/useSheetLibrary.js';

const IMG = 'https://image.example.test/recovered-front.png';

const snap = (over: Record<string, unknown>): BlockWorkflowSnapshot =>
  ({ workflowId: 'wf-a', status: 'processing', ...over }) as BlockWorkflowSnapshot;

const SUCCEEDED_PENDING = snap({
  status: 'succeeded',
  imageUrls: [],
  outputs: [{ pending: true }],
  ratingPending: true,
});
const SUCCEEDED_RATED = snap({
  status: 'succeeded',
  imageUrls: [IMG],
  outputs: [{ url: IMG, nsfwLevel: 'pg' }],
});

// --- the poll loop -----------------------------------------------------------

interface LoopRun {
  snapshots: BlockWorkflowSnapshot[];
  finals: boolean[];
  poll: ReturnType<typeof vi.fn>;
}

/** Drive the loop over a scripted reply list; resolve once it has been idle. */
function runLoop(
  replies: BlockWorkflowSnapshot[],
  opts: Parameters<typeof startPollLoop>[3] = {},
): Promise<LoopRun> {
  const queue = [...replies];
  const poll = vi.fn(async () => (queue.length > 1 ? queue.shift() : queue[0]) as BlockWorkflowSnapshot);
  const snapshots: BlockWorkflowSnapshot[] = [];
  const finals: boolean[] = [];
  return new Promise((resolve) => {
    let idle: ReturnType<typeof setTimeout> | undefined;
    const settle = () => {
      clearTimeout(idle);
      idle = setTimeout(() => {
        cancel();
        resolve({ snapshots, finals, poll });
      }, 60);
    };
    const cancel = startPollLoop(
      poll,
      'wf-a',
      {
        onSnapshot: (s: BlockWorkflowSnapshot, final?: boolean) => {
          snapshots.push(s);
          finals.push(final === true);
          settle();
        },
        onUnreachable: () => settle(),
      },
      { scheduleMs: [5], retryMs: [5], ...opts },
    );
    settle();
  });
}

describe('startPollLoop with a rating-pending host', () => {
  it('succeeded + ratingPending keeps polling; the rated snapshot is the final one', async () => {
    const { snapshots, finals, poll } = await runLoop([
      SUCCEEDED_PENDING,
      SUCCEEDED_PENDING,
      SUCCEEDED_RATED,
    ]);
    expect(poll).toHaveBeenCalledTimes(3);
    expect(snapshots.map((s) => s.imageUrls)).toEqual([[], [], [IMG]]);
    expect(finals).toEqual([false, false, true]);
  });

  it('an outputs entry still { pending: true } counts as pending even without the flag', async () => {
    const { poll, finals } = await runLoop([
      snap({ status: 'succeeded', imageUrls: [], outputs: [{ pending: true }] }),
      SUCCEEDED_RATED,
    ]);
    expect(poll).toHaveBeenCalledTimes(2);
    expect(finals).toEqual([false, true]);
  });

  // Invariant guard (the old loop already kept polling non-terminal statuses):
  // the host compat fix reports `processing` while rating is pending.
  it('processing while rating is pending keeps polling (host compat shape)', async () => {
    const { poll, finals } = await runLoop([
      snap({ status: 'processing', ratingPending: true, outputs: [{ pending: true }] }),
      SUCCEEDED_RATED,
    ]);
    expect(poll).toHaveBeenCalledTimes(2);
    expect(finals).toEqual([false, true]);
  });

  it('is bounded: a rating that never lands ends the loop at the deadline, flagged final', async () => {
    let t = 0;
    const { poll, finals, snapshots } = await runLoop([SUCCEEDED_PENDING], {
      ratingPendingMaxMs: 1000,
      now: () => (t += 400),
    });
    // Pending first seen at t=400; 800 / 1200 are inside the window; 1600 is past it.
    expect(poll).toHaveBeenCalledTimes(4);
    expect(finals).toEqual([false, false, false, true]);
    expect((snapshots.at(-1) as { ratingPending?: boolean }).ratingPending).toBe(true);
  });

  it('a failed status is final at once (rating only holds a succeeded panel)', async () => {
    const { poll, finals } = await runLoop([
      snap({ status: 'failed', error: 'boom', ratingPending: true }),
    ]);
    expect(poll).toHaveBeenCalledTimes(1);
    expect(finals).toEqual([true]);
  });
});

describe('panelPatchForFinal', () => {
  it('a rated succeeded snapshot yields its urls', () => {
    expect(panelPatchForFinal(SUCCEEDED_RATED)).toEqual({ outputs: [IMG], locked: undefined });
  });

  it('a restricted output yields a locked state and no url', () => {
    expect(
      panelPatchForFinal(
        snap({ status: 'succeeded', imageUrls: [], outputs: [{ restricted: true, reason: 'pool' }] }),
      ),
    ).toEqual({ outputs: [], locked: 'pool' });
  });

  it('a moderation-blocked output yields the unavailable lock', () => {
    expect(
      panelPatchForFinal(snap({ status: 'succeeded', imageUrls: [], outputs: [{ blocked: true }] })),
    ).toEqual({ outputs: [], locked: 'blocked' });
  });

  it('still rating-pending (deadline hit) saves NO url, even one in imageUrls', () => {
    expect(
      panelPatchForFinal(
        snap({ status: 'succeeded', imageUrls: [IMG], outputs: [{ pending: true }], ratingPending: true }),
      ),
    ).toEqual({ outputs: [], locked: 'rating-pending' });
  });

  it('an old host (no outputs) falls back to imageUrls', () => {
    expect(panelPatchForFinal(snap({ status: 'succeeded', imageUrls: [IMG] }))).toEqual({
      outputs: [IMG],
      locked: undefined,
    });
  });

  it('a non-succeeded snapshot is not a panel result', () => {
    expect(panelPatchForFinal(snap({ status: 'failed' }))).toBeNull();
  });
});

// --- Sheet View -----------------------------------------------------------------

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
    kind: 'front',
    label: 'Front view',
    promptModifier: 'front view',
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
    account: 'auto',
    useReference: false,
    status: 'running',
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

const lastPanel = (saved: SheetJob[], id = 'p1') =>
  saved.at(-1)?.panels.find((p) => p.id === id);

describe('Sheet View with a rating-pending host', () => {
  let uninstall: (() => void) | undefined;
  afterEach(() => {
    uninstall?.();
    uninstall = undefined;
    pollScript.replies.clear();
    pollScript.calls.length = 0;
  });

  it('a running panel answered succeeded+ratingPending keeps polling and saves the rated url', async () => {
    uninstall = installMockMoneyHost({ consentGranted: true });
    pollScript.replies.set('wf-a', [SUCCEEDED_PENDING, SUCCEEDED_RATED]);
    const saved: SheetJob[] = [];
    renderSheet(sheetWith([panel({ workflowId: 'wf-a' })]), saved);

    const img = await screen.findByRole('img', { name: 'Front view' }, { timeout: 8000 });
    expect(img).toHaveAttribute('src', IMG);
    // Never saved as done-with-no-image on the way.
    expect(saved.some((s) => s.panels[0].status === 'done' && s.panels[0].outputs.length === 0)).toBe(false);
    expect(lastPanel(saved)).toMatchObject({ status: 'done', outputs: [IMG] });
  }, 15000);

  it('a restricted output shows a locked tile, not "No image yet"', async () => {
    uninstall = installMockMoneyHost({ consentGranted: true });
    pollScript.replies.set('wf-a', [
      snap({ status: 'succeeded', imageUrls: [], outputs: [{ restricted: true, reason: 'ceiling' }] }),
    ]);
    const saved: SheetJob[] = [];
    renderSheet(sheetWith([panel({ workflowId: 'wf-a' })]), saved);

    const tile = await screen.findByTestId('se-panel-locked', {}, { timeout: 8000 });
    expect(tile).toHaveTextContent(/Restricted/);
    expect(document.body).not.toHaveTextContent('No image yet');
    expect(screen.queryByRole('img', { name: 'Front view' })).toBeNull();
    expect(lastPanel(saved)).toMatchObject({ status: 'done', outputs: [], locked: 'ceiling' });
  }, 15000);

  it('repair: a done panel saved with no image is re-polled on open and the recovered url saved', async () => {
    uninstall = installMockMoneyHost({ consentGranted: true });
    pollScript.replies.set('wf-a', [SUCCEEDED_RATED]);
    const saved: SheetJob[] = [];
    renderSheet(
      sheetWith([
        panel({ id: 'p1', workflowId: 'wf-a', status: 'done' }),
        // A done panel WITH an image and a queued one are left alone.
        panel({
          id: 'p2',
          label: 'Side view',
          workflowId: 'wf-b',
          status: 'done',
          outputs: ['https://image.example.test/kept.png'],
        }),
        panel({ id: 'p3', label: 'Back view', status: 'queued', submitNonce: 0 }),
      ]),
      saved,
    );

    await waitFor(() => expect(lastPanel(saved)).toMatchObject({ status: 'done', outputs: [IMG] }), {
      timeout: 8000,
    });
    expect(await screen.findByRole('img', { name: 'Front view' })).toHaveAttribute('src', IMG);
    expect(pollScript.calls.every((id) => id === 'wf-a')).toBe(true);
    expect(lastPanel(saved, 'p2')?.outputs).toEqual(['https://image.example.test/kept.png']);
  }, 15000);

  it('repair saves nothing while the snapshot is still rating-pending', async () => {
    uninstall = installMockMoneyHost({ consentGranted: true });
    pollScript.replies.set('wf-a', [
      snap({ status: 'succeeded', imageUrls: [IMG], outputs: [{ pending: true }], ratingPending: true }),
    ]);
    const saved: SheetJob[] = [];
    renderSheet(sheetWith([panel({ workflowId: 'wf-a', status: 'done' })]), saved);

    await waitFor(() => expect(pollScript.calls.length).toBeGreaterThanOrEqual(2), { timeout: 8000 });
    expect(saved.some((s) => s.panels[0].outputs.length > 0)).toBe(false);
    expect(screen.queryByRole('img', { name: 'Front view' })).toBeNull();
  }, 15000);
});
