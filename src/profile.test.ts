// Profile/display-image resolution: explicit pick wins, else the first
// generated image; stacks show their first generated image.

import { describe, expect, it } from 'vitest';

import {
  characterImageUrls,
  characterProfileUrl,
  stackImageUrl,
} from './sheet/profile.js';
import type { Character, SheetJob, SheetPanel } from './sheet/types.js';

const panel = (id: string, outputs: string[]): SheetPanel => ({
  id,
  kind: 'front',
  label: id,
  promptModifier: '',
  seed: 1,
  status: 'done',
  outputs,
  submitNonce: 1,
});

const sheet = (
  id: string,
  characterId: string,
  stackId: string,
  createdAt: string,
  panels: SheetPanel[],
): SheetJob => ({
  id,
  name: id,
  characterId,
  stackId,
  seed: 42,
  account: 'auto',
  useReference: false,
  status: 'complete',
  panels,
  createdAt,
  updatedAt: createdAt,
});

const kaida: Character = {
  id: 'char-1',
  name: 'Kaida',
  description: '',
  traits: [],
  triggerWords: [],
  negativePrompt: '',
  seedPolicy: 'locked',
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
};

// Deliberately unordered: the newer sheet is listed first.
const sheets: SheetJob[] = [
  sheet('sheet-new', 'char-1', 'stack-1', '2026-10-05T00:00:00.000Z', [
    panel('p3', ['https://img/new-front.png']),
  ]),
  sheet('sheet-old', 'char-1', 'stack-2', '2026-10-02T00:00:00.000Z', [
    panel('p1', ['https://img/old-front.png', 'https://img/old-front.png']),
    panel('p2', ['https://img/old-side.png']),
  ]),
  sheet('sheet-other', 'char-2', 'stack-1', '2026-10-01T00:00:00.000Z', [
    panel('p9', ['https://img/other.png']),
  ]),
];

describe('profile image resolution', () => {
  it('lists a character’s images oldest-sheet-first, panel order, de-duplicated', () => {
    expect(characterImageUrls(sheets, 'char-1')).toEqual([
      'https://img/old-front.png',
      'https://img/old-side.png',
      'https://img/new-front.png',
    ]);
  });

  it('defaults the profile to the first generated image', () => {
    expect(characterProfileUrl(kaida, sheets)).toBe('https://img/old-front.png');
  });

  it('an explicit pick wins over the default', () => {
    expect(
      characterProfileUrl(
        { ...kaida, profileImageUrl: 'https://img/old-side.png' },
        sheets,
      ),
    ).toBe('https://img/old-side.png');
  });

  it('no generations → no profile image', () => {
    expect(characterProfileUrl(kaida, [])).toBeUndefined();
    expect(characterImageUrls(sheets, 'char-none')).toEqual([]);
  });

  it('a stack’s display image is the first image generated with it', () => {
    // stack-1 was used by the other character's earlier sheet first.
    expect(stackImageUrl(sheets, 'stack-1')).toBe('https://img/other.png');
    expect(stackImageUrl(sheets, 'stack-2')).toBe('https://img/old-front.png');
    expect(stackImageUrl(sheets, 'stack-unused')).toBeUndefined();
  });
});
