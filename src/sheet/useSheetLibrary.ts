/**
 * Character Sheet Studio — React binding for the durable store.
 *
 * Hydrates characters / stacks / sheets / settings once via `SheetStore`,
 * then keeps in-memory state as the source of truth with best-effort
 * persistence (the Style Explorer pattern): savers update state immediately
 * and return a `StoreErrorKind` (`null` on success) so the UI can surface
 * quota failures honestly instead of pretending the save landed.
 *
 * The store is the document store's private `kv` collection, which REFUSES an
 * anonymous viewer (`sign_in_required`). So nothing is read until the host has
 * said who the viewer is, and an anonymous viewer is never sent to the store
 * at all: their library lives in memory for the session, and a save answers
 * 'unknown' — the same kind the legacy store's anonymous-write rejection
 * classified to — without a request.
 */

import { useBlockContext } from '@civitai/blocks-react';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { useDocumentStorage } from './doc-storage.js';
import { createKvStorage, type KvQuota } from './kv-store.js';
import { SheetStore, classifyStoreError, type StoreErrorKind } from './store.js';
import {
  DEFAULT_SETTINGS,
  removeById,
  upsertById,
  type Character,
  type ModelStack,
  type SheetJob,
  type SheetSettings,
} from './types.js';

export interface SheetLibrary {
  /** False until the first hydration attempt has settled. */
  ready: boolean;
  characters: Character[];
  stacks: ModelStack[];
  sheets: SheetJob[];
  settings: SheetSettings;
  quota: KvQuota | null;
  saveCharacter: (c: Character) => Promise<StoreErrorKind | null>;
  deleteCharacter: (id: string) => Promise<StoreErrorKind | null>;
  saveStack: (s: ModelStack) => Promise<StoreErrorKind | null>;
  deleteStack: (id: string) => Promise<StoreErrorKind | null>;
  /** Save after EVERY panel transition — this is what makes batches resumable. */
  saveSheet: (s: SheetJob) => Promise<StoreErrorKind | null>;
  deleteSheet: (id: string) => Promise<StoreErrorKind | null>;
  saveSettings: (s: SheetSettings) => Promise<StoreErrorKind | null>;
  refreshQuota: () => Promise<void>;
}

export function useSheetLibrary(): SheetLibrary {
  const { ready: hostReady, viewer } = useBlockContext();
  const signedIn = hostReady && viewer !== null;
  const docs = useDocumentStorage();
  // `null` while the viewer is anonymous (or not known yet), or while the host
  // origin / token have not arrived: nothing can reach the store then.
  const store = useMemo(
    () => (signedIn && docs ? new SheetStore(createKvStorage(docs)) : null),
    [signedIn, docs],
  );

  const [ready, setReady] = useState(false);
  const [characters, setCharacters] = useState<Character[]>([]);
  const [stacks, setStacks] = useState<ModelStack[]>([]);
  const [sheets, setSheets] = useState<SheetJob[]>([]);
  const [settings, setSettings] = useState<SheetSettings>(DEFAULT_SETTINGS);
  const [quota, setQuota] = useState<KvQuota | null>(null);

  useEffect(() => {
    if (!hostReady) return;
    if (store === null) {
      // Anonymous: in-memory only. (Signed in but no origin/token yet: wait —
      // the effect re-runs when the store appears.)
      if (!signedIn) setReady(true);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const [chars, stk, sht, set, q] = await Promise.all([
          store.listCharacters(),
          store.listStacks(),
          store.listSheets(),
          store.getSettings(),
          store.getQuota().catch(() => null),
        ]);
        if (cancelled) return;
        setCharacters(chars);
        setStacks(stk);
        setSheets(sht);
        setSettings(set);
        setQuota(q);
      } catch {
        // Storage unavailable — in-memory state is the source of truth.
      } finally {
        if (!cancelled) setReady(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [store, hostReady, signedIn]);

  const saveCharacter = useCallback(
    async (c: Character): Promise<StoreErrorKind | null> => {
      setCharacters((cur) => upsertById(cur, c));
      if (store === null) return 'unknown';
      try {
        await store.saveCharacter(c);
        return null;
      } catch (err) {
        return classifyStoreError(err);
      }
    },
    [store],
  );

  const deleteCharacter = useCallback(
    async (id: string): Promise<StoreErrorKind | null> => {
      setCharacters((cur) => removeById(cur, id));
      if (store === null) return 'unknown';
      try {
        await store.deleteCharacter(id);
        return null;
      } catch (err) {
        return classifyStoreError(err);
      }
    },
    [store],
  );

  const saveStack = useCallback(
    async (s: ModelStack): Promise<StoreErrorKind | null> => {
      setStacks((cur) => upsertById(cur, s));
      if (store === null) return 'unknown';
      try {
        await store.saveStack(s);
        return null;
      } catch (err) {
        return classifyStoreError(err);
      }
    },
    [store],
  );

  const deleteStack = useCallback(
    async (id: string): Promise<StoreErrorKind | null> => {
      setStacks((cur) => removeById(cur, id));
      if (store === null) return 'unknown';
      try {
        await store.deleteStack(id);
        return null;
      } catch (err) {
        return classifyStoreError(err);
      }
    },
    [store],
  );

  const saveSheet = useCallback(
    async (s: SheetJob): Promise<StoreErrorKind | null> => {
      setSheets((cur) => upsertById(cur, s));
      if (store === null) return 'unknown';
      try {
        await store.saveSheet(s);
        return null;
      } catch (err) {
        return classifyStoreError(err);
      }
    },
    [store],
  );

  const deleteSheet = useCallback(
    async (id: string): Promise<StoreErrorKind | null> => {
      setSheets((cur) => removeById(cur, id));
      if (store === null) return 'unknown';
      try {
        await store.deleteSheet(id);
        return null;
      } catch (err) {
        return classifyStoreError(err);
      }
    },
    [store],
  );

  const saveSettings = useCallback(
    async (s: SheetSettings): Promise<StoreErrorKind | null> => {
      setSettings(s);
      if (store === null) return 'unknown';
      try {
        await store.saveSettings(s);
        return null;
      } catch (err) {
        return classifyStoreError(err);
      }
    },
    [store],
  );

  const refreshQuota = useCallback(async (): Promise<void> => {
    if (store === null) return;
    try {
      setQuota(await store.getQuota());
    } catch {
      // Quota is diagnostic — never break the UI over it.
    }
  }, [store]);

  return {
    ready,
    characters,
    stacks,
    sheets,
    settings,
    quota,
    saveCharacter,
    deleteCharacter,
    saveStack,
    deleteStack,
    saveSheet,
    deleteSheet,
    saveSettings,
    refreshQuota,
  };
}
