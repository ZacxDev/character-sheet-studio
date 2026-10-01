/**
 * The adaptive-backoff poll loop for the page money path, extracted from the
 * App so the transient-error machinery stays unit-tested while the free loop
 * ships without generation wiring. The money-wiring step will drive this with
 * the real `useBuzzWorkflow().poll` + the App's snapshot handling.
 *
 * Robustness contract (unchanged from the scaffold): a `poll()` THROW is a
 * transport/infra blip (a network hiccup, a not-yet-rolled-out backend pod
 * 401ing for a few seconds, …) — NOT a workflow failure. A workflow the
 * orchestrator actually failed comes back as a 'failed'/'expired'/'canceled'
 * SNAPSHOT, never a throw. So a throw is retried with bounded backoff instead
 * of failing the generation (which would mark a server-side SUCCESS as FAILED).
 * Only after MAX_TRANSIENT_ERRORS consecutive failures (the backend is genuinely
 * unreachable, not just blipping) does the loop give up via `onUnreachable`.
 * The error counter resets on any successful poll, so a long generation that
 * hits the occasional blip never accumulates toward the cap.
 *
 * No React, no DOM — unit-tested in node (see pollLoop.test.ts).
 */

import type { BlockWorkflowSnapshot } from '@civitai/app-sdk/blocks';

import { isTerminalStatus } from './generation.js';

export interface PollLoopCallbacks {
  /**
   * Every snapshot the loop receives (terminal or not). The caller maps
   * terminal statuses to its own phases via `phaseForSnapshot` etc. A terminal
   * snapshot STOPS the loop after this call.
   */
  onSnapshot: (snap: BlockWorkflowSnapshot) => void;
  /** The backend stayed unreachable past MAX_TRANSIENT_ERRORS consecutive throws. */
  onUnreachable: () => void;
}

export interface PollLoopOptions {
  /** Backoff between normal (snapshot-returning) polls. */
  scheduleMs?: readonly number[];
  /** Backoff between retries of a transient transport throw. */
  retryMs?: readonly number[];
  /** Give up after this many CONSECUTIVE transport throws. */
  maxTransientErrors?: number;
}

/** Drive one workflow to terminal. Returns a cancel function. */
export function startPollLoop(
  poll: (workflowId: string) => Promise<BlockWorkflowSnapshot>,
  workflowId: string,
  cb: PollLoopCallbacks,
  opts: PollLoopOptions = {},
): () => void {
  // Backoff between normal (snapshot-returning) polls.
  const SCHEDULE_MS = opts.scheduleMs ?? [2000, 2000, 3000, 5000, 8000];
  // Shorter backoff between retries of a transient transport error, so a brief
  // blip recovers fast.
  const RETRY_MS = opts.retryMs ?? [500, 1000, 2000, 4000];
  // Give up only after this many CONSECUTIVE transport failures (~30s of
  // retries at the default schedule) — a genuinely-down backend, not a blip.
  const MAX_TRANSIENT_ERRORS = opts.maxTransientErrors ?? 8;

  const tok = { cancelled: false };
  let attempt = 0;
  let consecutiveErrors = 0;

  const tick = async () => {
    if (tok.cancelled) return;
    let snap: BlockWorkflowSnapshot;
    try {
      snap = await poll(workflowId);
    } catch {
      // Transient hiccup — retry with bounded backoff. A real terminal failure
      // surfaces as a 'failed'/'expired' snapshot, not a throw.
      if (tok.cancelled) return;
      consecutiveErrors += 1;
      if (consecutiveErrors > MAX_TRANSIENT_ERRORS) {
        // Backend unreachable after repeated retries — report a transport
        // error (distinct from a workflow failure) and stop.
        cb.onUnreachable();
        return;
      }
      const delay = RETRY_MS[Math.min(consecutiveErrors - 1, RETRY_MS.length - 1)];
      setTimeout(tick, delay);
      return;
    }
    if (tok.cancelled) return;
    // A successful poll clears the transient-error streak.
    consecutiveErrors = 0;
    cb.onSnapshot(snap);
    if (isTerminalStatus(snap.status)) return;
    const delay = SCHEDULE_MS[Math.min(attempt, SCHEDULE_MS.length - 1)];
    attempt += 1;
    setTimeout(tick, delay);
  };

  const first = setTimeout(tick, 0);
  return () => {
    tok.cancelled = true;
    clearTimeout(first);
  };
}
