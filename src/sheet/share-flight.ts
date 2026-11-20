// Which sheets have a share-link operation running: Share / Update shared
// sheet, Stop sharing, deleting the sheet, or deleting its character (which
// stops sharing it). Those operations exclude each other PER SHEET, across the
// whole app rather than one screen: a share keeps running after the viewer
// leaves the Sheet View (its writes go through the app-wide library), so a
// guard that lived in the screen would reset on Back and let a delete start
// under it, and the late share would then save a live link for a deleted
// sheet or character. Module state, like the app's other process-wide
// singletons (the transport, the document store); one app instance per frame.

import { useSyncExternalStore } from 'react';

const running = new Set<string>();
let snapshot: ReadonlySet<string> = new Set();
const listeners = new Set<() => void>();

function changed(): void {
  snapshot = new Set(running);
  for (const l of listeners) l();
}

/**
 * Claim every listed sheet for one operation. All or nothing: if any of them is
 * already claimed, nothing is claimed and this returns false.
 */
export function claimSheets(ids: readonly string[]): boolean {
  if (ids.some((id) => running.has(id))) return false;
  for (const id of ids) running.add(id);
  changed();
  return true;
}

/** Release sheets claimed by {@link claimSheets}. */
export function releaseSheets(ids: readonly string[]): void {
  for (const id of ids) running.delete(id);
  changed();
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** The sheets with an operation running, re-rendering when it changes. */
export function useBusySheets(): ReadonlySet<string> {
  return useSyncExternalStore(subscribe, () => snapshot);
}
