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
  | { name: 'sheet'; sheetId: string }
  | { name: 'shared-sheet'; shareKey: string };

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

  if (root === 'share') {
    const shareKey = idSegment(second);
    if (shareKey && third === undefined) return { name: 'shared-sheet', shareKey };
    return { name: 'characters' };
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

/** A sheet someone shared by link: `share/<key>` (HQ app_blocks_sdk_j1gc). */
export function sharedSheetRoute(shareKey: string): string {
  return `share/${encodeURIComponent(shareKey)}`;
}

/** The app's gallery, where Back from a shared sheet lands. */
export const GALLERY_ROUTE = 'characters';

/**
 * The history entry to put UNDER the landing view, or null. A shared link opened
 * in a new tab starts the host's history at the shared sheet, so Back would
 * leave the app. For that landing only, the app replaces the entry with the
 * gallery and pushes the shared sheet again, so Back returns to the gallery.
 */
export function landingHistorySeed(initialSubPath: string): string | null {
  return parseAppRoute(initialSubPath).name === 'shared-sheet' ? GALLERY_ROUTE : null;
}

/**
 * The seed is two NAVIGATEs, and the page host DROPS a NAVIGATE that arrives
 * before its handshake has settled, with no reply. The app's first chance to
 * send is earlier than that, so the seed is driven by the host's own
 * ROUTE_CHANGED acknowledgements rather than fired once:
 *   - `replacing`: send `replace(seed)`, re-sent on a timer until the host
 *     answers ROUTE_CHANGED(seed), at most {@link SEED_MAX_SENDS} times;
 *   - then `pushing`: send `push(landing)` once; its ROUTE_CHANGED ends it.
 * While seeding, ROUTE_CHANGED(seed) is the host's ack and is not rendered,
 * so the gallery never flashes. Out of sends, it gives up and Back leaves the
 * app, as it did before. Pure, so the sequence is unit-tested.
 */
export type SeedState =
  | { phase: 'replacing'; seed: string; landing: string; sends: number }
  | { phase: 'pushing'; seed: string; landing: string }
  | { phase: 'done' };

export const SEED_MAX_SENDS = 8;
export const SEED_RESEND_MS = 600;

export type SeedEffect =
  | { kind: 'replace'; path: string }
  | { kind: 'push'; path: string }
  | { kind: 'none' };

/** A resend tick while replacing. */
export function seedTick(state: SeedState): { state: SeedState; effect: SeedEffect } {
  if (state.phase !== 'replacing') return { state, effect: { kind: 'none' } };
  if (state.sends >= SEED_MAX_SENDS) return { state: { phase: 'done' }, effect: { kind: 'none' } };
  return {
    state: { ...state, sends: state.sends + 1 },
    effect: { kind: 'replace', path: state.seed },
  };
}

/**
 * A ROUTE_CHANGED from the host while seeding. `render` is false when the push
 * is the seed's own acknowledgement and must not move the app's view.
 */
export function seedRouteChanged(
  state: SeedState,
  next: string,
): { state: SeedState; effect: SeedEffect; render: boolean } {
  if (state.phase === 'replacing' && next === state.seed) {
    return {
      state: { phase: 'pushing', seed: state.seed, landing: state.landing },
      effect: { kind: 'push', path: state.landing },
      render: false,
    };
  }
  if (state.phase === 'pushing' && next === state.landing) {
    return { state: { phase: 'done' }, effect: { kind: 'none' }, render: true };
  }
  return { state, effect: { kind: 'none' }, render: true };
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
  const seedRef = useRef<SeedState | null>(null);
  // An app navigation ends any seed in flight: a late replace would otherwise
  // overwrite the entry the viewer just moved to.
  const cancelSeedRef = useRef<() => void>(() => undefined);
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;

  const applyRoute = useCallback((next: string) => {
    if (routeRef.current === next) return;
    routeRef.current = next;
    setSubPath(next);
  }, []);

  useEffect(() => {
    const transport = getTransport();
    let resend: ReturnType<typeof setInterval> | null = null;
    const stopResend = () => {
      if (resend !== null) clearInterval(resend);
      resend = null;
    };
    cancelSeedRef.current = () => {
      if (seedRef.current) seedRef.current = { phase: 'done' };
      stopResend();
    };
    const runEffect = (effect: SeedEffect) => {
      if (effect.kind === 'replace') navigateRef.current(effect.path, { replace: true });
      else if (effect.kind === 'push') navigateRef.current(effect.path);
    };
    const tick = () => {
      const cur = seedRef.current;
      if (!cur) return;
      const { state, effect } = seedTick(cur);
      seedRef.current = state;
      if (state.phase !== 'replacing') stopResend();
      runEffect(effect);
    };

    const syncInitRoute = () => {
      // The snapshot's context forever carries the INIT sub-path. It may seed
      // the route only before any explicit navigation or host push has set it;
      // after that it would resurrect the landing page over the current one.
      if (routeRef.current !== null) return;
      const initial = subPathFromSnapshot();
      if (initial === null) return;
      applyRoute(initial);
      const seed = seedRef.current ? null : landingHistorySeed(initial);
      if (seed !== null) {
        seedRef.current = { phase: 'replacing', seed, landing: initial, sends: 0 };
        tick();
        resend = setInterval(tick, SEED_RESEND_MS);
      }
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
        if (next === null) return;
        const cur = seedRef.current;
        if (cur && cur.phase !== 'done') {
          const step = seedRouteChanged(cur, next);
          seedRef.current = step.state;
          if (step.state.phase !== 'replacing') stopResend();
          runEffect(step.effect);
          if (!step.render) return;
        }
        applyRoute(next);
      },
    );
    syncInitRoute();

    return () => {
      stopResend();
      offSnapshot();
      offRoute();
    };
  }, [applyRoute]);

  const navigateTo = useCallback(
    (path: string) => {
      const next = normalizeRoutePath(path);
      cancelSeedRef.current();
      applyRoute(next);
      navigate(next);
    },
    [applyRoute, navigate],
  );

  return { subPath: subPath ?? '', navigateTo };
}
