// Profile / display-image resolution for characters and stacks.
//
// A character's profile image is display-only: the explicit pick stored on
// the character (`profileImageUrl`, chosen from their generated images in
// the edit form) wins forever; without a pick it resolves to the FIRST
// generated image (earliest sheet, first panel with an output). No
// generations yet → no image; the UI shows an initial-letter placeholder.
//
// A stack's display image is its first generated image across every sheet
// that used it. Stacks that have never generated have no image.

import type { Character, SheetJob } from './types.js';

const byCreatedAt = (a: SheetJob, b: SheetJob): number =>
  a.createdAt.localeCompare(b.createdAt);

/** Every generated image url for a character, oldest first, de-duplicated. */
export function characterImageUrls(sheets: SheetJob[], characterId: string): string[] {
  const mine = sheets.filter((s) => s.characterId === characterId).sort(byCreatedAt);
  const urls: string[] = [];
  for (const sheet of mine) {
    for (const panel of sheet.panels) {
      for (const url of panel.outputs) {
        if (!urls.includes(url)) urls.push(url);
      }
    }
  }
  return urls;
}

/** The character's first generated image, if they have generated anything. */
export function firstGeneratedImageUrl(
  sheets: SheetJob[],
  characterId: string,
): string | undefined {
  return characterImageUrls(sheets, characterId)[0];
}

/** Resolved profile image for display: explicit pick, else first generated. */
export function characterProfileUrl(
  character: Character,
  sheets: SheetJob[],
): string | undefined {
  return character.profileImageUrl ?? firstGeneratedImageUrl(sheets, character.id);
}

/** A stack's display image: the first image any sheet generated with it. */
export function stackImageUrl(sheets: SheetJob[], stackId: string): string | undefined {
  const using = sheets.filter((s) => s.stackId === stackId).sort(byCreatedAt);
  for (const sheet of using) {
    for (const panel of sheet.panels) {
      if (panel.outputs[0]) return panel.outputs[0];
    }
  }
  return undefined;
}
