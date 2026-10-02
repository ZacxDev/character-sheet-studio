import { afterEach, describe, expect, it } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { App } from './App.js';
import { installMockMoneyHost } from './mock-buzz.js';
import { SheetBuilder } from './screens/SheetBuilder.js';
import { SheetView } from './screens/SheetView.js';
import {
  DEFAULT_SETTINGS,
  type Character,
  type ModelStack,
  type SheetJob,
} from './sheet/types.js';
import type { SheetLibrary } from './sheet/useSheetLibrary.js';

// Component-level UX contracts, driven through the real SDK transport against
// the mock host (no hook mocking):
//
// 1. The checkpoint picker is UNCONSTRAINED — the block opens the generic
//    resource picker with resourceType 'Checkpoint' and no baseModelGroup,
//    so the viewer sees ALL checkpoints (the checkpoint-only hook requires
//    an ecosystem hint, which filters the list).
// 2. The Sheet Builder funnels a stackless first run into stack creation:
//    the "Create a stack" CTA switches to the Stacks tab instead of
//    dead-ending.
// 3. Zero selected panels can't be priced: the CTA relabels + disables
//    instead of burning a consent round-trip (which used to soft-lock the
//    screen — validation errors never reset the consent-wait phase).
// 4. A guest clicking Price gets visible feedback (and the app header always
//    offers Sign in) instead of a silent no-op.
// 5. An unaffordable panel renders the Top up Buzz affordance that
//    `panelErrorCopy().showTopUp` asks for (other failures don't).

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

// ---------------------------------------------------------------------------
// Shared stubs for the component-level contracts below.

const demoChar: Character = {
  id: 'char-1',
  name: 'Kaida',
  description: 'A cyberpunk street samurai',
  traits: ['neon-blue undercut hair'],
  triggerWords: ['kaida_cyber'],
  negativePrompt: 'blurry, low quality',
  seedPolicy: 'locked',
  createdAt: '2026-10-01T22:00:00.000Z',
  updatedAt: '2026-10-01T22:00:00.000Z',
};

const demoStack: ModelStack = {
  id: 'stack-1',
  name: 'SDXL Anime',
  checkpoint: { modelId: 101055, modelVersionId: 128078, baseModel: 'SDXL 1.0', name: 'SDXL 1.0' },
  loras: [],
  notes: '',
  createdAt: '2026-10-01T22:00:00.000Z',
  updatedAt: '2026-10-01T22:00:00.000Z',
};

function stubLibrary(over: Partial<SheetLibrary> = {}): SheetLibrary {
  return {
    ready: true,
    characters: [demoChar],
    stacks: [demoStack],
    sheets: [],
    settings: DEFAULT_SETTINGS,
    quota: null,
    saveCharacter: async () => null,
    deleteCharacter: async () => null,
    saveStack: async () => null,
    deleteStack: async () => null,
    saveSheet: async () => null,
    deleteSheet: async () => null,
    saveSettings: async () => null,
    refreshQuota: async () => undefined,
    ...over,
  };
}

describe('Sheet Builder panel gate + guest pricing', () => {
  let uninstall: (() => void) | undefined;
  afterEach(() => {
    uninstall?.();
    uninstall = undefined;
  });

  it('zero panels: CTA relabels + disables; checking a panel re-enables it', async () => {
    uninstall = installMockMoneyHost({});
    const user = userEvent.setup();
    render(
      <SheetBuilder
        library={stubLibrary()}
        preselectedCharacterId={null}
        onOpenSheet={() => {}}
        onCreateStack={() => {}}
      />,
    );

    const priceBtn = await screen.findByTestId('se-builder-price');
    expect(priceBtn).toHaveTextContent('Price 4 panels');
    expect(priceBtn).not.toBeDisabled();

    // Uncheck every checked panel (the img2img box is disabled — no portrait).
    for (const box of screen.getAllByRole('checkbox')) {
      const el = box as HTMLInputElement;
      if (el.checked && !el.disabled) await user.click(el);
    }
    await waitFor(() => expect(priceBtn).toHaveTextContent('Select a panel to price'));
    expect(priceBtn).toBeDisabled();

    // Checking one panel back re-enables pricing for exactly that panel.
    const first = screen.getAllByRole('checkbox').find(
      (b) => !(b as HTMLInputElement).disabled,
    ) as HTMLInputElement;
    await user.click(first);
    await waitFor(() => expect(priceBtn).toHaveTextContent('Price 1 panel'));
    expect(priceBtn).not.toBeDisabled();
  });

  it('guest Price click shows sign-in guidance instead of no-op\'ing', async () => {
    uninstall = installMockMoneyHost({ viewer: null });
    const user = userEvent.setup();
    render(
      <SheetBuilder
        library={stubLibrary()}
        preselectedCharacterId={null}
        onOpenSheet={() => {}}
        onCreateStack={() => {}}
      />,
    );

    await user.click(await screen.findByTestId('se-builder-price'));
    await screen.findByText(/browsing as a guest — sign in to price and generate/);
  });

  it('guest sees a Sign in button in the app header', async () => {
    uninstall = installMockMoneyHost({ viewer: null });
    render(<App />);
    await screen.findByText('Character Sheet Studio');
    expect(screen.getByTestId('se-sign-in')).toBeInTheDocument();
  });
});

describe('Sheet View top-up affordance', () => {
  let uninstall: (() => void) | undefined;
  afterEach(() => {
    uninstall?.();
    uninstall = undefined;
  });

  const sheetWith = (errorCode: string): SheetJob => ({
    id: 'sheet-1',
    name: 'Kaida sheet',
    characterId: 'char-1',
    stackId: 'stack-1',
    seed: 42,
    account: 'auto',
    useReference: false,
    status: 'failed',
    panels: [
      {
        id: 'p1',
        kind: 'front',
        label: 'Front view',
        promptModifier: 'front view',
        seed: 42,
        status: 'failed',
        outputs: [],
        submitNonce: 0,
        errorCode,
      },
    ],
    createdAt: '2026-10-01T22:00:00.000Z',
    updatedAt: '2026-10-01T22:00:00.000Z',
  });

  it('unaffordable panel offers Top up Buzz; other failures do not', async () => {
    uninstall = installMockMoneyHost({});
    const { unmount } = render(
      <SheetView
        library={stubLibrary({ sheets: [sheetWith('unaffordable')] })}
        sheetId="sheet-1"
        onBack={() => {}}
      />,
    );
    expect(await screen.findByTestId('se-panel-top-up')).toHaveTextContent('Top up Buzz');
    unmount();

    render(
      <SheetView
        library={stubLibrary({ sheets: [sheetWith('generation-failed')] })}
        sheetId="sheet-1"
        onBack={() => {}}
      />,
    );
    await screen.findByText(/Front view/);
    expect(screen.queryByTestId('se-panel-top-up')).not.toBeInTheDocument();
  });
});

describe('Sheet View priced submits + action feedback', () => {
  let uninstall: (() => void) | undefined;
  afterEach(() => {
    uninstall?.();
    uninstall = undefined;
  });

  const jobWith = (panel: SheetJob['panels'][number], status: SheetJob['status']): SheetJob => ({
    id: 'sheet-1',
    name: 'Kaida sheet',
    characterId: 'char-1',
    stackId: 'stack-1',
    seed: 42,
    account: 'auto',
    useReference: false,
    status,
    panels: [panel],
    createdAt: '2026-10-01T22:00:00.000Z',
    updatedAt: '2026-10-01T22:00:00.000Z',
  });

  it('queued panel: the price is shown and confirmed BEFORE any submit', async () => {
    const outbound: { type?: string; payload?: unknown }[] = [];
    uninstall = installMockMoneyHost({
      consentGranted: true, // isolate pricing: no consent detour
      onOutbound: (msg) => {
        outbound.push(msg);
      },
    });
    const user = userEvent.setup();
    render(
      <SheetView
        library={stubLibrary({
          sheets: [
            jobWith(
              {
                id: 'p1',
                kind: 'front',
                label: 'Front view',
                promptModifier: 'front view',
                seed: 42,
                status: 'queued',
                outputs: [],
                submitNonce: 0,
              },
              'draft',
            ),
          ],
        })}
        sheetId="sheet-1"
        onBack={() => {}}
      />,
    );

    await user.click(await screen.findByRole('button', { name: 'Submit' }));

    // Estimate ran, price is on screen, and NOTHING was submitted yet.
    const confirmBtn = await screen.findByTestId('se-panel-confirm-submit');
    expect(screen.getByText('8 Buzz')).toBeInTheDocument();
    expect(outbound.some((m) => m.type === 'ESTIMATE_WORKFLOW')).toBe(true);
    expect(outbound.some((m) => m.type === 'SUBMIT_WORKFLOW')).toBe(false);

    await user.click(confirmBtn);
    await waitFor(() =>
      expect(outbound.some((m) => m.type === 'SUBMIT_WORKFLOW')).toBe(true),
    );
  });

  it('done panel: Export flashes a confirmation and Publish sticks', async () => {
    uninstall = installMockMoneyHost({});
    const user = userEvent.setup();
    render(
      <SheetView
        library={stubLibrary({
          sheets: [
            jobWith(
              {
                id: 'p1',
                kind: 'front',
                label: 'Front view',
                promptModifier: 'front view',
                seed: 42,
                status: 'done',
                outputs: ['https://example.com/front.png'],
                submitNonce: 1,
                workflowId: 'wf-1',
              },
              'complete',
            ),
          ],
        })}
        sheetId="sheet-1"
        onBack={() => {}}
      />,
    );

    await user.click(await screen.findByRole('button', { name: 'Export' }));
    await screen.findByRole('button', { name: 'Exported ✓' });

    await user.click(screen.getByRole('button', { name: 'Publish' }));
    const published = await screen.findByRole('button', { name: 'Published ✓' });
    expect(published).toBeDisabled();
  });
});
