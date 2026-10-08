import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { Harness } from '@civitai/blocks-react/testing';

import { App } from './App.js';
import { resetHarnessTransport } from './dev-transport.js';

// Deterministic end-to-end smoke test for the app shell: the real <App/>
// renders against the SDK mock host (no network, no Buzz). Covers the full
// tab navigation + each screen's empty state. This is the automated version of
// the dev:harness visual smoke test.

beforeEach(() => resetHarnessTransport());
afterEach(() => resetHarnessTransport());

function renderApp() {
  return render(
    <Harness applyUrlToggles={false} showLog={false}>
      <App />
    </Harness>,
  );
}

describe('App shell smoke test', () => {
  it('renders the side nav + four tabs and each tab shows its empty state', async () => {
    renderApp();
    const user = userEvent.setup();

    // Shell renders once BLOCK_INIT lands from the mock host. There is no
    // app title header anymore — the side nav IS the shell's identity.
    await waitFor(() =>
      expect(screen.getByRole('tab', { name: 'Characters' })).toBeInTheDocument(),
    );

    // The custom "Indigo Lineup" theme scope rides on the app root.
    expect(document.querySelector('.css-root')).not.toBeNull();
    for (const tab of ['Characters', 'Stacks', 'Sheet Builder', 'Sheets']) {
      expect(screen.getByRole('tab', { name: tab })).toBeInTheDocument();
    }

    // Characters tab is the default: empty-state copy.
    await waitFor(() =>
      expect(screen.getByText(/No characters yet/)).toBeInTheDocument(),
    );

    // Stacks tab.
    await user.click(screen.getByRole('tab', { name: 'Stacks' }));
    await waitFor(() => expect(screen.getByText(/No stacks yet/)).toBeInTheDocument());

    // Sheet Builder tab: with no characters it gates on character creation —
    // and its CTA switches straight to the Characters tab.
    await user.click(screen.getByRole('tab', { name: 'Sheet Builder' }));
    await waitFor(() =>
      expect(screen.getByText(/built from a character/)).toBeInTheDocument(),
    );
    await user.click(screen.getByTestId('builder-create-character'));
    // Return trip: the create editor opens straight away (not a bare list),
    // and saving lands back in the Builder with the character selected.
    const nameInput = await screen.findByTestId('char-name');
    await user.type(nameInput, 'Testling');
    await user.click(screen.getByTestId('char-save'));
    // Back in the Builder — which now funnels to the next missing piece.
    await screen.findByTestId('builder-create-stack');

    // Sheets tab.
    await user.click(screen.getByRole('tab', { name: 'Sheets' }));
    await waitFor(() => expect(screen.getByText(/No sheets yet/)).toBeInTheDocument());
  });
});
