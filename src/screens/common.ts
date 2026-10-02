// Shared bits for the sheet screens: storage-error copy + tiny form helpers.
// No money logic here — pure presentation helpers.

import type { StoreErrorKind } from '../sheet/store.js';

/** App-owned viewer copy for a storage save failure. Never the host's prose. */
export function storeErrorMessage(kind: StoreErrorKind): string {
  switch (kind) {
    case 'quota-exceeded':
      return 'Storage is full. Delete an old character, stack, or sheet to make room, then try again.';
    case 'row-limit':
      return 'You’ve hit the storage row limit. Delete something old to make room, then try again.';
    case 'value-too-large':
      return 'That entry is too large to store. Shorten the text and try again.';
    case 'request-failed':
      return 'Saving failed — the connection dropped. Your changes are still on screen; try again.';
    case 'not-permitted':
      return 'Saving is unavailable — the app is missing a storage permission it needs. Your changes are still on screen; this needs an app fix, not another try.';
    case 'unknown':
      return 'Saving failed for an unknown reason. Your changes are still on screen; try again.';
  }
}

/** Split a comma-separated input into a cleaned string list. */
export function parseListInput(raw: string): string[] {
  return raw
    .split(',')
    .map((s) => s.trim().replace(/\s+/g, ' '))
    .filter((s) => s !== '');
}
