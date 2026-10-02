/**
 * Character Sheet Studio — durable store on top of `useAppStorage`.
 *
 * `SheetStore` wraps the host-mediated KV store with the app's key scheme,
 * normalizers (malformed rows are dropped, never thrown), cursor-paginated
 * listing, and error classification. Storage failures are surfaced as
 * `StoreErrorKind` — the app renders its own copy, never the host's prose.
 *
 * Two scoping facts from the platform, encoded here as comments where they
 * bite:
 * - Keys are namespaced per (block instance, viewer); the byte/row budgets
 *   are enforced per (app, viewer). Every instance of this app shares one
 *   budget for the viewer.
 * - Anonymous viewers read `null` / empty lists and hard-reject writes. The
 *   store does not gate on that — the UI layer decides (see
 *   `useSheetLibrary`), because only it knows the viewer's state.
 */

import {
  classifyAppStorageError,
  type AppStorageRejectionReason,
} from '@civitai/app-sdk/blocks';
import type { AppStorageQuota, UseAppStorage } from '@civitai/blocks-react';

import {
  CHARACTER_PREFIX,
  SETTINGS_KEY,
  SHEET_PREFIX,
  STACK_PREFIX,
  characterKey,
  normalizeCharacter,
  normalizeModelStack,
  normalizeSettings,
  normalizeSheetJob,
  sheetKey,
  stackKey,
  type Character,
  type ModelStack,
  type SheetJob,
  type SheetSettings,
} from './types.js';

/** Closed set of storage failure modes the UI branches on. */
export type StoreErrorKind =
  | 'value-too-large'
  | 'quota-exceeded'
  | 'row-limit'
  | 'request-failed'
  | 'not-permitted'
  | 'unknown';

/**
 * The host's scope-denied message for app storage, e.g.
 * `storage set requires the apps:storage:write scope`. The SDK's classifier
 * deliberately leaves authorization failures unrecognized (the set is
 * open-ended), but THIS one has a fixed template and a known meaning: the
 * block's manifest does not declare the storage scope. Retrying cannot fix
 * it, so it gets its own kind instead of landing in 'unknown'.
 */
const STORAGE_SCOPE_DENIED =
  /storage (get|set|delete|list) requires the apps:storage:(read|write) scope/;

function errorMessage(error: unknown): string {
  if (typeof error === 'string') return error;
  if (error instanceof Error) return error.message;
  if (typeof error === 'object' && error !== null && 'message' in error) {
    const m = (error as { message?: unknown }).message;
    return typeof m === 'string' ? m : '';
  }
  return '';
}

/**
 * Map the SDK's rejection classification onto the app's closed set.
 * `null` (unrecognized, incl. anonymous-write rejections and expired tokens)
 * lands in 'unknown' — the UI must not assume "transient, retry".
 */
export function classifyStoreError(error: unknown): StoreErrorKind {
  if (STORAGE_SCOPE_DENIED.test(errorMessage(error))) return 'not-permitted';
  const reason: AppStorageRejectionReason | null =
    classifyAppStorageError(error);
  switch (reason) {
    case 'value-too-large':
      return 'value-too-large';
    case 'user-quota-exceeded':
    case 'app-quota-exceeded':
      return 'quota-exceeded';
    case 'user-row-limit':
    case 'app-row-limit':
      return 'row-limit';
    case 'request-failed':
      return 'request-failed';
    default:
      return 'unknown';
  }
}

/** Host cap on key length — our keys are constructed, this is a dev guard. */
const MAX_KEY_LENGTH = 200;

function assertKeyLength(key: string): void {
  if (key.length > MAX_KEY_LENGTH) {
    throw new Error(
      `character-sheet-studio: storage key exceeds ${MAX_KEY_LENGTH} chars`,
    );
  }
}

export class SheetStore {
  constructor(private readonly storage: UseAppStorage) {}

  // --- characters ----------------------------------------------------------

  async listCharacters(): Promise<Character[]> {
    return this.listByPrefix(CHARACTER_PREFIX, normalizeCharacter);
  }

  async getCharacter(id: string): Promise<Character | null> {
    const key = characterKey(id);
    assertKeyLength(key);
    return normalizeCharacter(await this.storage.get(key));
  }

  async saveCharacter(character: Character): Promise<void> {
    const key = characterKey(character.id);
    assertKeyLength(key);
    await this.storage.set(key, {
      ...character,
      updatedAt: new Date().toISOString(),
    });
  }

  async deleteCharacter(id: string): Promise<void> {
    const key = characterKey(id);
    assertKeyLength(key);
    await this.storage.delete(key);
  }

  // --- stacks --------------------------------------------------------------

  async listStacks(): Promise<ModelStack[]> {
    return this.listByPrefix(STACK_PREFIX, normalizeModelStack);
  }

  async getStack(id: string): Promise<ModelStack | null> {
    const key = stackKey(id);
    assertKeyLength(key);
    return normalizeModelStack(await this.storage.get(key));
  }

  async saveStack(stack: ModelStack): Promise<void> {
    const key = stackKey(stack.id);
    assertKeyLength(key);
    await this.storage.set(key, { ...stack, updatedAt: new Date().toISOString() });
  }

  async deleteStack(id: string): Promise<void> {
    const key = stackKey(id);
    assertKeyLength(key);
    await this.storage.delete(key);
  }

  // --- sheets --------------------------------------------------------------

  /**
   * Sheets are the resumability backbone: every panel's `workflowId` is
   * persisted here, so a batch interrupted by a closed tab can re-attach on
   * the next load. Save after EVERY panel transition, not just at the end.
   */
  async listSheets(): Promise<SheetJob[]> {
    return this.listByPrefix(SHEET_PREFIX, normalizeSheetJob);
  }

  async getSheet(id: string): Promise<SheetJob | null> {
    const key = sheetKey(id);
    assertKeyLength(key);
    return normalizeSheetJob(await this.storage.get(key));
  }

  async saveSheet(sheet: SheetJob): Promise<void> {
    const key = sheetKey(sheet.id);
    assertKeyLength(key);
    await this.storage.set(key, { ...sheet, updatedAt: new Date().toISOString() });
  }

  async deleteSheet(id: string): Promise<void> {
    const key = sheetKey(id);
    assertKeyLength(key);
    await this.storage.delete(key);
  }

  // --- settings + quota -----------------------------------------------------

  async getSettings(): Promise<SheetSettings> {
    return normalizeSettings(await this.storage.get(SETTINGS_KEY));
  }

  async saveSettings(settings: SheetSettings): Promise<void> {
    await this.storage.set(SETTINGS_KEY, settings);
  }

  /**
   * Render BOTH numbers from the reply — rows are usually the binding
   * ceiling, so a bytes-only "x of y used" readout misleads.
   */
  async getQuota(): Promise<AppStorageQuota> {
    return this.storage.getQuota();
  }

  // --- internals -------------------------------------------------------------

  private async listByPrefix<T>(
    prefix: string,
    normalize: (v: unknown) => T | null,
  ): Promise<T[]> {
    const out: T[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.storage.list({ prefix, cursor, limit: 100 });
      const values = await Promise.all(
        page.keys.map((entry) => this.storage.get(entry.key)),
      );
      for (const value of values) {
        const item = normalize(value);
        if (item !== null) out.push(item);
      }
      cursor = page.nextCursor;
    } while (cursor);
    return out;
  }
}
