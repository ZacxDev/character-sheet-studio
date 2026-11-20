// Pure helpers behind three per-panel actions in Sheet View:
//   - Unlock a restricted panel in place (`useOutputUnlock`, HQ app_blocks_sdk_e982);
//   - Use a finished panel as the character's reference portrait
//     (`usePersistGenerationSource`, HQ app_blocks_sdk_x7dw);
//   - the queue / progress line on a generating panel (`snapshot.eta`, HQ
//     app_blocks_sdk_1gm9).
// No React, no DOM: unit-tested in node (panel-actions.test.ts).

import type {
  BlockOutputUnlockResult,
  BlockWorkflowEta,
  BlockWorkflowSnapshot,
} from '@civitai/app-sdk/blocks';

import type { PanelLock } from './types.js';

/**
 * The POSITION in `snapshot.outputs` of the first output matching `kind`, or
 * null. Positions are what `unlockOutput` and `persist({ imageIndex })` take:
 * `outputs` keeps restricted, pending and blocked entries in place, so this is
 * never an index into `imageUrls`.
 *
 * - `'restricted'`: an entry `{ restricted: true }` (any reason).
 * - `'available'`: an entry with a url and none of the withheld markers.
 *
 * An older host that sends no `outputs` returns null for `'restricted'` (it
 * has no restricted entries to name) and 0 for `'available'` when `imageUrls`
 * has a url, since then the two lists are the same.
 */
export function outputPosition(
  snapshot: BlockWorkflowSnapshot,
  kind: 'restricted' | 'available',
): number | null {
  const outputs = snapshot.outputs;
  if (!Array.isArray(outputs)) {
    if (kind === 'available' && (snapshot.imageUrls?.length ?? 0) > 0) return 0;
    return null;
  }
  const at = outputs.findIndex((o) => {
    if (!o || typeof o !== 'object') return false;
    if (kind === 'restricted') return o.restricted === true;
    return (
      o.restricted !== true &&
      o.pending !== true &&
      o.blocked !== true &&
      typeof o.url === 'string' &&
      o.url !== ''
    );
  });
  return at === -1 ? null : at;
}

/** Locks the host's unlock dialog can act on. `blocked` and a pending rating cannot. */
export function isUnlockableLock(lock: PanelLock | undefined): boolean {
  return lock === 'pool' || lock === 'ceiling' || lock === 'unrated' || lock === 'restricted';
}

/** The button label for an unlockable lock. Only `pool` can be paid for. */
export function unlockLabel(lock: PanelLock): string {
  return lock === 'pool' ? 'Unlock with Yellow Buzz' : 'Where can I see it?';
}

/**
 * What Sheet View does with an unlock result:
 * - `apply`: the snapshot now carries the panel's url; patch the panel from it;
 * - `repoll`: the output already had a url (`not-restricted`); poll and patch;
 * - `notice`: say `text`, change nothing;
 * - `none`: the viewer closed the dialog; say nothing.
 *
 * An unknown outcome is treated like `unavailable`, as the SDK documents.
 */
export type UnlockAction =
  | { kind: 'apply'; snapshot: BlockWorkflowSnapshot }
  | { kind: 'repoll' }
  | { kind: 'notice'; text: string }
  | { kind: 'none' };

export function unlockAction(result: BlockOutputUnlockResult): UnlockAction {
  switch (result.outcome) {
    case 'unlocked':
      return result.snapshot
        ? { kind: 'apply', snapshot: result.snapshot }
        : { kind: 'repoll' };
    case 'not-restricted':
      return { kind: 'repoll' };
    case 'dismissed':
      return { kind: 'none' };
    case 'linked-out':
      return {
        kind: 'notice',
        text: 'Opened on civitai.red, where this image can be shown. Nothing was charged.',
      };
    case 'refused':
      return { kind: 'notice', text: result.message ?? 'Not enough Yellow Buzz to unlock it. Nothing was charged.' };
    case 'not-released':
      return { kind: 'notice', text: result.message ?? 'It is still above your content settings.' };
    default:
      return { kind: 'notice', text: result.message ?? 'This image can’t be unlocked here.' };
  }
}

/**
 * The queue / progress readout for a generating panel, or null when the host
 * reports nothing (a terminal workflow, an older host, a throttled poll).
 *
 * Reads `snapshot.eta` (every kind has it, including this app's `textToImage`).
 * When it is absent, falls back to the first queued step's own
 * `queue.{precedingJobs, estimatedStartAt, estimatedCompleteAt}` and the first
 * running step's `progress` (present on `kind: 'workflow'` snapshots).
 */
export interface PanelEta {
  /** Fraction 0..1 while running, else null. */
  progress: number | null;
  /** Jobs ahead in the queue, while queued. */
  ahead: number | null;
  /** ISO times, estimates. */
  startsAt: string | null;
  completesAt: string | null;
  /** The orchestrator has no worker for this step right now. */
  noCapacity: boolean;
}

export function panelEta(snapshot: BlockWorkflowSnapshot): PanelEta | null {
  const eta: BlockWorkflowEta | null | undefined = snapshot.eta;
  if (eta) {
    return {
      progress: typeof eta.progress === 'number' ? clamp01(eta.progress) : null,
      ahead: eta.queuedAhead,
      startsAt: eta.startsAt,
      completesAt: eta.completesAt,
      noCapacity: eta.support === 'unavailable',
    };
  }
  for (const step of snapshot.steps ?? []) {
    if (step.queue) {
      return {
        progress: null,
        ahead: step.queue.precedingJobs,
        startsAt: step.queue.estimatedStartAt,
        completesAt: step.queue.estimatedCompleteAt,
        noCapacity: step.queue.support === 'unavailable',
      };
    }
    if (step.status === 'processing' && typeof step.progress === 'number') {
      return { progress: clamp01(step.progress), ahead: null, startsAt: null, completesAt: null, noCapacity: false };
    }
  }
  return null;
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

/** Formatting seam for tests: the viewer's locale and zone by default. */
export interface ClockFormat {
  locale?: string;
  timeZone?: string;
}

/** The time in the viewer's locale (hours and minutes), or null for a missing / unparseable time. */
function clock(iso: string | null, fmt: ClockFormat = {}): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return new Date(t).toLocaleTimeString(fmt.locale ? [fmt.locale] : [], {
    hour: '2-digit',
    minute: '2-digit',
    ...(fmt.timeZone ? { timeZone: fmt.timeZone } : {}),
  });
}

/** One line of text for a {@link PanelEta}: progress, or queue position and times. */
export function etaText(eta: PanelEta, fmt: ClockFormat = {}): string {
  if (eta.progress !== null) return `${Math.round(eta.progress * 100)}% done`;
  const parts: string[] = [];
  if (eta.noCapacity) parts.push('Waiting for a free worker');
  if (eta.ahead !== null) parts.push(eta.ahead === 0 ? 'Next in queue' : `${eta.ahead} ahead in queue`);
  const starts = clock(eta.startsAt, fmt);
  const done = clock(eta.completesAt, fmt);
  if (starts) parts.push(`starts ~${starts}`);
  if (done) parts.push(`done ~${done}`);
  return parts.length > 0 ? parts.join(' · ') : 'Queued';
}
