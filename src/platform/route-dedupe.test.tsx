// useAppRoute reacts to the host's route only when the snapshot's sub-path
// MOVES. The transport also emits for a token refresh or a theme change with
// the route unchanged; acting on those would put a stale host route back over
// an app navigation the host has not (or never) acknowledged. A fake transport
// makes the host and the app disagree, which the mock host never does.

import { describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';

const fake = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  let snapshot = { ready: true, context: { slotId: 'app.page', subPath: 'characters' } };
  return {
    navigations: [] as unknown[][],
    transport: {
      getSnapshot: () => snapshot,
      subscribe: (l: () => void) => {
        listeners.add(l);
        return () => listeners.delete(l);
      },
    },
    /** A transport emit; `subPath` given = the host moved, absent = some other change. */
    emit(subPath?: string) {
      snapshot = {
        ...snapshot,
        context: { ...snapshot.context, ...(subPath !== undefined ? { subPath } : {}) },
      };
      for (const l of [...listeners]) l();
    },
  };
});

vi.mock('@civitai/blocks-react', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@civitai/blocks-react')>();
  return {
    ...mod,
    getTransport: () => fake.transport,
    useCivitaiNavigate: () => ({ navigate: (...a: unknown[]) => fake.navigations.push(a) }),
  };
});

import { useAppRoute } from './route.js';

describe('useAppRoute follows host moves, not every transport emit', () => {
  it('a non-route emit after an unacknowledged app navigation keeps the app view', () => {
    const { result } = renderHook(() => useAppRoute());
    expect(result.current.subPath).toBe('characters');

    // The app navigates; this host never acknowledges it.
    act(() => result.current.navigateTo('stacks'));
    expect(result.current.subPath).toBe('stacks');
    expect(fake.navigations).toEqual([['stacks']]);

    // A token refresh: the snapshot emits, its route still 'characters'.
    act(() => fake.emit());
    expect(result.current.subPath).toBe('stacks');

    // A real host move (Back) does move the view.
    act(() => fake.emit('sheets'));
    expect(result.current.subPath).toBe('sheets');
  });
});
