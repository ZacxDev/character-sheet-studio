import { describe, expect, it } from 'vitest';

import type { Character, ModelStack, SheetPanel } from './types.js';
import { DEFAULT_SETTINGS } from './types.js';
import { buildSheetPanelBody } from './body.js';

const character: Character = {
  id: 'char_1',
  name: 'Nyx',
  description: 'a cyberpunk fox mercenary',
  traits: [],
  triggerWords: ['nyx_fox'],
  negativePrompt: 'blurry',
  referenceImage: { url: 'https://image.civitai.com/x/ref.jpg', width: 1024, height: 1024 },
  seedPolicy: 'locked',
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
};

const stack: ModelStack = {
  id: 'stack_1',
  name: 'Pony stack',
  checkpoint: { modelId: 7, modelVersionId: 77, baseModel: 'Pony', name: 'Pony V6' },
  loras: [{ modelVersionId: 10, strength: 0.8, triggerWords: ['detail_tweak'], name: 'Detailer' }],
  notes: '',
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
};

const panel: SheetPanel = {
  id: 'panel_1',
  kind: 'front',
  label: 'Front view',
  promptModifier: 'front view, full body',
  seed: 4242,
  status: 'queued',
  outputs: [],
  submitNonce: 0,
};

describe('buildSheetPanelBody', () => {
  it('builds the composed prompt with checkpoint + LoRA + seed', () => {
    const body = buildSheetPanelBody(panel, character, stack, DEFAULT_SETTINGS, {
      account: 'auto',
      useReference: false,
    });
    expect(body.kind).toBe('textToImage');
    expect(body.modelVersionId).toBe(77);
    expect(body.modelId).toBe(7);
    expect(body.params.prompt).toBe('a cyberpunk fox mercenary, nyx_fox, detail_tweak, front view, full body');
    expect(body.params.negativePrompt).toBe('blurry');
    expect(body.params.seed).toBe(4242);
    expect(body.additionalResources).toEqual([{ modelVersionId: 10, strength: 0.8 }]);
    expect('sourceImages' in body).toBe(false);
    expect('accountType' in body).toBe(false);
  });

  it('threads the reference portrait when useReference is on', () => {
    const body = buildSheetPanelBody(panel, character, stack, DEFAULT_SETTINGS, {
      account: 'auto',
      useReference: true,
    });
    expect(body.sourceImages).toEqual([character.referenceImage]);
  });

  it('omits sourceImages when useReference is on but the character has no portrait', () => {
    const noRef = { ...character, referenceImage: undefined };
    const body = buildSheetPanelBody(panel, noRef, stack, DEFAULT_SETTINGS, {
      account: 'auto',
      useReference: true,
    });
    expect('sourceImages' in body).toBe(false);
  });

  it('threads a picked Buzz pool as accountType', () => {
    const body = buildSheetPanelBody(panel, character, stack, DEFAULT_SETTINGS, {
      account: 'yellow',
      useReference: false,
    });
    expect(body.accountType).toBe('yellow');
  });
});
