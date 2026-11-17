// Restricted-reason handling, bounded repair-on-open, and serialized repair
// writes (audit of PR #2, host civitai#9328).
//
// civitai#9328 masks `succeeded` → `processing` for up to 5 minutes while an
// output is unrated, then answers `succeeded` with the output
// `{ restricted: true, reason: 'unrated' }` and `ratingPending` cleared; a LATER
// poll returns the url once the rating lands. So a restricted output is not
// necessarily permanent — it depends on `reason`:
//   unrated  — the rating has not landed yet           → repairable
//   ceiling  — the viewer's own content settings       → repairable
//   pool     — the paying Buzz account's pool          → permanent
//   blocked  — moderation                              → permanent
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
          return (queue.length > 1 ? queue.shift() : queue[0]) as BlockWorkflowSnapshot;
        },
      };
    },
  };
});

import { installMockMoneyHost } from './mock-buzz.js';
import { SheetView } from './screens/SheetView.js';
import { panelPatchForFinal, repairablePanels } from './sheet/batch.js';
import {
  DEFAULT_SETTINGS,
  normalizeSheetJob,
  type Character,
  type ModelStack,
  type SheetJob,
  type SheetPanel,
} from './sheet/types.js';
import type { SheetLibrary } from './sheet/useSheetLibrary.js';

const IMG = 'https://image.example.test/late-rated.png';

const snap = (over: Record<string, unknown>): BlockWorkflowSnapshot =>
  ({ workflowId: 'wf-a', status: 'processing', ...over }) as BlockWorkflowSnapshot;

const restricted = (reason?: string, workflowId = 'wf-a') =>
  snap({
    workflowId,
    status: 'succeeded',
    imageUrls: [],
    outputs: [{ restricted: true, ...(reason !== undefined ? { reason } : {}) }],
  });

const rated = (url: string, workflowId = 'wf-a') =>
  snap({ workflowId, status: 'succeeded', imageUrls: [url], outputs: [{ url, nsfwLevel: 'pg' }] });

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
    status: 'done',
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

/**
 * Render Sheet View over `sheet`. `saveSheet` is the store: by default it
 * records every write in order; `saveDelayMs(i)` delays the i-th write, and
 * `server.value` holds whatever write RESOLVED last — a last-writer-wins store,
 * exactly like the whole-document `storage.set` underneath.
 */
function renderSheet(
  sheet: SheetJob,
  saved: SheetJob[],
  opts: { saveDelayMs?: (i: number) => number; server?: { value: SheetJob | null } } = {},
) {
  let n = 0;
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
      const i = n++;
      saved.push(s);
      const delay = opts.saveDelayMs?.(i) ?? 0;
      if (delay > 0) await new Promise((r) => setTimeout(r, delay));
      if (opts.server) opts.server.value = s;
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

/** A persisted copy of a saved sheet, as the next open would read it. */
const reload = (s: SheetJob): SheetJob => normalizeSheetJob(JSON.parse(JSON.stringify(s))) as SheetJob;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

afterEach(() => {
  pollScript.replies.clear();
  pollScript.calls.length = 0;
});

// --- finding 1: the restricted `reason` is carried through ---------------------

describe('restricted reason', () => {
  it.each([
    ['unrated', 'unrated'],
    ['ceiling', 'ceiling'],
    ['pool', 'pool'],
    ['blocked', 'blocked'],
  ])('reason %s yields lock %s', (reason, lock) => {
    expect(panelPatchForFinal(restricted(reason))).toEqual({ outputs: [], locked: lock });
  });

  it('an unknown or missing reason is the generic restricted lock', () => {
    expect(panelPatchForFinal(restricted())).toEqual({ outputs: [], locked: 'restricted' });
    expect(panelPatchForFinal(restricted('something-new'))).toEqual({ outputs: [], locked: 'restricted' });
  });

  it('unrated, ceiling and unknown are repairable; pool and blocked are permanent', () => {
    const panels = [
      panel({ id: 'u', workflowId: 'w1', locked: 'unrated' }),
      panel({ id: 'c', workflowId: 'w2', locked: 'ceiling' }),
      panel({ id: 'r', workflowId: 'w3', locked: 'restricted' }),
      panel({ id: 'rp', workflowId: 'w4', locked: 'rating-pending' }),
      panel({ id: 'none', workflowId: 'w5' }),
      panel({ id: 'pool', workflowId: 'w6', locked: 'pool' }),
      panel({ id: 'blk', workflowId: 'w7', locked: 'blocked' }),
    ];
    expect(repairablePanels(panels).map((p) => p.id)).toEqual(['u', 'c', 'r', 'rp', 'none']);
  });

  it('a lock survives a save/reload round trip', () => {
    for (const lock of ['unrated', 'ceiling', 'pool', 'blocked', 'restricted', 'rating-pending'] as const) {
      expect(reload(sheetWith([panel({ workflowId: 'wf-a', locked: lock })])).panels[0].locked).toBe(lock);
    }
  });
});

describe('Sheet View: restricted copy and unrated recovery', () => {
  let uninstall: (() => void) | undefined;
  afterEach(() => {
    uninstall?.();
    uninstall = undefined;
  });

  it('unrated → "Still being checked"; the next open recovers the url', async () => {
    uninstall = installMockMoneyHost({ consentGranted: true });
    // First open: the panel is running; the host (after its masking window)
    // answers succeeded + restricted/unrated with ratingPending cleared.
    pollScript.replies.set('wf-a', [restricted('unrated')]);
    const saved: SheetJob[] = [];
    const first = renderSheet(sheetWith([panel({ workflowId: 'wf-a', status: 'running' })]), saved);

    const tile = await screen.findByTestId('se-panel-locked', {}, { timeout: 8000 });
    expect(tile).toHaveTextContent('Still being checked');
    expect(tile).not.toHaveTextContent(/content settings/);
    expect(lastPanel(saved)).toMatchObject({ status: 'done', outputs: [], locked: 'unrated' });
    first.unmount();

    // Second open: the rating has landed — the repair re-polls and saves it.
    pollScript.replies.set('wf-a', [rated(IMG)]);
    const saved2: SheetJob[] = [];
    renderSheet(reload(saved.at(-1) as SheetJob), saved2);
    await waitFor(() => expect(lastPanel(saved2)).toMatchObject({ status: 'done', outputs: [IMG] }), {
      timeout: 8000,
    });
    expect(lastPanel(saved2)?.locked).toBeUndefined();
    expect(await screen.findByRole('img', { name: 'Front view' })).toHaveAttribute('src', IMG);
  }, 20000);

  it('ceiling says it is above your content settings', async () => {
    uninstall = installMockMoneyHost({ consentGranted: true });
    pollScript.replies.set('wf-a', [restricted('ceiling')]);
    const saved: SheetJob[] = [];
    renderSheet(sheetWith([panel({ workflowId: 'wf-a', status: 'running' })]), saved);
    const tile = await screen.findByTestId('se-panel-locked', {}, { timeout: 8000 });
    expect(tile).toHaveTextContent('This image is above your content settings, so it can’t be shown here.');
  }, 15000);

  it('pool does not tell the viewer to change their settings', async () => {
    uninstall = installMockMoneyHost({ consentGranted: true });
    pollScript.replies.set('wf-a', [restricted('pool')]);
    const saved: SheetJob[] = [];
    renderSheet(sheetWith([panel({ workflowId: 'wf-a', status: 'running' })]), saved);
    const tile = await screen.findByTestId('se-panel-locked', {}, { timeout: 8000 });
    expect(tile).toHaveTextContent('Not available for this account’s content level.');
    expect(tile).not.toHaveTextContent(/settings/i);
    expect(lastPanel(saved)).toMatchObject({ locked: 'pool' });
  }, 15000);
});

// --- finding 2: repair is bounded and remembered -------------------------------

describe('repair record', () => {
  const NOW = Date.parse('2026-11-17T12:00:00.000Z');
  const ago = (ms: number) => new Date(NOW - ms).toISOString();
  const MIN = 60_000;

  it('caps at 3 attempts and spaces them out', () => {
    const p = (id: string, repair?: SheetPanel['repair']) => panel({ id, workflowId: `wf-${id}`, repair });
    const due = repairablePanels(
      [
        p('fresh'),
        p('one-recent', { attempts: 1, lastAt: ago(1 * MIN) }),
        p('one-old', { attempts: 1, lastAt: ago(6 * MIN) }),
        p('two-recent', { attempts: 2, lastAt: ago(10 * MIN) }),
        p('two-old', { attempts: 2, lastAt: ago(31 * MIN) }),
        p('capped', { attempts: 3, lastAt: ago(30 * 24 * 60 * MIN) }),
      ],
      NOW,
    ).map((x) => x.id);
    expect(due).toEqual(['fresh', 'one-old', 'two-old']);
  });

  it('a repair record survives a save/reload round trip; junk is dropped', () => {
    const rec = { attempts: 2, lastAt: '2026-11-17T11:00:00.000Z' };
    expect(reload(sheetWith([panel({ workflowId: 'wf-a', repair: rec })])).panels[0].repair).toEqual(rec);
    const junk = reload(sheetWith([panel({ workflowId: 'wf-a', repair: { attempts: -1, lastAt: '' } as never })]));
    expect(junk.panels[0].repair).toBeUndefined();
  });
});

describe('Sheet View: bounded repair on open', () => {
  let uninstall: (() => void) | undefined;
  afterEach(() => {
    uninstall?.();
    uninstall = undefined;
  });

  it('a no-change repair still records the attempt', async () => {
    uninstall = installMockMoneyHost({ consentGranted: true });
    pollScript.replies.set('wf-a', [snap({ status: 'succeeded', imageUrls: [], outputs: [] })]);
    const saved: SheetJob[] = [];
    renderSheet(sheetWith([panel({ workflowId: 'wf-a' })]), saved);
    await waitFor(() => expect(lastPanel(saved)?.repair?.attempts).toBe(1), { timeout: 8000 });
    expect(Date.parse(lastPanel(saved)?.repair?.lastAt ?? '')).toBeGreaterThan(Date.now() - 60_000);
    expect(lastPanel(saved)?.outputs).toEqual([]);
  }, 15000);

  it('a repair whose workflow errors still records the attempt', async () => {
    uninstall = installMockMoneyHost({ consentGranted: true });
    // No reply scripted for wf-gone: every poll throws.
    const saved: SheetJob[] = [];
    renderSheet(sheetWith([panel({ workflowId: 'wf-gone' })]), saved);
    await waitFor(() => expect(pollScript.calls.length).toBeGreaterThanOrEqual(1), { timeout: 8000 });
    await waitFor(() => expect(lastPanel(saved)?.repair?.attempts).toBe(1), { timeout: 8000 });
    expect(lastPanel(saved)).toMatchObject({ status: 'done', workflowId: 'wf-gone' });
  }, 15000);

  it('stops re-polling after the cap: opens 1-3 poll, open 4 does not', async () => {
    uninstall = installMockMoneyHost({ consentGranted: true });
    pollScript.replies.set('wf-a', [snap({ status: 'succeeded', imageUrls: [], outputs: [] })]);
    let current = sheetWith([panel({ workflowId: 'wf-a' })]);
    const pollsPerOpen: number[] = [];
    for (let open = 0; open < 4; open++) {
      const before = pollScript.calls.length;
      const saved: SheetJob[] = [];
      const view = renderSheet(current, saved);
      if (open < 3) {
        await waitFor(() => expect(lastPanel(saved)?.repair?.attempts).toBe(open + 1), { timeout: 8000 });
        await waitFor(() => expect(pollScript.calls.length).toBeGreaterThan(before), { timeout: 8000 });
      } else {
        await sleep(400);
      }
      pollsPerOpen.push(pollScript.calls.length - before);
      view.unmount();
      const next = reload(saved.at(-1) ?? current);
      // Age the record past any spacing, so only the cap can stop the next open.
      current = {
        ...next,
        panels: next.panels.map((p) =>
          p.repair ? { ...p, repair: { ...p.repair, lastAt: '2020-01-01T00:00:00.000Z' } } : p,
        ),
      };
    }
    expect(pollsPerOpen.map((n) => n > 0)).toEqual([true, true, true, false]);
    expect(current.panels[0].repair?.attempts).toBe(3);
  }, 30000);

  it('a recently attempted panel is not re-polled on the next open', async () => {
    uninstall = installMockMoneyHost({ consentGranted: true });
    pollScript.replies.set('wf-a', [rated(IMG)]);
    const saved: SheetJob[] = [];
    renderSheet(
      sheetWith([panel({ workflowId: 'wf-a', repair: { attempts: 1, lastAt: new Date().toISOString() } })]),
      saved,
    );
    await sleep(400);
    expect(pollScript.calls).toEqual([]);
    expect(saved).toEqual([]);
  }, 15000);
});

// --- finding 3: N simultaneous repairs all persist -------------------------------

describe('Sheet View: concurrent repairs', () => {
  let uninstall: (() => void) | undefined;
  afterEach(() => {
    uninstall?.();
    uninstall = undefined;
  });

  it('three repairs on one open all reach the last-writer-wins store', async () => {
    uninstall = installMockMoneyHost({ consentGranted: true });
    const urls = ['a', 'b', 'c'].map((x) => `https://image.example.test/${x}.png`);
    ['a', 'b', 'c'].forEach((x, i) => pollScript.replies.set(`wf-${x}`, [rated(urls[i], `wf-${x}`)]));
    const saved: SheetJob[] = [];
    const server = { value: null as SheetJob | null };
    renderSheet(
      sheetWith(
        ['a', 'b', 'c'].map((x, i) =>
          panel({ id: `p-${x}`, label: `Panel ${x}`, kind: 'front', workflowId: `wf-${x}`, seed: i }),
        ),
      ),
      saved,
      // Earlier writes resolve LATER: unserialized writes land out of order.
      { saveDelayMs: (i) => Math.max(0, 300 - 100 * i), server },
    );
    await waitFor(
      () => {
        const out = Object.fromEntries((server.value?.panels ?? []).map((p) => [p.id, p.outputs]));
        expect(out).toEqual({ 'p-a': [urls[0]], 'p-b': [urls[1]], 'p-c': [urls[2]] });
      },
      { timeout: 8000 },
    );
    // Settle any write still in flight, then the store must still hold all three.
    await sleep(600);
    expect(server.value?.panels.map((p) => p.outputs)).toEqual(urls.map((u) => [u]));
    expect(server.value?.panels.map((p) => p.repair?.attempts)).toEqual([1, 1, 1]);
  }, 15000);
});
