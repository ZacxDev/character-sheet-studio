// Prompt enhancement for sheet panels — built on the host's REGISTERED
// `chat-completion` step (`{ kind: 'step', step: 'chat-completion' }`), the
// documented block-side LLM primitive. The orchestration REST recipe
// (`/v2/consumer/recipes/promptEnhancement`) needs an orchestration Bearer
// token a sandboxed block never holds, and no `promptEnhancement` step is
// registered for blocks — so the enhancement is expressed as a chat
// completion with a rewrite instruction instead, priced by the host's live
// quote through the same estimate → submit → poll lifecycle as generation.
//
// The reply rides the terminal poll snapshot's `textOutputs` (host-derived,
// moderation-scanned before release; `textOutputWithheld` explains a
// withheld reply). Those two fields are live on the host but not yet in the
// published SDK snapshot type, so they're read through a structural cast —
// the transport validator passes unknown fields through untouched.
//
// No React, no DOM — unit-tested in node (see enhance.test.ts).

import type { BlockWorkflowSnapshot, WorkflowBody } from '@civitai/app-sdk/blocks';

/**
 * One of the host registry's allowlisted chat models. The allowlist is
 * host-side and load-bearing: a fabricated model name is quoted, CHARGED,
 * and then fails at execution with no output and no refund — so this string
 * must stay boring and well-known.
 */
export const ENHANCE_MODEL = 'openai/gpt-4o-mini';

/** Output budget for one rewritten prompt (~120 words of prose). */
export const ENHANCE_MAX_TOKENS = 400;

/**
 * The workflow body that rewrites one composed panel prompt. `baseModel` is
 * the checkpoint's family (e.g. "SDXL 1.0") so the rewrite is tuned to the
 * ecosystem the prompt will actually run on.
 */
export function buildEnhanceBody(composedPrompt: string, baseModel: string): WorkflowBody {
  return {
    kind: 'step',
    step: 'chat-completion',
    params: {
      model: ENHANCE_MODEL,
      maxTokens: ENHANCE_MAX_TOKENS,
      messages: [
        {
          role: 'system',
          content:
            `You rewrite image-generation prompts for the ${baseModel} model family. ` +
            'Return ONLY the rewritten prompt — no preamble, no explanation, no quotation marks, no line breaks. ' +
            'Preserve every trigger word, character name, and proper noun from the input verbatim. ' +
            'Keep the same subject, identity, pose, and framing; enrich it with concrete visual detail ' +
            '(appearance, clothing and materials, lighting, composition, rendering style). ' +
            'Keep it under 120 words.',
        },
        { role: 'user', content: composedPrompt },
      ],
    },
  };
}

/**
 * The workflow body that rewrites a character's POSITIVE prompt — the
 * reusable identity fragment (`character.description`) that starts every
 * panel prompt. Unlike the panel rewrite this must NOT bake in a pose,
 * scene, or framing: panels supply those per image, so the output stays a
 * fragment that composes. No base-model tuning either — a character is no
 * longer tied to one stack, so the instruction stays model-neutral.
 */
export function buildCharacterPromptEnhanceBody(fragment: string): WorkflowBody {
  return {
    kind: 'step',
    step: 'chat-completion',
    params: {
      model: ENHANCE_MODEL,
      maxTokens: ENHANCE_MAX_TOKENS,
      messages: [
        {
          role: 'system',
          content:
            'You rewrite character description fragments for image generation. ' +
            'The input is a reusable character description that is combined with pose and scene prompts later. ' +
            'Return ONLY the rewritten fragment — no preamble, no explanation, no quotation marks, no line breaks. ' +
            'Preserve every trigger word, character name, and proper noun from the input verbatim. ' +
            'Enrich identity and appearance with concrete visual detail (species and build, face, hair or fur, eyes, markings, signature clothing and materials, rendering style). ' +
            'Do NOT add a pose, action, scene, background, camera framing, or shot lighting — those are chosen separately for each image. ' +
            'Keep it under 100 words.',
        },
        { role: 'user', content: fragment },
      ],
    },
  };
}

/**
 * The workflow body that refines a character's NEGATIVE prompt — a
 * comma-separated exclusion list, not prose. The rewrite keeps the list
 * shape: every input term survives and closely related exclusions are
 * added; sentences would corrupt the field's meaning at generation time.
 */
export function buildNegativePromptEnhanceBody(negativePrompt: string): WorkflowBody {
  return {
    kind: 'step',
    step: 'chat-completion',
    params: {
      model: ENHANCE_MODEL,
      maxTokens: ENHANCE_MAX_TOKENS,
      messages: [
        {
          role: 'system',
          content:
            'You refine negative prompts for image generation — comma-separated lists of things to exclude from an image. ' +
            'Return ONLY the refined list: comma-separated terms, no sentences, no preamble, no explanation, no quotation marks, no line breaks. ' +
            'Keep every term from the input (reword a term only for clarity), and add closely related exclusion terms that commonly belong with them — image quality, anatomy, and artifact terms. ' +
            'Keep it under 60 terms.',
        },
        { role: 'user', content: negativePrompt },
      ],
    },
  };
}

/** What a terminal enhance snapshot gave back. */
export type EnhanceOutcome =
  | { type: 'text'; text: string }
  | { type: 'withheld'; reason: string }
  | { type: 'none' };

/**
 * Read the enhancement out of a terminal snapshot. `textOutputs` carries the
 * released (scanned) reply; `textOutputWithheld` carries a user-facing reason
 * when text was produced but kept back (or was unpublishable). Anything else
 * — an older host, a snapshot without a step — is `none`, and callers keep
 * the original prompt.
 */
export function enhanceOutcomeFromSnapshot(snap: BlockWorkflowSnapshot): EnhanceOutcome {
  const ext = snap as BlockWorkflowSnapshot & {
    textOutputs?: unknown;
    textOutputWithheld?: { reason?: unknown } | null;
  };
  if (Array.isArray(ext.textOutputs)) {
    const text = ext.textOutputs.find(
      (t): t is string => typeof t === 'string' && t.trim() !== '',
    );
    if (text) return { type: 'text', text: text.trim() };
  }
  const reason = ext.textOutputWithheld?.reason;
  if (typeof reason === 'string' && reason.trim() !== '') {
    return { type: 'withheld', reason: reason.trim() };
  }
  return { type: 'none' };
}
