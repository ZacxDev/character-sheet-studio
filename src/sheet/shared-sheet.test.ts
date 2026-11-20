import { describe, expect, it } from 'vitest';

import { buildSharedSheetDoc, normalizeSharedSheetDoc, SHARED_PANELS_MAX } from './shared-sheet.js';

describe('buildSharedSheetDoc', () => {
  it('keeps only panels with a positive integer image ID, and only label + imageId', () => {
    const doc = buildSharedSheetDoc({
      characterName: '  Morov ',
      sheetName: 'Turnaround',
      panels: [
        { label: 'Front', imageId: 11 },
        { label: 'Side', imageId: undefined },
        { label: 'Back', imageId: 0 },
        { label: 'Pose', imageId: 2.5 },
        { label: 'Detail', imageId: 907 },
      ],
    });
    expect(doc).toEqual({
      v: 1,
      characterName: 'Morov',
      sheetName: 'Turnaround',
      panels: [
        { label: 'Front', imageId: 11 },
        { label: 'Detail', imageId: 907 },
      ],
    });
  });

  it('clips names and labels to the manifest schema limits and caps the panel count', () => {
    const doc = buildSharedSheetDoc({
      characterName: 'c'.repeat(300),
      sheetName: 's'.repeat(121),
      panels: Array.from({ length: SHARED_PANELS_MAX + 5 }, (_, i) => ({ label: 'l'.repeat(90), imageId: i + 1 })),
    });
    expect(doc.characterName).toHaveLength(120);
    expect(doc.sheetName).toHaveLength(120);
    expect(doc.panels).toHaveLength(SHARED_PANELS_MAX);
    expect(doc.panels[0].label).toHaveLength(80);
  });
});

describe('normalizeSharedSheetDoc', () => {
  it('drops every field it does not declare, including planted urls', () => {
    const out = normalizeSharedSheetDoc({
      v: 1,
      characterName: 'Morov',
      sheetName: 'Turnaround',
      url: 'https://evil.test/a.png',
      panels: [
        { label: 'Front', imageId: 11, url: 'https://evil.test/b.png' },
        { label: 'Bad id', imageId: '12' },
        { imageId: 13 },
      ],
    });
    expect(out).toEqual({
      v: 1,
      characterName: 'Morov',
      sheetName: 'Turnaround',
      panels: [{ label: 'Front', imageId: 11 }],
    });
  });

  it('rejects anything that is not a version-1 sheet record', () => {
    expect(normalizeSharedSheetDoc(null)).toBeNull();
    expect(normalizeSharedSheetDoc({ v: 2, characterName: 'a', sheetName: 'b', panels: [] })).toBeNull();
    expect(normalizeSharedSheetDoc({ v: 1, characterName: 'a', sheetName: 'b' })).toBeNull();
    expect(normalizeSharedSheetDoc({ v: 1, characterName: 3, sheetName: 'b', panels: [] })).toBeNull();
  });
});

describe('saveSharedSheet', () => {
  it('a key whose record is gone gets a NEW key instead of reviving the old link', async () => {
    const { createAppFakeStorage } = await import('./fake-doc-storage.js');
    const { saveSharedSheet, deleteSharedSheet } = await import('./shared-sheet.js');
    const fake = createAppFakeStorage();
    const source = async () => fake.storage;
    const doc = { v: 1 as const, characterName: 'A', sheetName: 'B', panels: [{ label: 'F', imageId: 7 }] };
    const first = await saveSharedSheet(source, doc);
    expect(await saveSharedSheet(source, doc, first)).toBe(first); // live record: replaced in place
    await deleteSharedSheet(source, first);
    const second = await saveSharedSheet(source, doc, first);
    expect(second).not.toBe(first);
    expect(await fake.storage.collection('shared_sheets').get(first)).toBeNull();
  });
});
