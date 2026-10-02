// Node unit tests for pollLoop.ts — the transient-error robustness regression
// (extracted from the old App's poll loop): a poll THROW must be RETRIED, never
// turned into a terminal failure; only sustained unreachability gives up.

import { describe, expect, it, vi } from 'vitest';

import type { BlockWorkflowSnapshot } from '@civitai/app-sdk/blocks';

import { startPollLoop } from './pollLoop.js';

const snap = (over: Partial<BlockWorkflowSnapshot>): BlockWorkflowSnapshot => ({
  workflowId: 'wf_1',
  status: 'processing',
  ...over,
});

/** Resolve once the loop reaches a terminal condition. */
function runToTerminal(
  poll: (id: string) => Promise<BlockWorkflowSnapshot>,
  opts?: { scheduleMs?: number[]; retryMs?: number[]; maxTransientErrors?: number },
): Promise<{ snapshots: BlockWorkflowSnapshot[]; unreachable: boolean; cancel: () => void }> {
  return new Promise((resolve) => {
    const snapshots: BlockWorkflowSnapshot[] = [];
    const cancel = startPollLoop(
      poll,
      'wf_1',
      {
        onSnapshot: (s) => {
          snapshots.push(s);
          if (s.status === 'succeeded' || s.status === 'failed' || s.status === 'expired' || s.status === 'canceled') {
            resolve({ snapshots, unreachable: false, cancel });
          }
        },
        onUnreachable: () => resolve({ snapshots, unreachable: true, cancel }),
      },
      { scheduleMs: [5], retryMs: [5], maxTransientErrors: 4, ...opts },
    );
  });
}

describe('startPollLoop', () => {
  it('a transient THROW mid-loop -> retries and completes on the next success (NOT failed)', async () => {
    const poll = vi
      .fn<(id: string) => Promise<BlockWorkflowSnapshot>>()
      .mockRejectedValueOnce(new Error('Failed to fetch'))
      .mockResolvedValueOnce(snap({ status: 'succeeded' }));

    const { snapshots, unreachable } = await runToTerminal(poll);

    expect(unreachable).toBe(false);
    expect(poll).toHaveBeenCalledTimes(2);
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0].status).toBe('succeeded');
  });

  it('a GENUINE failed STATUS (a snapshot, not a throw) -> stops immediately, no retry', async () => {
    const poll = vi
      .fn<(id: string) => Promise<BlockWorkflowSnapshot>>()
      .mockResolvedValueOnce(snap({ status: 'failed', error: 'NSFW prompt rejected by audit' }));

    const { snapshots, unreachable } = await runToTerminal(poll);

    expect(unreachable).toBe(false);
    expect(poll).toHaveBeenCalledTimes(1);
    expect(snapshots[0].error).toBe('NSFW prompt rejected by audit');
  });

  it('non-terminal snapshots keep polling until a terminal one lands', async () => {
    const poll = vi
      .fn<(id: string) => Promise<BlockWorkflowSnapshot>>()
      .mockResolvedValueOnce(snap({ status: 'pending' }))
      .mockResolvedValueOnce(snap({ status: 'processing' }))
      .mockResolvedValueOnce(snap({ status: 'succeeded' }));

    const { snapshots, unreachable } = await runToTerminal(poll);

    expect(unreachable).toBe(false);
    expect(poll).toHaveBeenCalledTimes(3);
    expect(snapshots.map((s) => s.status)).toEqual(['pending', 'processing', 'succeeded']);
  });

  it('consecutive throws past the cap -> onUnreachable (a genuinely-down backend)', async () => {
    const poll = vi
      .fn<(id: string) => Promise<BlockWorkflowSnapshot>>()
      .mockRejectedValue(new Error('socket hangup'));

    const { snapshots, unreachable } = await runToTerminal(poll, { maxTransientErrors: 4 });

    expect(unreachable).toBe(true);
    expect(snapshots).toHaveLength(0);
    // maxTransientErrors (4) + the one that trips the cap = 5 attempts.
    expect(poll).toHaveBeenCalledTimes(5);
  });

  it('the error streak resets on a successful poll (a blip mid-gen never accumulates)', async () => {
    const poll = vi
      .fn<(id: string) => Promise<BlockWorkflowSnapshot>>()
      .mockRejectedValueOnce(new Error('blip 1'))
      .mockRejectedValueOnce(new Error('blip 2'))
      .mockRejectedValueOnce(new Error('blip 3'))
      .mockResolvedValueOnce(snap({ status: 'processing' }))
      .mockRejectedValueOnce(new Error('blip 4'))
      .mockRejectedValueOnce(new Error('blip 5'))
      .mockResolvedValueOnce(snap({ status: 'succeeded' }));

    const { snapshots, unreachable } = await runToTerminal(poll, { maxTransientErrors: 4 });

    expect(unreachable).toBe(false);
    expect(snapshots.at(-1)?.status).toBe('succeeded');
    expect(poll).toHaveBeenCalledTimes(7);
  });

  it('cancel() stops the loop before the terminal snapshot', async () => {
    const poll = vi
      .fn<(id: string) => Promise<BlockWorkflowSnapshot>>()
      .mockResolvedValue(snap({ status: 'processing' }));
    let seen = 0;
    const cancel = startPollLoop(
      poll,
      'wf_1',
      {
        onSnapshot: () => {
          seen += 1;
          if (seen === 2) cancel();
        },
        onUnreachable: () => {},
      },
      { scheduleMs: [5], retryMs: [5] },
    );
    await new Promise((r) => setTimeout(r, 60));
    const calls = poll.mock.calls.length;
    await new Promise((r) => setTimeout(r, 60));
    expect(poll.mock.calls.length).toBe(calls); // no further polls after cancel
    expect(seen).toBe(2);
  });
});
