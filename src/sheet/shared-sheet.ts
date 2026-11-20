// A sheet shared by link (HQ app_blocks_sdk_j1gc): "Share sheet" publishes the
// sheet's finished panels through the host's publish confirm, then writes ONE
// small record to the SHARED collection `shared_sheets`: the character name, the
// sheet name, and each panel's label and published image ID. The link
// `share/<key>` opens that record for any viewer.
//
// 🔴 NO URL EVER GOES INTO THE RECORD. A shared document is readable by every
// viewer of the app, signed out included, and on either site, so a stored url
// would hand one viewer's image to another viewer past their content level. The
// reader resolves each image ID through `useGatedImages()`, which clamps it to
// the READER's browsing level on the server. The record carries IDs only, and
// three things enforce that:
//   - `buildSharedSheetDoc` has no input that could carry a url;
//   - the manifest's `shared_sheets.schema` (additionalProperties: false, an
//     integer `imageId`) makes the server refuse any other shape;
//   - `normalizeSharedSheetDoc` on the read side keeps only `label` and an
//     integer `imageId`, so a record some other client wrote with extra fields
//     never puts them on screen.

import type { DocumentStorageSource } from './doc-storage.js';

export const SHARED_SHEETS_COLLECTION = 'shared_sheets';

/** The consent-gated scope a shared collection that viewers write needs. */
export const STORAGE_PUBLISH_SCOPE = 'apps:storage:publish';

/** Limits, mirrored in the manifest's `shared_sheets.schema`. */
export const SHARED_NAME_MAX = 120;
export const SHARED_LABEL_MAX = 80;
export const SHARED_PANELS_MAX = 24;

export interface SharedSheetPanel {
  label: string;
  /** A published, scanned Civitai image ID. Never a url. */
  imageId: number;
}

export interface SharedSheetDoc {
  v: 1;
  characterName: string;
  sheetName: string;
  panels: SharedSheetPanel[];
}

function clip(s: string, max: number): string {
  const t = s.trim();
  return t.length > max ? t.slice(0, max) : t;
}

function isImageId(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
}

/** The record to write. Panels without a valid image ID are left out. */
export function buildSharedSheetDoc(input: {
  characterName: string;
  sheetName: string;
  panels: ReadonlyArray<{ label: string; imageId: number | undefined }>;
}): SharedSheetDoc {
  return {
    v: 1,
    characterName: clip(input.characterName, SHARED_NAME_MAX),
    sheetName: clip(input.sheetName, SHARED_NAME_MAX),
    panels: input.panels
      .filter((p): p is { label: string; imageId: number } => isImageId(p.imageId))
      .slice(0, SHARED_PANELS_MAX)
      .map((p) => ({ label: clip(p.label, SHARED_LABEL_MAX), imageId: p.imageId })),
  };
}

/** Read side: only the declared fields survive; anything else is dropped. */
export function normalizeSharedSheetDoc(v: unknown): SharedSheetDoc | null {
  if (!v || typeof v !== 'object') return null;
  const r = v as Record<string, unknown>;
  if (r.v !== 1 || typeof r.characterName !== 'string' || typeof r.sheetName !== 'string') return null;
  if (!Array.isArray(r.panels)) return null;
  const panels: SharedSheetPanel[] = [];
  for (const p of r.panels.slice(0, SHARED_PANELS_MAX)) {
    if (!p || typeof p !== 'object') continue;
    const { label, imageId } = p as Record<string, unknown>;
    if (typeof label !== 'string' || !isImageId(imageId)) continue;
    panels.push({ label: clip(label, SHARED_LABEL_MAX), imageId });
  }
  return {
    v: 1,
    characterName: clip(r.characterName, SHARED_NAME_MAX),
    sheetName: clip(r.sheetName, SHARED_NAME_MAX),
    panels,
  };
}

/**
 * Write the record: replace it at `key` when the sheet was shared before (only
 * its author can, `write: "own"`), else create it under a key the server picks.
 * Resolves with the key.
 */
export async function saveSharedSheet(
  source: DocumentStorageSource,
  doc: SharedSheetDoc,
  key?: string,
): Promise<string> {
  const storage = await source();
  const collection = storage.collection<SharedSheetDoc>(SHARED_SHEETS_COLLECTION);
  const written = key ? await collection.put(key, doc) : await collection.create(doc);
  return written.key;
}

/**
 * Delete a shared record, so its link stops opening the sheet for anyone. Only
 * its author can (`write: "own"`). Idempotent: an already-missing record is not
 * an error. The published images it pointed at stay on Civitai; nothing here
 * can unpublish an image.
 */
export async function deleteSharedSheet(source: DocumentStorageSource, key: string): Promise<void> {
  const storage = await source();
  await storage.collection<SharedSheetDoc>(SHARED_SHEETS_COLLECTION).delete(key);
}

/** Read a shared record; null when it is missing or not a sheet record. */
export async function loadSharedSheet(
  source: DocumentStorageSource,
  key: string,
): Promise<SharedSheetDoc | null> {
  const storage = await source();
  const found = await storage.collection<SharedSheetDoc>(SHARED_SHEETS_COLLECTION).get(key);
  return found ? normalizeSharedSheetDoc(found.data) : null;
}
