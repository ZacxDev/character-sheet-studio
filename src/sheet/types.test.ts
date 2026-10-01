import { describe, expect, it } from 'vitest';

import {
  CHARACTER_PREFIX,
  DEFAULT_SETTINGS,
  SETTINGS_KEY,
  SHEET_PREFIX,
  STACK_PREFIX,
  characterKey,
  defaultPanelSpecs,
  isPanelKind,
  isPanelStatus,
  isSheetResumable,
  isSheetStatus,
  isTerminalPanelStatus,
  newCharacter,
  newId,
  newModelStack,
  newSheetJob,
  normalizeCharacter,
  normalizeModelStack,
  normalizeSettings,
  normalizeSheetJob,
  removeById,
  sheetKey,
  sheetProgress,
  stackKey,
  upsertById,
  type SheetJob,
} from './types.js';

describe('storage keys', () => {
  it('builds versioned keys under the right prefixes', () => {
    expect(characterKey('abc')).toBe(`${CHARACTER_PREFIX}abc`);
    expect(stackKey('abc')).toBe(`${STACK_PREFIX}abc`);
    expect(sheetKey('abc')).toBe(`${SHEET_PREFIX}abc`);
    expect(SETTINGS_KEY).toBe('v1:settings');
  });

  it('keeps constructed keys far under the 200-char host cap', () => {
    const id = newId();
    for (const k of [characterKey(id), stackKey(id), sheetKey(id)]) {
      expect(k.length).toBeLessThan(100);
    }
  });
});

describe('newId', () => {
  it('returns unique non-empty ids', () => {
    const a = newId();
    const b = newId();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThan(0);
  });
});

describe('normalizeCharacter', () => {
  it('passes a valid character through', () => {
    const c = newCharacter({ name: 'Mira' });
    expect(normalizeCharacter(c)).toEqual(c);
  });

  it('rejects garbage', () => {
    expect(normalizeCharacter(null)).toBeNull();
    expect(normalizeCharacter('nope')).toBeNull();
    expect(normalizeCharacter({})).toBeNull();
    expect(normalizeCharacter({ id: 'x' })).toBeNull();
    expect(normalizeCharacter({ name: 'x' })).toBeNull();
    expect(normalizeCharacter({ id: 'x', name: '   ' })).toBeNull();
  });

  it('defaults optionals and coerces the seed policy', () => {
    const c = normalizeCharacter({ id: 'a', name: 'Mira', seedPolicy: 'bogus' });
    expect(c?.seedPolicy).toBe('locked');
    expect(c?.traits).toEqual([]);
    expect(c?.description).toBe('');
    const varied = normalizeCharacter({ id: 'a', name: 'M', seedPolicy: 'varied' });
    expect(varied?.seedPolicy).toBe('varied');
  });

  it('drops a malformed reference image instead of the row', () => {
    const c = normalizeCharacter({
      id: 'a',
      name: 'M',
      referenceImage: { url: 'https://x', width: 'wide' },
    });
    expect(c?.referenceImage).toBeUndefined();
    const ok = normalizeCharacter({
      id: 'a',
      name: 'M',
      referenceImage: { url: 'https://x', width: 512, height: 512 },
    });
    expect(ok?.referenceImage).toEqual({ url: 'https://x', width: 512, height: 512 });
  });
});

describe('normalizeModelStack', () => {
  const checkpoint = { modelId: 1, modelVersionId: 2, baseModel: 'SDXL' };

  it('rejects stacks without a valid checkpoint', () => {
    expect(normalizeModelStack({ id: 'a', name: 's' })).toBeNull();
    expect(
      normalizeModelStack({ id: 'a', name: 's', checkpoint: { modelId: 1 } }),
    ).toBeNull();
  });

  it('clamps LoRA strengths into the server contract [-1, 2]', () => {
    const s = normalizeModelStack({
      id: 'a',
      name: 's',
      checkpoint,
      loras: [
        { modelVersionId: 10, strength: 5 },
        { modelVersionId: 11, strength: -3 },
        { modelVersionId: 12, strength: NaN },
      ],
    });
    expect(s?.loras.map((l) => l.strength)).toEqual([2, -1, 1]);
  });

  it('drops invalid LoRAs and truncates past the 5-LoRA server cap', () => {
    const loras = Array.from({ length: 7 }, (_, i) => ({
      modelVersionId: i === 3 ? -1 : 100 + i,
      strength: 0.8,
    }));
    const s = normalizeModelStack({ id: 'a', name: 's', checkpoint, loras });
    expect(s?.loras).toHaveLength(5);
    expect(s?.loras.every((l) => l.modelVersionId > 0)).toBe(true);
  });

  it('newModelStack clamps and truncates at construction', () => {
    const s = newModelStack({
      name: 's',
      checkpoint,
      loras: Array.from({ length: 6 }, (_, i) => ({
        modelVersionId: 100 + i,
        strength: 9,
        triggerWords: [],
      })),
    });
    expect(s.loras).toHaveLength(5);
    expect(s.loras[0]?.strength).toBe(2);
  });
});

describe('panel guards', () => {
  it('recognizes the six panel kinds', () => {
    expect(isPanelKind('front')).toBe(true);
    expect(isPanelKind('scenario')).toBe(true);
    expect(isPanelKind('portrait')).toBe(false);
    expect(isPanelKind(null)).toBe(false);
  });

  it('recognizes panel statuses and terminality', () => {
    expect(isPanelStatus('running')).toBe(true);
    expect(isPanelStatus('exploding')).toBe(false);
    expect(isTerminalPanelStatus('done')).toBe(true);
    expect(isTerminalPanelStatus('failed')).toBe(true);
    expect(isTerminalPanelStatus('canceled')).toBe(true);
    expect(isTerminalPanelStatus('running')).toBe(false);
    expect(isTerminalPanelStatus('queued')).toBe(false);
    expect(isSheetStatus('paused')).toBe(true);
    expect(isSheetStatus('archived')).toBe(false);
  });
});

describe('defaultPanelSpecs', () => {
  it('builds the turnaround + expressions + scenarios set', () => {
    const specs = defaultPanelSpecs();
    expect(specs).toHaveLength(8);
    expect(specs.map((s) => s.kind)).toEqual([
      'front',
      'side',
      'back',
      'three-quarter',
      'expression',
      'expression',
      'scenario',
      'scenario',
    ]);
    const labels = specs.map((s) => s.label);
    expect(new Set(labels).size).toBe(labels.length);
    for (const s of specs) expect(s.promptModifier.length).toBeGreaterThan(0);
  });
});

describe('sheet jobs', () => {
  const job = (): SheetJob =>
    newSheetJob({ name: 'Mira sheet', characterId: 'c1', stackId: 's1', seed: 100 });

  it('derives per-panel seeds from the sheet seed', () => {
    const j = job();
    expect(j.panels.map((p) => p.seed)).toEqual([
      100, 101, 102, 103, 104, 105, 106, 107,
    ]);
    expect(j.panels.every((p) => p.status === 'queued')).toBe(true);
    expect(j.status).toBe('draft');
  });

  it('rejects jobs with no salvageable panels', () => {
    expect(normalizeSheetJob({ id: 'a', characterId: 'c', stackId: 's', seed: 1 })).toBeNull();
    expect(
      normalizeSheetJob({
        id: 'a',
        characterId: 'c',
        stackId: 's',
        seed: 1,
        panels: [{ nope: true }],
      }),
    ).toBeNull();
  });

  it('keeps workflow ids and coerces bad statuses to queued', () => {
    const j = job();
    j.panels[0] = { ...j.panels[0]!, workflowId: 'wf-1', status: 'bogus' as never };
    const n = normalizeSheetJob(JSON.parse(JSON.stringify(j)));
    expect(n?.panels[0]?.workflowId).toBe('wf-1');
    expect(n?.panels[0]?.status).toBe('queued');
  });

  it('measures progress and resumability', () => {
    const j = job();
    expect(sheetProgress(j)).toEqual({ done: 0, total: 8 });
    expect(isSheetResumable(j)).toBe(true);
    j.panels[0] = { ...j.panels[0]!, status: 'done', outputs: ['https://x/1.png'] };
    expect(sheetProgress(j)).toEqual({ done: 1, total: 8 });
    const finished: SheetJob = {
      ...j,
      panels: j.panels.map((p) => ({ ...p, status: 'done' as const, outputs: ['u'] })),
    };
    expect(isSheetResumable(finished)).toBe(false);
  });
});

describe('normalizeSettings', () => {
  it('returns defaults for garbage', () => {
    expect(normalizeSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(normalizeSettings({})).toEqual(DEFAULT_SETTINGS);
  });

  it('clamps dimensions and quantity into the server contract', () => {
    const s = normalizeSettings({
      imageWidth: 99999,
      imageHeight: 10,
      quantity: 7,
      defaultPanels: ['front', 'bogus', 42],
    });
    expect(s.imageWidth).toBe(DEFAULT_SETTINGS.imageWidth);
    expect(s.imageHeight).toBe(DEFAULT_SETTINGS.imageHeight);
    expect(s.quantity).toBe(DEFAULT_SETTINGS.quantity);
    expect(s.defaultPanels).toEqual(['front']);
  });

  it('keeps valid settings', () => {
    const s = normalizeSettings({
      imageWidth: 768,
      imageHeight: 1024,
      quantity: 2,
      defaultPanels: ['front', 'back'],
    });
    expect(s).toEqual({ imageWidth: 768, imageHeight: 1024, quantity: 2, defaultPanels: ['front', 'back'] });
  });
});

describe('collection helpers', () => {
  it('upserts by id preserving order', () => {
    const a = { id: 'a', v: 1 };
    const b = { id: 'b', v: 2 };
    expect(upsertById([a], b)).toEqual([a, b]);
    expect(upsertById([a, b], { id: 'a', v: 9 })).toEqual([{ id: 'a', v: 9 }, b]);
  });

  it('removes by id', () => {
    expect(removeById([{ id: 'a' }, { id: 'b' }], 'a')).toEqual([{ id: 'b' }]);
  });
});
