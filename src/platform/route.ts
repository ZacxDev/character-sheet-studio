// Host-route plumbing for Character Sheet Studio's pages.
//
// The page host owns the browser history: it seeds the route in BLOCK_INIT
// (`PageSlotContext.subPath`), pushes `ROUTE_CHANGED` whenever that route moves
// (including the viewer's Android/browser Back), and performs the shallow push
// when the app asks to navigate. The installed SDK exposes the outbound
// navigation hook but not a route hook, so this module reads the init snapshot
// and subscribes to the push through the same transport the SDK hooks use.
//
// The route returned here is also updated optimistically by `navigateTo`: the
// mock host deliberately has no route control, so waiting for its echo would
// leave the local harness (and tests) unable to move between pages. A later
// host push always wins, because it is the history's actual position.

import { useCallback, useEffect, useRef, useState } from 'react';

import { getTransport, useCivitaiNavigate } from '@civitai/blocks-react';
import type { ParentToBlockMessageType } from '@civitai/app-sdk/blocks';

export const ROUTE_CHANGED = 'ROUTE_CHANGED';

export type AppRoute =
  | { name: 'characters' }
  | { name: 'character'; characterId: string }
  | { name: 'character-create' }
  | { name: 'character-edit'; characterId: string }
  | { name: 'stacks' }
  | { name: 'stack-create' }
  | { name: 'stack-edit'; stackId: string }
  | { name: 'builder'; characterId?: string }
  | { name: 'sheets'; characterId?: string }
  | { name: 'sheet'; sheetId: string };

/** Normalize a host sub-path or an app navigation target to no edge slashes. */
export function normalizeRoutePath(path: string): string {
  return path.replace(/^\/+|\/+$/g, '');
}

function routeSegments(subPath: string): string[] {
  const normalized = normalizeRoutePath(subPath);
  return normalized === '' ? [] : normalized.split('/').filter(Boolean);
}

function idSegment(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const decoded = decodeURIComponent(value);
    return decoded.trim() === '' ? null : decoded;
  } catch {
    return null;
  }
}

/** Parse the host's sub-path into the page this app should render. */
export function parseAppRoute(subPath: string): AppRoute {
  const [root, second, third] = routeSegments(subPath);

  if (root === undefined || root === 'characters') {
    if (second === 'new' && third === undefined) return { name: 'character-create' };
    const characterId = idSegment(second);
    if (characterId && third === 'edit') return { name: 'character-edit', characterId };
    if (characterId && third === undefined) return { name: 'character', characterId };
    return { name: 'characters' };
  }

  if (root === 'stacks') {
    if (second === 'new' && third === undefined) return { name: 'stack-create' };
    const stackId = idSegment(second);
    if (stackId && third === 'edit') return { name: 'stack-edit', stackId };
    return { name: 'stacks' };
  }

  if (root === 'builder') {
    const characterId = idSegment(second);
    return characterId && third === undefined
      ? { name: 'builder', characterId }
      : { name: 'builder' };
  }

  if (root === 'sheets') {
    if (second === undefined) return { name: 'sheets' };
    if (second === 'character') {
      const characterId = idSegment(third);
      return characterId ? { name: 'sheets', characterId } : { name: 'sheets' };
    }
    const sheetId = idSegment(second);
    if (sheetId && third === undefined) return { name: 'sheet', sheetId };
    return { name: 'sheets' };
  }

  // Unknown routes land on the cast list rather than a blank page. This does
  // not rewrite the host history; the next explicit navigation replaces it.
  return { name: 'characters' };
}

export function characterCreateRoute(): string {
  return 'characters/new';
}

export function characterRoute(characterId: string): string {
  return `characters/${encodeURIComponent(characterId)}`;
}

export function characterEditRoute(characterId: string): string {
  return `characters/${encodeURIComponent(characterId)}/edit`;
}

export function stackCreateRoute(): string {
  return 'stacks/new';
}

export function stackEditRoute(stackId: string): string {
  return `stacks/${encodeURIComponent(stackId)}/edit`;
}

export function builderRoute(characterId?: string): string {
  return characterId ? `builder/${encodeURIComponent(characterId)}` : 'builder';
}

export function sheetsRoute(characterId?: string): string {
  return characterId
    ? `sheets/character/${encodeURIComponent(characterId)}`
    : 'sheets';
}

export function sheetRoute(sheetId: string): string {
  return `sheets/${encodeURIComponent(sheetId)}`;
}

function subPathFromSnapshot(): string | null {
  const snapshot = getTransport().getSnapshot();
  if (!snapshot.ready) return null;
  const context = snapshot.context as { subPath?: unknown };
  return typeof context.subPath === 'string'
    ? normalizeRoutePath(context.subPath)
    : null;
}

function subPathFromRouteChanged(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const subPath = (payload as { subPath?: unknown }).subPath;
  return typeof subPath === 'string' ? normalizeRoutePath(subPath) : null;
}

export interface AppRouteController {
  /** Current sub-path below the app root; `''` is the app index. */
  subPath: string;
  /** Ask the host to move to a page and render it immediately. */
  navigateTo: (path: string) => void;
}

export function useAppRoute(): AppRouteController {
  const { navigate } = useCivitaiNavigate();
  const [subPath, setSubPath] = useState<string | null>(null);
  const routeRef = useRef<string | null>(null);

  const applyRoute = useCallback((next: string) => {
    if (routeRef.current === next) return;
    routeRef.current = next;
    setSubPath(next);
  }, []);

  useEffect(() => {
    const transport = getTransport();

    const syncInitRoute = () => {
      // The snapshot's context forever carries the INIT sub-path. It may seed
      // the route only before any explicit navigation or host push has set it;
      // after that it would resurrect the landing page over the current one.
      if (routeRef.current !== null) return;
      const initial = subPathFromSnapshot();
      if (initial !== null) applyRoute(initial);
    };

    const offSnapshot = transport.subscribe(syncInitRoute);
    // ROUTE_CHANGED is newer than the installed SDK's message union, so the
    // transport's typed surface cannot name it. The runtime deliberately
    // passes unrecognized pushes to handlers registered by name; the payload
    // is validated here instead.
    const offRoute = transport.onMessage(
      ROUTE_CHANGED as unknown as ParentToBlockMessageType,
      (payload) => {
        const next = subPathFromRouteChanged(payload);
        if (next !== null) applyRoute(next);
      },
    );
    syncInitRoute();

    return () => {
      offSnapshot();
      offRoute();
    };
  }, [applyRoute]);

  const navigateTo = useCallback(
    (path: string) => {
      const next = normalizeRoutePath(path);
      applyRoute(next);
      navigate(next);
    },
    [applyRoute, navigate],
  );

  return { subPath: subPath ?? '', navigateTo };
}
