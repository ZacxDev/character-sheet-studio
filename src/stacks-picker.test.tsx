import { afterEach, describe, expect, it } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { App } from './App.js';
import { installMockMoneyHost } from './mock-buzz.js';

// Two first-run UX contracts, driven through the real SDK transport against
// the mock host (no hook mocking):
//
// 1. The checkpoint picker is UNCONSTRAINED — the block opens the generic
//    resource picker with resourceType 'Checkpoint' and no baseModelGroup,
//    so the viewer sees ALL checkpoints (the checkpoint-only hook requires
//    an ecosystem hint, which filters the list).
// 2. The Sheet Builder funnels a stackless first run into stack creation:
//    the "Create a stack" CTA switches to the Stacks tab instead of
//    dead-ending.

describe('stack picker + builder funnel', () => {
  let uninstall: (() => void) | undefined;
  afterEach(() => {
    uninstall?.();
    uninstall = undefined;
  });

  it('checkpoint Change opens an unconstrained resource pick (no baseModelGroup)', async () => {
    const outbound: { type?: string; payload?: unknown }[] = [];
    uninstall = installMockMoneyHost({
      cannedPicks: { Checkpoint: null }, // dismissed — we only assert the request
      onOutbound: (msg) => {
        outbound.push(msg);
      },
    });
    const user = userEvent.setup();
    render(<App />);
    await screen.findByText('Character Sheet Studio');

    await user.click(screen.getByRole('tab', { name: 'Stacks' }));
    await user.click(screen.getByRole('button', { name: 'New stack' }));
    await user.click(screen.getByTestId('stack-checkpoint-change'));

    await waitFor(() =>
      expect(outbound.some((m) => m.type === 'OPEN_RESOURCE_PICKER')).toBe(true),
    );
    const pickerMsg = outbound.find((m) => m.type === 'OPEN_RESOURCE_PICKER');
    const payload = pickerMsg?.payload as
      | { resourceType?: string; baseModelGroup?: string }
      | undefined;
    expect(payload?.resourceType).toBe('Checkpoint');
    expect(payload?.baseModelGroup).toBeUndefined();
  });

  it('Sheet Builder with no stacks funnels into stack creation', async () => {
    // One character, zero stacks — the first-run wall.
    const seed = {
      'v1:char:funnel-char': {
        id: 'funnel-char',
        name: 'Kaida',
        description: 'A cyberpunk street samurai',
        traits: ['neon-blue undercut hair'],
        triggerWords: ['kaida_cyber'],
        negativePrompt: 'blurry, low quality',
        seedPolicy: 'locked',
        createdAt: '2026-10-01T22:00:00.000Z',
        updatedAt: '2026-10-01T22:00:00.000Z',
      },
    };
    uninstall = installMockMoneyHost({ storage: { seed } });
    const user = userEvent.setup();
    render(<App />);
    await screen.findByText('Character Sheet Studio');

    await user.click(screen.getByRole('tab', { name: 'Sheet Builder' }));
    await screen.findByTestId('builder-create-stack');
    await user.click(screen.getByTestId('builder-create-stack'));

    // Lands on the Stacks tab, ready to create.
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'New stack' })).toBeInTheDocument(),
    );
  });
});
