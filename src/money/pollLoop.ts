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

import { isSettledSnapshot, isTerminalStatus } from './generation.js';

export interface PollLoopCallbacks {
  /**
   * Every snapshot the loop receives (terminal or not). `final` is true on the
   * LAST one — the loop stops after this call. Callers act on `final`, never on
   * the status alone: a `succeeded` snapshot whose image is still being rated
   * (`ratingPending`, civitai#8994) is NOT final — the loop keeps polling until
   * the rating lands, or until `ratingPendingMaxMs` passes, in which case the
   * still-pending snapshot is delivered with `final: true`.
   */
  onSnapshot: (snap: BlockWorkflowSnapshot, final: boolean) => void;
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
  /**
   * How long to keep polling a terminal snapshot that is still rating-pending,
   * from the first such snapshot. Matches the SDK `watch` window (2 minutes).
   */
  ratingPendingMaxMs?: number;
  /** Clock, injectable for tests. */
  now?: () => number;
}

/** Drive one workflow to a final snapshot. Returns a cancel function. */
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
  const RATING_PENDING_MAX_MS = opts.ratingPendingMaxMs ?? 120_000;
  const now = opts.now ?? Date.now;

  const tok = { cancelled: false };
  let attempt = 0;
  let consecutiveErrors = 0;
  // When a terminal-but-rating-pending snapshot was first seen (bounds the wait).
  let pendingSince: number | null = null;

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
    let final = isSettledSnapshot(snap);
    if (!final && isTerminalStatus(snap.status)) {
      // Succeeded, rating pending: poll on, but not forever.
      const t = now();
      if (pendingSince === null) pendingSince = t;
      else if (t - pendingSince >= RATING_PENDING_MAX_MS) final = true;
    }
    cb.onSnapshot(snap, final);
    if (final) return;
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
