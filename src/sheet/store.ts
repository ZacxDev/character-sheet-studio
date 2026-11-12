/**
 * Character Sheet Studio — durable store on top of the document store's
 * private `kv` collection (`./kv-store.ts`).
 *
 * `SheetStore` wraps the KV façade with the app's key scheme, normalizers
 * (malformed rows are dropped, never thrown), cursor-paginated listing, and
 * error classification. Storage failures are surfaced as `StoreErrorKind` —
 * the app renders its own copy, never the server's prose.
 *
 * Scoping facts from the platform, encoded here as comments where they bite:
 * - A private collection is one key space per (app, viewer): every placement
 *   of this app shares the viewer's ONE library and ONE budget
 *   (`info().limits.viewerBytes` / `viewerDocs`).
 * - An anonymous viewer is REFUSED (`sign_in_required`) on every private read
 *   and write. The store does not gate on that — the UI layer does (see
 *   `useSheetLibrary`), because only it knows the viewer's state.
 */

import { StorageError } from '@civitai/sdk';

import type { KvQuota, KvStorage } from './kv-store.js';
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
 * Map a document-store refusal onto the app's closed set. Branches on the
 * envelope's `code` only (never on prose). Anything unrecognized — including
 * `sign_in_required` for an anonymous viewer — lands in 'unknown', so the UI
 * never assumes "transient, retry".
 *
 * `row-limit` is no longer produced: the store answers both per-viewer
 * ceilings (bytes and documents) with one `quota_exceeded`. The kind stays in
 * the union because the UI copy table is keyed on it.
 */
export function classifyStoreError(error: unknown): StoreErrorKind {
  if (error instanceof StorageError) {
    switch (error.code) {
      case 'too_large':
        return 'value-too-large';
      case 'quota_exceeded':
        return 'quota-exceeded';
      // The manifest does not declare the collection/scope, the approved
      // version does not have it yet, or the viewer revoked consent — a retry
      // cannot fix any of these.
      case 'insufficient_scope':
      case 'consent_required':
      case 'collection_not_declared':
      case 'not_eligible':
        return 'not-permitted';
      case 'rate_limited':
      case 'service_unavailable':
      case 'consent_unavailable':
      case 'internal_error':
        return 'request-failed';
      default:
        return 'unknown';
    }
  }
  // `fetch` itself rejected (offline, connection dropped): no answer at all.
  if (error instanceof TypeError) return 'request-failed';
  return 'unknown';
}

/**
 * Document-store key cap (`^[A-Za-z0-9._:-]{1,128}$`). Our keys are
 * constructed (a fixed prefix + a uuid), so this is a dev guard, not input
 * validation.
 */
const MAX_KEY_LENGTH = 128;

function assertKeyLength(key: string): void {
  if (key.length > MAX_KEY_LENGTH) {
    throw new Error(
      `character-sheet-studio: storage key exceeds ${MAX_KEY_LENGTH} chars`,
    );
  }
}

export class SheetStore {
  constructor(private readonly storage: KvStorage) {}

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
   * Render BOTH numbers from the reply — documents are usually the binding
   * ceiling, so a bytes-only "x of y used" readout misleads.
   */
  async getQuota(): Promise<KvQuota> {
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
      // A document-store page carries whole documents, so there is no per-key
      // `get` fan-out (the legacy list returned keys only). That also keeps a
      // large library inside the store's per-viewer READ rate limit.
      const page = await this.storage.list({ prefix, cursor, limit: 100 });
      for (const entry of page.entries) {
        const item = normalize(entry.value);
        if (item !== null) out.push(item);
      }
      cursor = page.nextCursor;
    } while (cursor);
    return out;
  }
}
