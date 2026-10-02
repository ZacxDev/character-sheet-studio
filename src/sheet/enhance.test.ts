// enhance.ts — the chat-completion rewrite body + the snapshot text reader.
// Pins: the exact registry arm (a fabricated step/model would be quoted,
// charged, and fail at execution), the allowlisted model id, the rewrite
// contract in the system prompt, and the moderation-release read-back
// (textOutputs / textOutputWithheld are live host fields the published SDK
// snapshot type hasn't caught up with).

import { describe, expect, it } from 'vitest';
import type { BlockWorkflowSnapshot } from '@civitai/app-sdk/blocks';

import {
  ENHANCE_MAX_TOKENS,
  ENHANCE_MODEL,
  buildEnhanceBody,
  enhanceOutcomeFromSnapshot,
} from './enhance.js';

describe('buildEnhanceBody', () => {
  it('targets the registered chat-completion step with an allowlisted model', () => {
    const body = buildEnhanceBody('a knight, kaida_cyber', 'SDXL 1.0');
    if (!('step' in body) || body.step !== 'chat-completion') {
      throw new Error('expected a chat-completion step body');
    }
    expect(body.kind).toBe('step');
    expect(body.params.model).toBe('openai/gpt-4o-mini');
    expect(ENHANCE_MODEL).toBe('openai/gpt-4o-mini');
    expect(body.params.maxTokens).toBe(ENHANCE_MAX_TOKENS);
  });

  it('carries the rewrite contract and the prompt verbatim', () => {
    const body = buildEnhanceBody('a knight, kaida_cyber, front view', 'SDXL 1.0');
    if (!('step' in body) || body.step !== 'chat-completion') {
      throw new Error('expected a chat-completion step body');
    }
    const messages = body.params.messages as { role: string; content: string }[];
    expect(messages).toHaveLength(2);
    // The family is named so the rewrite is tuned to the checkpoint's ecosystem.
    expect(messages[0].content).toContain('SDXL 1.0');
    // Identity preservation is the whole point of the feature.
    expect(messages[0].content).toContain('verbatim');
    expect(messages[0].content).toContain('Return ONLY the rewritten prompt');
    expect(messages[1]).toEqual({ role: 'user', content: 'a knight, kaida_cyber, front view' });
  });
});

describe('enhanceOutcomeFromSnapshot', () => {
  const snap = (extra: Record<string, unknown>): BlockWorkflowSnapshot =>
    ({ workflowId: 'wf-1', status: 'succeeded', ...extra }) as BlockWorkflowSnapshot;

  it('reads the released text, trimmed', () => {
    expect(
      enhanceOutcomeFromSnapshot(snap({ textOutputs: ['  a knight in chrome armor  '] })),
    ).toEqual({ type: 'text', text: 'a knight in chrome armor' });
  });

  it('skips blank entries and takes the first real one', () => {
    expect(
      enhanceOutcomeFromSnapshot(snap({ textOutputs: ['', '  ', 'real text'] })),
    ).toEqual({ type: 'text', text: 'real text' });
  });

  it('surfaces a withheld reason when no text was released', () => {
    expect(
      enhanceOutcomeFromSnapshot(
        snap({ textOutputs: [], textOutputWithheld: { reason: 'Contains a blocked term' } }),
      ),
    ).toEqual({ type: 'withheld', reason: 'Contains a blocked term' });
  });

  it('prefers released text over a withheld notice', () => {
    expect(
      enhanceOutcomeFromSnapshot(
        snap({ textOutputs: ['kept'], textOutputWithheld: { reason: 'ignored' } }),
      ),
    ).toEqual({ type: 'text', text: 'kept' });
  });

  it('returns none for a snapshot without text fields (older host)', () => {
    expect(enhanceOutcomeFromSnapshot(snap({}))).toEqual({ type: 'none' });
    expect(enhanceOutcomeFromSnapshot(snap({ textOutputs: 'not-an-array' }))).toEqual({
      type: 'none',
    });
    expect(
      enhanceOutcomeFromSnapshot(snap({ textOutputWithheld: { reason: '  ' } })),
    ).toEqual({ type: 'none' });
  });
});
