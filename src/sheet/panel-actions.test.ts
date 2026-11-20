import { describe, expect, it } from 'vitest';

import type { BlockWorkflowSnapshot } from '@civitai/app-sdk/blocks';

import {
  etaText,
  isUnlockableLock,
  outputPosition,
  panelEta,
  unlockAction,
  unlockLabel,
} from './panel-actions.js';

const snap = (over: Record<string, unknown>): BlockWorkflowSnapshot =>
  ({ workflowId: 'wf-9', status: 'succeeded', ...over }) as BlockWorkflowSnapshot;

describe('outputPosition', () => {
  const mixed = snap({
    imageUrls: ['https://x.test/c.png'],
    outputs: [{ pending: true }, { blocked: true }, { restricted: true, reason: 'pool' }, { url: 'https://x.test/c.png' }],
  });

  it('names the position in outputs, not an imageUrls index', () => {
    expect(outputPosition(mixed, 'restricted')).toBe(2);
    expect(outputPosition(mixed, 'available')).toBe(3);
  });

  it('is null when nothing matches', () => {
    expect(outputPosition(snap({ outputs: [{ url: 'https://x.test/a.png' }] }), 'restricted')).toBeNull();
    expect(outputPosition(snap({ outputs: [{ restricted: true, reason: 'ceiling' }] }), 'available')).toBeNull();
  });

  it('an older host with no outputs: no restricted entry, imageUrls[0] is position 0', () => {
    const old = snap({ imageUrls: ['https://x.test/a.png'] });
    expect(outputPosition(old, 'restricted')).toBeNull();
    expect(outputPosition(old, 'available')).toBe(0);
    expect(outputPosition(snap({ imageUrls: [] }), 'available')).toBeNull();
  });
});

describe('unlock labels', () => {
  it('only pool is a paid unlock; blocked and a pending rating offer none', () => {
    expect(unlockLabel('pool')).toBe('Unlock with Yellow Buzz');
    expect(unlockLabel('ceiling')).toBe('Where can I see it?');
    expect(isUnlockableLock('pool')).toBe(true);
    expect(isUnlockableLock('ceiling')).toBe(true);
    expect(isUnlockableLock('unrated')).toBe(true);
    expect(isUnlockableLock('restricted')).toBe(true);
    expect(isUnlockableLock('blocked')).toBe(false);
    expect(isUnlockableLock('rating-pending')).toBe(false);
    expect(isUnlockableLock(undefined)).toBe(false);
  });
});

describe('unlockAction', () => {
  it('unlocked applies the returned snapshot', () => {
    const s = snap({ outputs: [{ url: 'https://x.test/u.png' }] });
    expect(unlockAction({ outcome: 'unlocked', snapshot: s })).toEqual({ kind: 'apply', snapshot: s });
  });
  it('unlocked without a snapshot, and not-restricted, re-poll', () => {
    expect(unlockAction({ outcome: 'unlocked' })).toEqual({ kind: 'repoll' });
    expect(unlockAction({ outcome: 'not-restricted' })).toEqual({ kind: 'repoll' });
  });
  it('dismissed says nothing', () => {
    expect(unlockAction({ outcome: 'dismissed' })).toEqual({ kind: 'none' });
  });
  it('refused / not-released / unavailable show the host message', () => {
    expect(unlockAction({ outcome: 'refused', message: 'Need 25 more Yellow' })).toEqual({
      kind: 'notice',
      text: 'Need 25 more Yellow',
    });
    expect(unlockAction({ outcome: 'not-released', message: 'Still above your level' })).toEqual({
      kind: 'notice',
      text: 'Still above your level',
    });
    expect(unlockAction({ outcome: 'unavailable', message: 'Change your settings' })).toEqual({
      kind: 'notice',
      text: 'Change your settings',
    });
  });
  it('an unknown outcome is treated like unavailable', () => {
    expect(unlockAction({ outcome: 'something-new' })).toEqual({
      kind: 'notice',
      text: 'This image can’t be unlocked here.',
    });
  });
});

// A fixed locale and zone: the readout follows the viewer's, which CI's is not.
const UTC_24H = { locale: 'en-GB', timeZone: 'UTC' };

describe('panelEta', () => {
  it('reads snapshot.eta while queued', () => {
    const eta = panelEta(
      snap({
        status: 'pending',
        eta: {
          stepName: '$0',
          queuedAhead: 4,
          startsAt: '2026-11-19T14:05:00.000Z',
          completesAt: '2026-11-19T14:06:30.000Z',
          progress: null,
          support: 'available',
        },
      }),
    );
    expect(eta).toEqual({
      progress: null,
      ahead: 4,
      startsAt: '2026-11-19T14:05:00.000Z',
      completesAt: '2026-11-19T14:06:30.000Z',
      noCapacity: false,
    });
    expect(etaText(eta!, UTC_24H)).toBe('4 ahead in queue · starts ~14:05 · done ~14:06');
  });

  it('falls back to a step queue (precedingJobs / estimatedStartAt / estimatedCompleteAt)', () => {
    const eta = panelEta(
      snap({
        status: 'pending',
        steps: [
          { name: 'a', $type: 'textToImage', status: 'succeeded' },
          {
            name: 'b',
            $type: 'textToImage',
            status: 'pending',
            queue: {
              precedingJobs: 0,
              estimatedStartAt: '2026-11-19T09:41:00.000Z',
              estimatedCompleteAt: null,
              support: 'unavailable',
            },
          },
        ],
      }),
    );
    expect(eta).toEqual({
      progress: null,
      ahead: 0,
      startsAt: '2026-11-19T09:41:00.000Z',
      completesAt: null,
      noCapacity: true,
    });
    expect(etaText(eta!, UTC_24H)).toBe('Waiting for a free worker · Next in queue · starts ~09:41');
  });

  it('falls back to a running step progress, clamped to 0..1', () => {
    const eta = panelEta(
      snap({ status: 'processing', steps: [{ name: 'a', $type: 'imageGen', status: 'processing', progress: 1.7 }] }),
    );
    expect(eta?.progress).toBe(1);
    expect(etaText(eta!)).toBe('100% done');
    const half = panelEta(snap({ status: 'processing', eta: { stepName: 'x', queuedAhead: null, startsAt: null, completesAt: null, progress: 0.555, support: null } }));
    expect(etaText(half!)).toBe('56% done');
  });

  it('is null when the host reports nothing', () => {
    expect(panelEta(snap({ status: 'processing' }))).toBeNull();
    expect(panelEta(snap({ status: 'processing', eta: null }))).toBeNull();
  });

  it('a queue with no numbers still reads as queued', () => {
    expect(
      etaText({ progress: null, ahead: null, startsAt: null, completesAt: null, noCapacity: false }),
    ).toBe('Queued');
  });
});
