// Deterministic prompt composer for Character Sheet Studio.
//
// The sheet's reproducibility contract: the same (character, stack, panel,
// settings) ALWAYS produces the same prompt text. No timestamps, no randomness,
// no host-dependent data enters the composition — so a sheet regenerated weeks
// later, or resumed after a tab close, submits byte-identical prompts.
//
// Clause order is fixed:
//   1. character.description        — the base identity ("a cyberpunk fox mercenary")
//   2. character.traits             — appearance traits, ", "-joined
//   3. trigger words                — character.triggerWords + every stack LoRA's
//                                     trainedWords in stack order, ", "-joined
//   4. panel.promptModifier         — the framing (view, pose, expression, scene)
// Empty / whitespace-only fragments are dropped, so a character with no traits
// or a LoRA with no trained words composes cleanly (no stray commas).
//
// No React, no DOM — unit-tested in node (see prompt.test.ts).

import type {
  Character,
  ModelStack,
  SheetPanel,
  SheetSettings,
} from './types.js';

export interface ComposedPrompt {
  prompt: string;
  negativePrompt: string;
}

function cleanFragment(v: string | undefined | null): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim().replace(/\s+/g, ' ');
  return t === '' ? null : t;
}

/** ", "-join a string list after cleaning; null when nothing survives. */
function joinClean(values: readonly string[], sep: string): string | null {
  const parts: string[] = [];
  for (const v of values) {
    const c = cleanFragment(v);
    if (c) parts.push(c);
  }
  return parts.length > 0 ? parts.join(sep) : null;
}

export function composePanelPrompt(
  character: Character,
  stack: ModelStack,
  panel: SheetPanel,
  // settings is part of the contract surface (future style suffixes) even
  // though today's composition doesn't read it — keep it positional so call
  // sites don't churn when it does.
  _settings: SheetSettings,
): ComposedPrompt {
  const clauses: string[] = [];

  const description = cleanFragment(character.description);
  if (description) clauses.push(description);

  const traits = joinClean(character.traits, ', ');
  if (traits) clauses.push(traits);

  const triggerWords = joinClean(
    [
      ...character.triggerWords,
      ...stack.loras.flatMap((l) => l.triggerWords),
    ],
    ', ',
  );
  if (triggerWords) clauses.push(triggerWords);

  const modifier = cleanFragment(panel.promptModifier);
  if (modifier) clauses.push(modifier);

  return {
    prompt: clauses.join(', '),
    negativePrompt: cleanFragment(character.negativePrompt) ?? '',
  };
}
