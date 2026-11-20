// The app must follow the HOST's route. @civitai/blocks-react 0.85 applies a
// host `ROUTE_CHANGED` to the transport snapshot and does not hand it to a
// handler registered by name, so an app that listened by name stopped
// following Back / Forward (CSS 0.3.0-0.3.1: the host URL moved, the view did
// not). Also pins the share-link landing: the gallery is seeded under the
// shared sheet, acknowledged by the host's own route push.

import { afterEach, describe, expect, it } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

import { App } from './App.js';
import { installMockMoneyHost } from './mock-buzz.js';

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

  it('a shared-link landing seeds the gallery beneath it, then lands on the shared sheet', async () => {
    const navigations: unknown[] = [];
    uninstall = installMockMoneyHost({
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
    render(<App />);

    // The mock host follows each navigate and pushes ROUTE_CHANGED, as the page
    // host does: the replace is acknowledged, then the landing is pushed once.
    await waitFor(
      () =>
        expect(navigations).toEqual([
          { path: 'characters', replace: true },
          { path: 'share/k1', replace: false },
        ]),
      { timeout: 8000 },
    );
    // The shared-sheet view is what shows (no such record here: "not available").
    expect(await screen.findByTestId('ss-unavailable', {}, { timeout: 8000 })).toBeInTheDocument();
  }, 20000);
});
