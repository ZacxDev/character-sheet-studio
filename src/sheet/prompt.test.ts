import { describe, expect, it } from 'vitest';

import type {
  Character,
  ModelStack,
  SheetPanel,
  SheetSettings,
} from './types.js';
import { DEFAULT_SETTINGS } from './types.js';
import { composePanelPrompt } from './prompt.js';

const character = (over: Partial<Character> = {}): Character => ({
  id: 'char_1',
  name: 'Nyx',
  description: 'a cyberpunk fox mercenary',
  traits: ['silver-streaked fur', 'glowing amber eyes'],
  triggerWords: ['nyx_fox'],
  negativePrompt: 'blurry, watermark',
  seedPolicy: 'locked',
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
  ...over,
});

const stack = (over: Partial<ModelStack> = {}): ModelStack => ({
  id: 'stack_1',
  name: 'Pony stack',
  checkpoint: { modelId: 1, modelVersionId: 2, baseModel: 'Pony' },
  loras: [
    { modelVersionId: 10, strength: 0.8, triggerWords: ['detail_tweak'] },
    { modelVersionId: 11, strength: 1, triggerWords: [] },
  ],
  notes: '',
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
  ...over,
});

const panel = (over: Partial<SheetPanel> = {}): SheetPanel => ({
  id: 'panel_1',
  kind: 'front',
  label: 'Front view',
  promptModifier: 'character turnaround sheet, front view, full body',
  seed: 1234,
  status: 'queued',
  outputs: [],
  submitNonce: 0,
  ...over,
});

const settings: SheetSettings = { ...DEFAULT_SETTINGS };

describe('composePanelPrompt', () => {
  it('composes description + traits + trigger words + LoRA words + panel modifier in fixed order', () => {
    const { prompt } = composePanelPrompt(character(), stack(), panel(), settings);
    expect(prompt).toBe(
      'a cyberpunk fox mercenary, silver-streaked fur, glowing amber eyes, nyx_fox, detail_tweak, character turnaround sheet, front view, full body',
    );
  });

  it('threads the character negative prompt through', () => {
    expect(composePanelPrompt(character(), stack(), panel(), settings).negativePrompt).toBe(
      'blurry, watermark',
    );
  });

  it('drops empty / whitespace-only fragments without stray commas', () => {
    const c = character({ description: '  ', traits: [], triggerWords: ['  '] });
    const s = stack({ loras: [] });
    const p = panel({ promptModifier: 'front view' });
    expect(composePanelPrompt(c, s, p, settings).prompt).toBe('front view');
  });

  it('normalizes inner whitespace', () => {
    const c = character({ description: 'a  fox\nmercenary' });
    const { prompt } = composePanelPrompt(c, stack({ loras: [] }), panel({ promptModifier: '' }), settings);
    expect(prompt.startsWith('a fox mercenary')).toBe(true);
  });

  it('is deterministic — same inputs always produce the same prompt', () => {
    const a = composePanelPrompt(character(), stack(), panel(), settings);
    const b = composePanelPrompt(character(), stack(), panel(), settings);
    expect(a).toEqual(b);
  });

  it('different panels produce different prompts for the same character', () => {
    const a = composePanelPrompt(character(), stack(), panel({ promptModifier: 'front view' }), settings);
    const b = composePanelPrompt(character(), stack(), panel({ promptModifier: 'back view' }), settings);
    expect(a.prompt).not.toBe(b.prompt);
  });
});
