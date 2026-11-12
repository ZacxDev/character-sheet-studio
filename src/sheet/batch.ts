// Pure batch-runner helpers for the sheet money path: idempotency keys, seed
// resolution, and panel scheduling. No React, no DOM — unit-tested in node
// (see batch.test.ts). The SheetBuilder screen drives these; every money
// decision (estimate → consent → submit → poll) lives in the screen, every
// deterministic rule lives here.

import type { SeedPolicy, SheetPanel, SheetStatus } from './types.js';
import { isTerminalPanelStatus } from './types.js';
import type { PricedFailureKind } from '../money/generation.js';

/**
 * The host's constraint on the pattern (invalid_format → 400 on
 * `blocks.submitWorkflow`), expressed here so a unit test pins it: the mock
 * host does NOT enforce it, which is how a colon-separated key shipped.
 */
export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * FNV-1a 128-bit over the UTF-16 code units, hex-encoded. Deterministic, no
 * dependencies — enough to compress two UUIDs + a nonce into a fixed-length,
 * host-compliant idempotency key. (The host only ever sees the key; the ids
 * themselves stay in storage where we can recompute from.)
 */
function fnv1a128Hex(input: string): string {
  const OFFSET = 0x6c62272e07bb014262b821756295c58dn;
  const PRIME = 0x0000000001000000000000000000013bn;
  const MASK = (1n << 128n) - 1n;
  let hash = OFFSET;
  for (let i = 0; i < input.length; i++) {
    hash ^= BigInt(input.charCodeAt(i));
    hash = (hash * PRIME) & MASK;
  }
  return hash.toString(16).padStart(32, '0');
}

/**
 * The STABLE idempotency key for one panel's submit: `k-<128-bit hash of
 * sheetId + panelId + nonce>`.
 *
 * Retrying a submit whose response was lost MUST reuse this exact key (same
 * nonce) so the host + orchestrator collapse it to ONE Buzz charge instead of
 * double-charging (see `SubmitWorkflowOptions.idempotencyKey`). It is derived
 * from ids the sheet already persists, so it survives tab closes and
 * re-renders unchanged. A regenerate bumps the nonce → a new logical submit.
 *
 * Why a hash: sheet/panel ids are UUIDs (36 chars each), so joining them
 * literally yields a 75-char key — over the host's {@link IDEMPOTENCY_KEY_PATTERN}
 * 64-char cap (and raw colons are outside the charset entirely). The key is a
 * fixed 34 chars for any ids, deterministic across calls.
 */
export function idempotencyKeyFor(sheetId: string, panelId: string, nonce = 0): string {
  return `k-${fnv1a128Hex(`${sheetId}:${panelId}:${nonce}`)}`;
}

/**
 * Resolve a panel's workflow seed.
 * - `'locked'` — deterministic: base seed + panel index (mod 2^31-1, the
 *   orchestrator's int32 range). Re-running the sheet reproduces the panels.
 * - `'varied'` — a random 31-bit int per panel, for exploration sheets.
 */
export function resolvePanelSeed(
  baseSeed: number,
  index: number,
  policy: SeedPolicy,
): number {
  if (policy === 'varied') {
    return Math.floor(Math.random() * 0x7fffffff);
  }
  return (Math.floor(baseSeed) + index) % 0x7fffffff;
}

/**
 * The next panel still waiting for its submit: status `queued` with no
 * workflowId yet. Panels already submitted (workflowId set) are the poll
 * loop's business, not the submitter's — this is what makes resume safe to
 * re-run: it never re-submits a panel that already has a workflow.
 */
export function nextPanelToSubmit(panels: readonly SheetPanel[]): SheetPanel | null {
  return panels.find((p) => p.status === 'queued' && !p.workflowId) ?? null;
}

/**
 * Panels that carry a workflowId but never reached a terminal status —
 * re-attachable on resume via the workflow query route (`useBuzzWorkflow().poll`
 * under `startPollLoop`), without submitting anything new.
 */
export function resumablePanels(panels: readonly SheetPanel[]): SheetPanel[] {
  return panels.filter(
    (p) => p.workflowId && !isTerminalPanelStatus(p.status),
  );
}

/** Derive the sheet-level status from its panels. Pure — unit-tested. */
export function deriveSheetStatus(panels: readonly SheetPanel[]): SheetStatus {
  if (panels.length === 0) return 'draft';
  if (panels.every((p) => p.status === 'done')) return 'complete';
  if (
    panels.some((p) => p.status === 'running' || (p.status === 'queued' && !!p.workflowId))
  ) {
    return 'running';
  }
  if (panels.some((p) => p.status === 'queued')) return 'paused';
  return 'failed';
}

// ---------------------------------------------------------------------------
// Panel error codes — the CLOSED set persisted on SheetPanel.errorCode.
// App-owned copy only; the raw server prose is never stored or rendered.
// ---------------------------------------------------------------------------

export type PanelErrorCode =
  /** Estimate rejected (no price quote) — safe to re-price. */
  | 'estimate-failed'
  /** Priced refusal: the viewer's wallet is the problem — top-up CTA is valid. */
  | 'unaffordable'
  /** Priced refusal: a platform/app limit — buying Buzz will NOT fix it. */
  | 'unavailable'
  /** Priced terminal workflow failure that isn't wallet or platform. */
  | 'generation-failed'
  /** Submit threw 'exception' (nothing confirmed queued) — retry reuses the key. */
  | 'submit-interrupted'
  /** Submit threw 'workflow-failed' with no pollable id, or an unknown shape. */
  | 'submit-failed'
  /** The poll transport gave up; the workflow may still be running server-side. */
  | 'poll-unreachable';

/** Map a priced-failure classification onto the persisted panel error code. */
export function pricedKindToErrorCode(kind: PricedFailureKind): PanelErrorCode {
  switch (kind) {
    case 'affordability':
      return 'unaffordable';
    case 'nonWallet':
      return 'unavailable';
    case 'generic':
      return 'generation-failed';
  }
}

export interface PanelErrorCopy {
  title: string;
  body: string;
  /** Whether offering the Buzz top-up modal is honest for this failure. */
  showTopUp: boolean;
}

/** App-owned viewer copy for a panel error code. Unknown codes get generic copy. */
export function panelErrorCopy(code: string | undefined): PanelErrorCopy {
  switch (code) {
    case 'estimate-failed':
      return {
        title: 'Couldn’t price this panel',
        body: 'The price quote failed. Re-price the sheet to try again — nothing was submitted.',
        showTopUp: false,
      };
    case 'unaffordable':
      return {
        title: 'Not enough Buzz',
        body: 'This panel costs more than your available Buzz. Top up to run it.',
        showTopUp: true,
      };
    case 'unavailable':
      return {
        title: 'Panel unavailable right now',
        body: 'A platform or app limit is blocking this panel — not your balance. Buying Buzz won’t fix it; try again later.',
        showTopUp: false,
      };
    case 'generation-failed':
      return {
        title: 'Panel failed',
        body: 'The generation didn’t complete. You can regenerate this panel.',
        showTopUp: false,
      };
    case 'submit-interrupted':
      return {
        title: 'Submit was interrupted',
        body: 'The request didn’t reach the queue cleanly. Retrying reuses the same request, so you won’t be charged twice.',
        showTopUp: false,
      };
    case 'submit-failed':
      return {
        title: 'Panel didn’t start',
        body: 'The generation may have started but didn’t complete, so we won’t retry it automatically — your Buzz may already be committed.',
        showTopUp: false,
      };
    case 'poll-unreachable':
      return {
        title: 'Lost track of this panel',
        body: 'The connection dropped while checking progress. The generation may still be running — reopen the sheet to check.',
        showTopUp: false,
      };
    default:
      return {
        title: 'Panel failed',
        body: 'The generation didn’t complete. You can regenerate this panel.',
        showTopUp: false,
      };
  }
}
