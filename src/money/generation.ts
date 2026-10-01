// Pure logic for the Character Sheet Studio page money app. No React, no DOM — unit-tested
// in node (see generation.test.ts). The App glue imports these so the
// load-bearing decisions (cost format, insufficient-Buzz sniff, terminal-status
// reduction, scope check) live in one tested place.

import type {
  BlockSourceImage,
  BlockWorkflowSnapshot,
  BuzzAccountType,
} from '@civitai/app-sdk/blocks';

import type { CheckpointOption, LoraOption } from '../models.js';
import { clampLoraWeight, roundLoraWeight } from '../models.js';

/** Server cap mirror — prompts over this are rejected by the workflow schema. */
export const PROMPT_MAX = 1500;

// ---------------------------------------------------------------------------
// Per-account Buzz — which pool funds a generation.
//
// A block can prefer + read exactly three pools (the SDK's `BuzzAccountType`):
//   blue   = free / earned Buzz
//   yellow = purchased Buzz
//   green  = creator-earned / tips
// The platform-internal pools (red/purple) are never exposed to a block.
// ---------------------------------------------------------------------------

/** The Buzz pools a block can prefer + read ({ blue, green, yellow }). */
export const BUZZ_ACCOUNT_TYPES: readonly BuzzAccountType[] = ['blue', 'green', 'yellow'];

/**
 * What the account picker offers: `'auto'` (the default — let the host choose the
 * funding order, today's behavior) plus one entry per readable pool.
 */
export type AccountChoice = 'auto' | BuzzAccountType;

/** Picker order: Auto first, then the pools. */
export const ACCOUNT_CHOICES: readonly AccountChoice[] = ['auto', 'blue', 'green', 'yellow'];

/** Human label for an account choice (Auto / Blue / Green / Yellow). */
export function accountLabel(choice: AccountChoice): string {
  switch (choice) {
    case 'auto':
      return 'Auto';
    case 'blue':
      return 'Blue';
    case 'green':
      return 'Green';
    case 'yellow':
      return 'Yellow';
  }
}

/**
 * Label the pool that PRIMARILY funded a generation
 * (`BlockWorkflowSnapshot.spentAccountType`). This is the largest-debit account,
 * NOT necessarily "the paid account": a gen covered mostly by free/earned Buzz
 * reports `blue`. `undefined` (a host predating the field, or no spend) -> null,
 * so the caller can skip the "funded from…" note.
 */
export function spentAccountLabel(spent: BuzzAccountType | undefined): string | null {
  if (!spent) return null;
  return accountLabel(spent);
}

/**
 * Mirror of the manifest's `page.buzzBudgetPerGen`. MUST be kept in sync with
 * block.manifest.json — the SERVER reads the MANIFEST value at mint (and clamps
 * it to the platform per-gen cap); this constant is exported for your own copy
 * and is not read by the scaffold's UI. The real ceiling is enforced
 * server-side, so changing this constant alone changes nothing about spend.
 */
export const PAGE_BUZZ_BUDGET = 300;

/** The scope the page token must carry before a generation can be submitted. */
export const BUDGETED_SCOPE = 'ai:write:budgeted';

/** Snapshot statuses that mean "stop polling". Mirrors the SDK's TERMINAL set. */
const TERMINAL: ReadonlySet<BlockWorkflowSnapshot['status']> = new Set([
  'succeeded',
  'failed',
  'expired',
  'canceled',
]);

export function isTerminalStatus(status: BlockWorkflowSnapshot['status']): boolean {
  return TERMINAL.has(status);
}

/**
 * Does the token carry the budgeted-spend scope? Drives whether a Generate
 * click submits directly or first asks the host to open the consent UI.
 * `ai:write:budgeted` is consent-gated, so a fresh viewer's mint WITHHOLDS it
 * until they grant it; after grant the host pushes TOKEN_REFRESH with the scope
 * and this flips true -> retry.
 */
export function hasBudgetedScope(scopes: readonly string[] | undefined): boolean {
  return Array.isArray(scopes) && scopes.includes(BUDGETED_SCOPE);
}

/**
 * Sniff a workflow failure / error string for insufficient-Buzz language so the
 * UI can swap to a Top-Up CTA. There is NO structured error.code on the
 * BlockWorkflowSnapshot today (only a free-text `error`), so this is a substring
 * heuristic.
 *
 * NOTE: call {@link isDisallowedAccountError} FIRST — the disallowed-account
 * message also contains the word "buzz", which this heuristic would otherwise
 * misclassify as insufficient.
 */
export function isInsufficientBuzz(message: string | null | undefined): boolean {
  if (!message) return false;
  const m = message.toLowerCase();
  return (
    m.includes('insufficient') ||
    m.includes('not enough') ||
    m.includes('budget') ||
    m.includes('balance') ||
    m.includes('buzz')
  );
}

/**
 * Sniff for the server's domain-clamp rejection of a preferred `accountType`.
 * When a page picks a Buzz pool that isn't spendable on this app's content-rating
 * domain, `blocks.submitWorkflow` rejects with a tRPC BAD_REQUEST whose message
 * is (civitai/civitai `blocks.router`):
 *
 *   buzz account '<type>' is not spendable for this app's content rating
 *
 * Detecting it lets the UI show a friendly "switched back to Auto" note instead
 * of a raw error. MUST be checked before {@link isInsufficientBuzz} (that
 * message contains "buzz").
 */
export function isDisallowedAccountError(message: string | null | undefined): boolean {
  if (!message) return false;
  const m = message.toLowerCase();
  return m.includes('not spendable') || (m.includes('account') && m.includes('content rating'));
}

/**
 * The reason string to CLASSIFY and DISPLAY for a rejected submit.
 *
 * `@civitai/blocks-react@^0.44` throws a `WorkflowSubmitError` whose `.message`
 * is a deliberately GENERIC template — it carries no server text, so a raw
 * server string never lands on the default-printed surface of code that merely
 * awaited the promise. The server's actual reason, the one
 * {@link isDisallowedAccountError} and {@link isInsufficientBuzz} sniff for,
 * rides on `.snapshot.error` instead. Under `^0.43` the reason was on `.message`
 * and there was no snapshot.
 *
 * So read the snapshot reason FIRST and fall back to `.message`: that classifies
 * correctly on BOTH sides of the change, and it is what keeps a disallowed-pool
 * rejection rendering the friendly "switched back to Auto" note rather than a
 * hard "Generation failed".
 *
 * 🔴 STRUCTURAL ON PURPOSE — it keys on WHERE the reason lives, never on the
 * wording of the generic template. Sniffing for that wording would be a spelled
 * guard: the next upstream reword would silently restore the misclassification,
 * which is exactly the defect this replaces.
 */
export function submitErrorReason(err: unknown, fallback = 'submit failed'): string {
  const snapshotError = (err as { snapshot?: { error?: unknown } } | null | undefined)?.snapshot
    ?.error;
  if (typeof snapshotError === 'string' && snapshotError.trim() !== '') return snapshotError;
  if (err instanceof Error && err.message.trim() !== '') return err.message;
  return fallback;
}

/**
 * The Comfy on Civitai recipe id this sample sends. MIRRORED from comfy.ts's
 * `STARTER_COMFY_RECIPE` (kept as a literal here to avoid a generation.ts ⇄
 * comfy.ts import cycle) — the enum-rejection sniff below keys on it. If you
 * change the recipe id in comfy.ts, change it here too.
 */
const STARTER_COMFY_RECIPE_ID = 'starter-comfy-txt2img';

/**
 * Sniff a submit/estimate ERROR string for the SPECIFIC Comfy-on-Civitai gate signals
 * so — and ONLY so — the Comfy sample can degrade to a friendly "invite-only
 * beta" panel instead of a raw error. This is deliberately NARROW (deterministic
 * over heuristic): it matches only the three real server signals, verified
 * against civitai/civitai `src/server/routers/blocks.router.ts` +
 * `workflow.schema.ts`:
 *
 *   (a) the app-blocks flag gate — `assertAppBlocksEnabledForTokenUser` throws
 *       UNAUTHORIZED `"Apps are not enabled"`.
 *   (b) the author gate — `assertViewerIsAppDeveloper` throws FORBIDDEN
 *       `"Apps authoring is not enabled for this account"`.
 *
 *       🔴 THIS ONE IS NOT REACHABLE ON A customComfy SUBMIT OR ESTIMATE, AND
 *       THIS COMMENT USED TO IMPLY IT WAS — it listed (b) among "the three real
 *       server signals" for this path. Neither `customComfy` arm runs
 *       `assertViewerIsAppDeveloper`; that gate lives on the app-AUTHORING
 *       procs, not on the generation bridge. So do not read (b) as evidence
 *       that the platform gates Comfy by developer status — it does not, and an
 *       inline graph is reachable by any viewer of your published block that
 *       clears the refusals in comfy.ts. The match is kept because the predicate
 *       is a generic error sniff and the string is unambiguous, not because this
 *       path produces it; it is inert here.
 *   (c) the unknown-recipe rejection — a customComfy submit naming a recipe id
 *       the server's registry does not hold is rejected at the Zod enum boundary:
 *       `"Invalid enum value. Expected <the registered ids>, received '<sent id>'"`.
 *
 *       🔴 This is NOT the shipped sample's expected state. `starter-comfy-txt2img`
 *       IS registered server-side. (c) fires when you point
 *       {@link STARTER_COMFY_RECIPE_ID} at an id the server doesn't have, or run
 *       against a deployment older than the recipe. An earlier version of this
 *       comment asserted the reverse AND hardcoded the registry's contents; both
 *       went stale, and a developer believed them over the published docs. The
 *       registry is server-owned and changes without a scaffold release — read
 *       the `Expected …` list in the rejection, never a list written down here.
 *
 * It INTENTIONALLY no longer matches the broad tokens `forbidden` / `not allowed`
 * / `restricted` / bare `invite`: those over-matched dev misconfig (a generic
 * `FORBIDDEN` missing-scope / budget / page-only error), moderation rejections
 * ("prompt is not allowed"), etc. — mislabelling a real error as "invite-only
 * beta" and masking it. There is no structured `error.code` at this boundary, so
 * this stays a substring match — but only over the specific phrases above.
 *
 * NOTE: (a) is SHARED with the txt2img path, so the CALLER scopes the resulting
 * `'gated'` phase to COMFY MODE ONLY (see App.tsx) — the Comfy-specific copy is
 * never shown for a txt2img failure.
 */
export function isFeatureGated(message: string | null | undefined): boolean {
  if (!message) return false;
  const m = message.toLowerCase();
  return (
    // (a) app-blocks flag gate — exact server string.
    m.includes('apps are not enabled') ||
    // (b) author gate — exact server string.
    m.includes('apps authoring is not enabled') ||
    // (c) unknown-recipe Zod enum rejection — the enum signature AND this app's
    //     own recipe id, so a *different* enum rejection can't match.
    (m.includes('invalid enum value') && m.includes(STARTER_COMFY_RECIPE_ID))
  );
}

/** Format a Buzz cost for display, with thousands separators. `null` -> '—'. */
export function formatCost(cost: number | null | undefined): string {
  if (cost == null || !Number.isFinite(cost)) return '—';
  return Math.round(cost).toLocaleString();
}

/** Trim + clamp a prompt to the server cap so submit can't be rejected on length. */
export function clampPrompt(raw: string): string {
  return raw.slice(0, PROMPT_MAX);
}

/**
 * Build the textToImage submit/estimate body for the chosen checkpoint + the
 * selected LoRAs. Page apps keep the param surface minimal: just the prompt —
 * the host fills sensible defaults for dimensions/sampler/steps from the
 * base-model family.
 *
 * LoRAs are layered on as `additionalResources` — ONE entry per selected LoRA,
 * `{ modelVersionId, strength }` where strength is the user's weight (clamped +
 * rounded to the server's [-1, 2] bound). The key is emitted ONLY when at least
 * one LoRA is selected, so a checkpoint-only body stays backward compatible.
 *
 * A reference portrait becomes an img2img body via `sourceImages` — the CURRENT
 * field (the old singular `sourceImage` is deprecated but kept working by the
 * server; we send the plural 1-element array). The key is emitted ONLY when at
 * least one source image is given, because the server REJECTS an empty array.
 * The url must be a Civitai-hosted https image — in practice the
 * `BlockGenerationSourceImageInfo` the host's `useImageUpload({ purpose:
 * 'generationSource' })` returns, which feeds straight in.
 *
 * MONEY-SAFETY: both the checkpoint AND every LoRA + weight are the user's
 * in-block PICKS (curated default or catalog-browsed), which are DISCOVERY ONLY.
 * The server re-validates (public? covered? SFW? LoRA-only? base-model
 * compatible? entitled?) AND re-prices this body at estimate AND submit — a
 * client can't force a non-generatable / incompatible / mis-priced resource
 * through here.
 *
 * `accountType` is the OPTIONAL preferred Buzz pool. `'auto'` (or omitted) =
 * today's behavior BYTE-FOR-BYTE: the body carries NO `accountType`, so the host
 * drains its default domain-allowed order. A real pool ('blue'|'green'|'yellow')
 * is a *preference* — the server clamps it to what the viewer holds + the
 * domain-allowed set (preferred-first, then falls back), and REJECTS a pool the
 * domain forbids (see {@link isDisallowedAccountError}).
 */
export function buildWorkflowBody(
  prompt: string,
  checkpoint: CheckpointOption,
  loras: readonly LoraOption[] = [],
  accountType?: AccountChoice,
  /** Optional negative prompt — the character's negative fragment is threaded through here. */
  negativePrompt?: string,
  /** Optional img2img source(s) — the character's reference portrait upload. */
  sourceImages?: readonly BlockSourceImage[],
  /** Optional deterministic seed — the sheet sets one per panel (sheet seed + panel offset). */
  seed?: number | null,
) {
  const body: {
    kind: 'textToImage';
    modelId: number;
    modelVersionId: number;
    params: { prompt: string; negativePrompt?: string; seed?: number | null };
    additionalResources?: Array<{ modelVersionId: number; strength: number }>;
    sourceImages?: BlockSourceImage[];
    accountType?: BuzzAccountType;
  } = {
    kind: 'textToImage',
    modelId: checkpoint.modelId,
    modelVersionId: checkpoint.versionId,
    params: { prompt: clampPrompt(prompt.trim()) },
  };
  const neg = negativePrompt?.trim();
  if (neg) {
    body.params.negativePrompt = neg;
  }
  if (typeof seed === 'number' && Number.isFinite(seed)) {
    body.params.seed = Math.floor(seed);
  }
  if (loras.length > 0) {
    body.additionalResources = loras.map((l) => ({
      modelVersionId: l.versionId,
      strength: roundLoraWeight(clampLoraWeight(l.weight)),
    }));
  }
  if (sourceImages && sourceImages.length > 0) {
    body.sourceImages = [...sourceImages];
  }
  if (accountType && accountType !== 'auto') {
    body.accountType = accountType;
  }
  return body;
}

/** Pull the single displayable image url from a succeeded snapshot, if any. */
export function firstImageUrl(snapshot: BlockWorkflowSnapshot | null): string | null {
  if (!snapshot || !snapshot.imageUrls || snapshot.imageUrls.length === 0) return null;
  return snapshot.imageUrls[0] ?? null;
}

/** The single-in-flight generation phase the page tracks. */
export type GenPhase =
  | 'idle'
  | 'needs-consent'
  | 'estimating'
  | 'submitting'
  | 'polling'
  | 'succeeded'
  | 'failed'
  | 'insufficient'
  | 'account-rejected'
  | 'gated';

/** Is a generation in flight (Generate should be disabled / show progress)? */
export function isBusyPhase(phase: GenPhase): boolean {
  return phase === 'estimating' || phase === 'submitting' || phase === 'polling';
}

/**
 * Classify a submit/estimate ERROR string (the thrown-rejection path) into a
 * terminal phase. Order matters: disallowed-account BEFORE insufficient (the
 * disallowed message contains "buzz").
 *
 * This does NOT itself produce `'gated'`: the Comfy-on-Civitai gate strings are shared
 * with the txt2img path, so gating is decided at the CALL SITE (App.tsx) and
 * scoped to comfy mode — `isFeatureGated(msg) ? 'gated' : phaseForError(msg)`,
 * only when `mode === 'comfy'`. A txt2img failure therefore falls through here to
 * `failed` / `insufficient` / `account-rejected` exactly as it did before the
 * Comfy sample was added — no behaviour change, no Comfy-specific copy.
 */
export function phaseForError(message: string | null | undefined): GenPhase {
  if (isDisallowedAccountError(message)) return 'account-rejected';
  if (isInsufficientBuzz(message)) return 'insufficient';
  return 'failed';
}

/**
 * Classify a submit/estimate error into a terminal phase, with the `'gated'`
 * (Comfy on Civitai invite-only-beta) phase COMFY-MODE-SCOPED. This is the single seam
 * finding 1b turns on: the gate strings {@link isFeatureGated} matches — the
 * "Apps are not enabled" flag gate + the "Apps authoring is not enabled" author
 * gate (BOTH shared with the txt2img path, and the author one not reachable on
 * either generation path — see {@link isFeatureGated}) and the pre-deploy
 * unknown-recipe enum rejection — must only ever render the Comfy-specific copy
 * for a COMFY submit.
 *
 *   isComfy  -> gate string ? 'gated' : phaseForError(message)
 *   txt2img  -> phaseForError(message)  (failed / insufficient / account-rejected)
 *
 * So a txt2img failure is classified EXACTLY as it was before the Comfy sample
 * existed — no behaviour change, no wrong copy.
 *
 * NOTE: this pins the classification seam as far as a unit test can. Whether the
 * host actually RELAYS the raw server gate string into the block's submit
 * rejection (vs. a generic "submit failed") is HOST-DEPENDENT and not testable
 * locally — see the README's "honest state" note.
 */
export function phaseForSubmitError(
  message: string | null | undefined,
  isComfy: boolean,
): GenPhase {
  return isComfy && isFeatureGated(message) ? 'gated' : phaseForError(message);
}

/**
 * Reduce a polled snapshot to the next page phase. Keeps the status->phase
 * mapping in one tested place so the poll loop stays a thin driver.
 */
export function phaseForSnapshot(snapshot: BlockWorkflowSnapshot): GenPhase {
  switch (snapshot.status) {
    case 'succeeded':
      return 'succeeded';
    case 'failed':
    case 'expired':
    case 'canceled':
      return phaseForError(snapshot.error);
    case 'pending':
    case 'processing':
      return 'polling';
  }
}

// ---------------------------------------------------------------------------
// Money-path copy + classification for the submit/estimate REJECTION arms.
//
// The SDK's error classes carry THREE fields for THREE audiences (see
// useBuzzWorkflow.d.ts): `snapshot.error` (diagnostic, server-authored,
// UNSANITISED — log only), `message` (developer-facing constant template — log
// only), and `code` (the ONLY stable branch target). Every function below
// branches on `code` (or on duck-typed structural reads for testability) and
// returns APP-OWNED viewer copy — never the server's words.
// ---------------------------------------------------------------------------

/**
 * What a RESOLVED `status: 'failed'` snapshot (a PRICED server outcome — the
 * price it refused to charge rides on `cost.total`) means for recovery.
 *
 * There is NO structured code on this boundary (only free-text `error`), so
 * this is a substring classifier — deliberately NARROW and ordered, mirroring
 * the hooks reference's wallet-vs-not branch:
 *
 *   'affordability' — the viewer's wallet is the problem (per-call budget gate,
 *     per-user daily Buzz cap, insufficient balance). Buying Buzz FIXES this:
 *     the UI may offer the purchase modal.
 *   'nonWallet'     — the app/platform is the problem (per-app velocity limit,
 *     per-app aggregate daily cap, dev-tunnel session cap, a fail-closed
 *     "temporarily unavailable" deny, a missing price quote). Buying Buzz does
 *     NOT fix this: the UI must NOT sell Buzz here.
 *   'generic'       — anything else (including the disallowed-pool rejection,
 *     which the phase classifier routes to 'account-rejected' first).
 */
export type PricedFailureKind = 'affordability' | 'nonWallet' | 'generic';

export function classifyPricedFailure(
  message: string | null | undefined,
): PricedFailureKind {
  if (!message) return 'generic';
  const m = message.toLowerCase();
  // Non-wallet FIRST: several of these messages share words ("buzz", "cap",
  // "limit") with affordability language, and the hooks reference is explicit
  // that buying Buzz must not be offered for them.
  if (
    m.includes('velocity') ||
    m.includes('rate limit') ||
    m.includes('rate-limit') ||
    m.includes('per-app') ||
    m.includes('app cap') ||
    m.includes('aggregate') ||
    m.includes('session cap') ||
    m.includes('temporarily unavailable') ||
    m.includes('currently unavailable') ||
    m.includes('try again later') ||
    m.includes('no price') ||
    m.includes('price quote') ||
    m.includes('missing price')
  ) {
    return 'nonWallet';
  }
  if (isInsufficientBuzz(message)) return 'affordability';
  // Per-user daily caps are wallet affordability, not platform limits. (The
  // non-wallet check above already ran: 'per-app'/'app cap' tokens don't fire
  // on 'per-user daily cap'.)
  if (m.includes('daily cap') || m.includes('per-user') || m.includes('per user')) {
    return 'affordability';
  }
  return 'generic';
}

/**
 * App-owned copy for a rejected `estimate()`, keyed on
 * `WorkflowEstimateError.code` — the only stable branch target on that
 * boundary. Unknown / non-estimate errors get the generic arm.
 */
export function estimateErrorCopy(code: unknown): string {
  if (code === 'no-cost') {
    return 'We couldn’t get a price for this character sheet. Try a different character or stack.';
  }
  if (code === 'failed') {
    return 'Pricing failed just now. Please try again.';
  }
  return 'Pricing is unavailable right now. Please try again shortly.';
}

/**
 * Classify a rejected `submit()` WITHOUT importing the SDK error class (kept
 * duck-typed so this stays unit-testable in node): read `.code`, and for
 * `'workflow-failed'` read `.snapshot.workflowId` to decide pollability.
 *
 * - 'exception'       — the host had no workflow to report. Usually nothing was
 *                       queued; retry is sensible but MUST reuse the SAME
 *                       idempotency key (the App owns that), and the copy must
 *                       not claim nothing was charged as a certainty.
 * - 'workflow-failed' — money MAY already be committed. Never blind-retry; the
 *                       caller may poll `pollWorkflowId` (null when the id is
 *                       the 'whatif' non-workflow sentinel) to learn the
 *                       workflow's actual fate before spending again.
 * - 'unknown'         — not a WorkflowSubmitError shape; generic copy + retry.
 */
export interface SubmitRejection {
  kind: 'exception' | 'workflow-failed' | 'unknown';
  /** A real orchestrator workflow id worth polling, or null (sentinel / none). */
  pollWorkflowId: string | null;
}

export function classifySubmitRejection(err: unknown): SubmitRejection {
  const code = (err as { code?: unknown } | null | undefined)?.code;
  if (code === 'exception') return { kind: 'exception', pollWorkflowId: null };
  if (code === 'workflow-failed') {
    const id = (err as { snapshot?: { workflowId?: unknown } } | null | undefined)?.snapshot
      ?.workflowId;
    return {
      kind: 'workflow-failed',
      pollWorkflowId: typeof id === 'string' && id !== 'whatif' && id !== '' ? id : null,
    };
  }
  return { kind: 'unknown', pollWorkflowId: null };
}

/** App-owned viewer copy for a rejected submit, by rejection kind. */
export function submitRejectionCopy(kind: SubmitRejection['kind']): {
  title: string;
  body: string;
} {
  switch (kind) {
    case 'exception':
      return {
        title: 'Couldn’t start the generation',
        body: 'Something interrupted the request before it reached the queue. Try again — we’ll reuse the same request so you aren’t charged twice.',
      };
    case 'workflow-failed':
      return {
        title: 'Generation didn’t finish',
        body: 'It may have started but didn’t complete, so we won’t retry automatically — your Buzz may already be committed. Check its progress, or start over.',
      };
    case 'unknown':
      return {
        title: 'Generation failed',
        body: 'Something went wrong before the generation started. Please try again.',
      };
  }
}

/** App-owned viewer copy for a priced (resolved-failed) outcome, by kind. */
export function pricedFailureCopy(kind: PricedFailureKind): { title: string; body: string } {
  switch (kind) {
    case 'affordability':
      return {
        title: 'Not enough Buzz',
        body: 'This generation costs more than your available Buzz. Top up to run it.',
      };
    case 'nonWallet':
      return {
        title: 'Generation unavailable right now',
        body: 'This isn’t about your balance — a platform or app limit is in the way. Buying Buzz won’t fix it; try again later.',
      };
    case 'generic':
      return {
        title: 'Generation failed',
        body: 'The generation didn’t complete. Please try again.',
      };
  }
}
