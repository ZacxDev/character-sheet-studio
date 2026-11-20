// The app must follow the HOST's route. @civitai/blocks-react 0.85 applies a
// host `ROUTE_CHANGED` to the transport snapshot and does not hand it to a
// handler registered by name, so an app that listened by name stopped
// following Back / Forward (CSS 0.3.0-0.3.1: the host URL moved, the view did
// not). Also pins the share-link landing: the gallery is seeded under the
// shared sheet, acknowledged by the host's own route push.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

import { App } from './App.js';
import { installMockMoneyHost } from './mock-buzz.js';
import { SEED_MAX_SENDS, SEED_RESEND_MS } from './platform/route.js';

function hostRoute(subPath: string) {
  window.dispatchEvent(
    new MessageEvent('message', {
      data: { type: 'ROUTE_CHANGED', payload: { subPath, search: '', hash: '' } },
      origin: window.location.origin,
      source: null,
    }),
  );
}

const current = () =>
  screen.queryAllByRole('button').find((b) => b.getAttribute('aria-current') === 'page')?.textContent;

describe('following the host route', () => {
  let uninstall: (() => void) | undefined;
  afterEach(() => {
    uninstall?.();
    uninstall = undefined;
  });

  it('a host ROUTE_CHANGED (Back / Forward) moves the app view', async () => {
    uninstall = installMockMoneyHost({ consentGranted: true });
    render(<App />);
    await waitFor(() => expect(current()).toBe('Characters'), { timeout: 8000 });

    hostRoute('stacks');
    await waitFor(() => expect(current()).toBe('Stacks'), { timeout: 4000 });

    hostRoute('sheets');
    await waitFor(() => expect(current()).toBe('Sheets'), { timeout: 4000 });
  }, 20000);

  // The landing's NAVIGATEs, recorded as the host receives them.
  function landingHost(navigations: { path?: string; replace: boolean }[]) {
    return installMockMoneyHost({
      consentGranted: true,
      context: {
        slotId: 'app.page',
        entityType: 'none',
        slug: 'character-sheet-studio',
        subPath: 'share/k1',
        search: '',
        hash: '',
        viewerUserId: 1,
        viewerUsername: 'dev-viewer',
      },
      onOutbound: (msg) => {
        if (msg.type === 'NAVIGATE') {
          const p = msg.payload as { path?: string; replace?: boolean };
          navigations.push({ path: p.path, replace: p.replace === true });
        }
      },
    });
  }

  // The seed contract, independent of how fast the host acks: the gallery
  // replace is sent until the host acknowledges it (once, or re-sent every
  // SEED_RESEND_MS while the ack is late), then the landing is pushed exactly
  // once, and nothing is sent after it. The exact number of replaces is the
  // ack's timing, so it is not asserted here; the resend schedule itself is
  // unit-tested on seedTick / seedRouteChanged (shared-sheet-view.test.tsx).
  async function expectLanding(navigations: { path?: string; replace: boolean }[]) {
    const landing = { path: 'share/k1', replace: false };
    await waitFor(() => expect(navigations.at(-1)).toEqual(landing), { timeout: 8000 });
    // The shared-sheet view is what shows (no such record here: "not available").
    expect(await screen.findByTestId('ss-unavailable', {}, { timeout: 8000 })).toBeInTheDocument();
    // Once the landing is acknowledged no resend is still armed: wait out two
    // resend intervals and the log has not grown.
    const settled = navigations.length;
    await new Promise((r) => setTimeout(r, SEED_RESEND_MS * 2 + 100));
    expect(navigations).toHaveLength(settled);
    const replaces = navigations.slice(0, -1);
    expect(replaces.length).toBeGreaterThanOrEqual(1);
    expect(replaces.length).toBeLessThanOrEqual(SEED_MAX_SENDS);
    for (const n of replaces) expect(n).toEqual({ path: 'characters', replace: true });
  }

  it('a shared-link landing seeds the gallery beneath it, then lands on the shared sheet', async () => {
    const navigations: { path?: string; replace: boolean }[] = [];
    uninstall = landingHost(navigations);
    render(<App />);
    await expectLanding(navigations);
  }, 20000);

  it('the landing holds when the host acks slower than the resend interval', async () => {
    // Every ROUTE_CHANGED the mock host sends reaches the app SLOW_ACK_MS late,
    // so at least one resend tick fires before the gallery replace is acked.
    const SLOW_ACK_MS = SEED_RESEND_MS + 300;
    const realDispatch = window.dispatchEvent.bind(window);
    const spy = vi.spyOn(window, 'dispatchEvent').mockImplementation((event: Event) => {
      const type = (event as MessageEvent).data?.type;
      if (event.type === 'message' && type === 'ROUTE_CHANGED') {
        setTimeout(() => realDispatch(event), SLOW_ACK_MS);
        return true;
      }
      return realDispatch(event);
    });
    try {
      const navigations: { path?: string; replace: boolean }[] = [];
      uninstall = landingHost(navigations);
      render(<App />);
      await expectLanding(navigations);
      // The slow ack really did cost a resend: the replace went out more than once.
      expect(navigations.filter((n) => n.replace).length).toBeGreaterThanOrEqual(2);
    } finally {
      spy.mockRestore();
    }
  }, 20000);
});
