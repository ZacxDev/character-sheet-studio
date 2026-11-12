import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { Harness } from '@civitai/blocks-react/testing';

import { App } from './App.js';
import { resetHarnessTransport } from './dev-transport.js';

// Deterministic end-to-end smoke test for the app shell: the real <App/>
// renders against the SDK mock host (no network, no Buzz). Covers page
// navigation between the main views + each screen's empty state. This is the
// automated version of the dev:harness visual smoke test. The mock host has
// no route control, so page changes here exercise the shell's route state;
// host history/Back behavior is only provable against the real host.

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
  it('renders the side nav + four pages and each page shows its empty state', async () => {
    renderApp();
    const user = userEvent.setup();

    // Shell renders once BLOCK_INIT lands from the mock host. There is no
    // app title header anymore — the side nav IS the shell's identity.
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Characters' }),
      ).toBeInTheDocument(),
    );

    // The custom "Rose Noir" theme scope rides on the app root.
    expect(document.querySelector('.css-root')).not.toBeNull();
    for (const page of ['Characters', 'Stacks', 'Sheet Builder', 'Sheets']) {
      expect(
        screen.getByRole('button', { name: page }),
      ).toBeInTheDocument();
    }

    // Characters is the default page: with no characters, the create form
    // itself is the empty state (name pre-rolled).
    const emptyName = await screen.findByTestId('char-name');
    expect((emptyName as HTMLInputElement).value).not.toBe('');

    // Stacks page.
    await user.click(screen.getByRole('button', { name: 'Stacks' }));
    await waitFor(() => expect(screen.getByText(/No stacks yet/)).toBeInTheDocument());

    // Sheet Builder page: with no characters it gates on character creation —
    // and its CTA switches straight to the character create page.
    await user.click(
      screen.getByRole('button', { name: 'Sheet Builder' }),
    );
    await waitFor(() =>
      expect(screen.getByText(/built from a character/)).toBeInTheDocument(),
    );
    await user.click(screen.getByTestId('builder-create-character'));
    // Return trip: the stepped create form opens straight away (not a bare
    // list), and saving lands back in the Builder with the character selected.
    const nameInput = await screen.findByTestId('char-name');
    await user.type(nameInput, 'Testling');
    for (let i = 0; i < 5; i++) {
      await user.click(screen.getByTestId('char-step-next'));
    }
    await user.click(screen.getByTestId('char-save'));
    // Back in the Builder — zero stacks means the inline stack create is
    // open, ready for the first stack.
    await screen.findByTestId('stack-name');

    // Sheets page.
    await user.click(screen.getByRole('button', { name: 'Sheets' }));
    await waitFor(() => expect(screen.getByText(/No sheets yet/)).toBeInTheDocument());
  });
});
