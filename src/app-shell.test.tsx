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
  it('renders the title + four tabs and each tab shows its empty state', async () => {
    renderApp();
    const user = userEvent.setup();

    // Shell renders once BLOCK_INIT lands from the mock host.
    await waitFor(() =>
      expect(screen.getByText('Character Sheet Studio')).toBeInTheDocument(),
    );
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

    // Sheet Builder tab: with no characters it gates on character creation.
    await user.click(screen.getByRole('tab', { name: 'Sheet Builder' }));
    await waitFor(() =>
      expect(screen.getByText(/Create a character first/)).toBeInTheDocument(),
    );

    // Sheets tab.
    await user.click(screen.getByRole('tab', { name: 'Sheets' }));
    await waitFor(() => expect(screen.getByText(/No sheets yet/)).toBeInTheDocument());
  });
});
