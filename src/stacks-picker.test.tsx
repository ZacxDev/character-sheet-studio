import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { App } from './App.js';
import { installMockMoneyHost } from './mock-buzz.js';
import { Characters } from './screens/Characters.js';
import { SheetBuilder } from './screens/SheetBuilder.js';
import { SheetView } from './screens/SheetView.js';
import { Stacks } from './screens/Stacks.js';
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
    await screen.findByRole('button', { name: 'Characters' });

    await user.click(screen.getByRole('button', { name: 'Stacks' }));
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
    await screen.findByRole('button', { name: 'Characters' });

    await user.click(screen.getByRole('button', { name: 'Sheet Builder' }));
    // Zero stacks no longer detours to another tab — the inline stack
    // create starts open right in the Builder.
    await screen.findByTestId('stack-name');
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

  it('review auto-prices on arrival; zero panels keeps the disabled Price CTA', async () => {
    uninstall = installMockMoneyHost({});
    const user = userEvent.setup();
    render(
      <SheetBuilder
        library={stubLibrary()}
        preselectedCharacterId={null}
        onOpenSheet={() => {}}
        onCreateStack={() => {}}
        onCreateCharacter={() => {}}
      />,
    );

    // Landing on Review with the default 4 panels prices itself — the
    // confirm card appears without anyone touching a Price button.
    await screen.findByTestId('builder-stack-card');
    await user.click(screen.getByTestId('builder-step-tab-2'));
    expect(
      await screen.findByRole('button', { name: /Generate 4 panels · 32 Buzz/ }),
    ).toBeInTheDocument();

    // Back out, unselect every panel: no auto-price fires, and the Price
    // CTA shows the disabled select-a-panel state.
    await user.click(screen.getByTestId('se-confirm-back'));
    await user.click(screen.getByTestId('builder-step-tab-1'));
    for (const card of screen.getAllByTestId('builder-panel-card')) {
      if (card.dataset.selected === 'true') await user.click(card);
    }
    await user.click(screen.getByTestId('builder-step-tab-2'));
    const priceBtn = await screen.findByTestId('se-builder-price');
    await waitFor(() => expect(priceBtn).toHaveTextContent('Select a panel to price'));
    expect(priceBtn).toBeDisabled();

    // Picking one panel back re-prices automatically for exactly that panel.
    await user.click(screen.getByTestId('builder-step-tab-1'));
    await user.click(screen.getAllByTestId('builder-panel-card')[0]);
    await user.click(screen.getByTestId('builder-step-tab-2'));
    expect(
      await screen.findByRole('button', { name: /Generate 1 panel/ }),
    ).toBeInTheDocument();
  });

  it('Builder stack choice is independent of the character (no default-stack link)', async () => {
    uninstall = installMockMoneyHost({});
    const user = userEvent.setup();
    const secondStack: ModelStack = {
      ...demoStack,
      id: 'stack-2',
      name: 'Pony Detail',
    };
    const linkedChar: Character = {
      ...demoChar,
      id: 'char-2',
      name: 'Mina',
      // Legacy saved link: even when present in storage, the Builder must
      // not let it choose the stack for a run.
      defaultStackId: 'stack-2',
    };
    render(
      <SheetBuilder
        library={stubLibrary({
          characters: [demoChar, linkedChar],
          stacks: [demoStack, secondStack],
        })}
        preselectedCharacterId={null}
        onOpenSheet={() => {}}
        onCreateStack={() => {}}
        onCreateCharacter={() => {}}
      />,
    );

    await screen.findAllByTestId('builder-stack-card');
    const charCardFor = (id: string) =>
      screen
        .getAllByTestId('builder-char-card')
        .find((c) => c.dataset.characterId === id) as HTMLElement;
    const cardFor = (id: string) =>
      screen
        .getAllByTestId('builder-stack-card')
        .find((c) => c.dataset.stackId === id) as HTMLElement;
    expect(cardFor('stack-1').dataset.selected).toBe('true');

    // Switching to a character with a legacy default does not move the stack.
    await user.click(charCardFor('char-2'));
    expect(cardFor('stack-1').dataset.selected).toBe('true');

    // And a stack picked for this run survives later character switches.
    await user.click(cardFor('stack-2'));
    await user.click(charCardFor('char-1'));
    expect(cardFor('stack-2').dataset.selected).toBe('true');
  });

  it('guest Price button carries the sign-in ask (no duplicate notice)', async () => {
    const outbound: { type?: string }[] = [];
    uninstall = installMockMoneyHost({
      viewer: null,
      onOutbound: (m) => outbound.push(m),
    });
    const user = userEvent.setup();
    render(
      <SheetBuilder
        library={stubLibrary()}
        preselectedCharacterId={null}
        onOpenSheet={() => {}}
        onCreateStack={() => {}}
        onCreateCharacter={() => {}}
      />,
    );

    // The guest state lives on the button itself; clicking asks the host
    // for sign-in, never a pricing call and never a second banner.
    await screen.findByTestId('builder-stack-card');
    await user.click(screen.getByTestId('builder-step-tab-2'));
    const priceBtn = await screen.findByTestId('se-builder-price');
    expect(priceBtn).toHaveTextContent('Sign in to generate');
    await user.click(priceBtn);
    await waitFor(() =>
      expect(outbound.some((m) => m.type === 'REQUEST_SIGN_IN')).toBe(true),
    );
    expect(outbound.some((m) => m.type === 'ESTIMATE_WORKFLOW')).toBe(false);
    expect(
      screen.queryByText(/sign in to price and generate/),
    ).not.toBeInTheDocument();
  });

  it('guest sees a Sign in button in the app header', async () => {
    uninstall = installMockMoneyHost({ viewer: null });
    render(<App />);
    await screen.findByRole('button', { name: 'Characters' });
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
        onNewSheet={() => {}}
        onRegenerateSheet={() => {}}
      />,
    );
    expect(await screen.findByTestId('se-panel-top-up')).toHaveTextContent('Top up Buzz');
    unmount();

    render(
      <SheetView
        library={stubLibrary({ sheets: [sheetWith('generation-failed')] })}
        sheetId="sheet-1"
        onBack={() => {}}
        onNewSheet={() => {}}
        onRegenerateSheet={() => {}}
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
        onNewSheet={() => {}}
        onRegenerateSheet={() => {}}
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
        onNewSheet={() => {}}
        onRegenerateSheet={() => {}}
      />,
    );

    // Export / Publish now live behind the panel's "More" menu — Post is
    // the one filled action on the card.
    await user.click(await screen.findByTestId('se-panel-more'));
    await user.click(await screen.findByRole('button', { name: 'Export' }));
    await screen.findByRole('button', { name: 'Exported ✓' });

    await user.click(screen.getByRole('button', { name: 'Publish' }));
    const published = await screen.findByRole('button', { name: 'Published ✓' });
    expect(published).toBeDisabled();
  });
});

describe('Character drill-in, sheet previews, generation skeleton', () => {
  let uninstall: (() => void) | undefined;
  afterEach(() => {
    uninstall?.();
    uninstall = undefined;
  });

  const sheetWithDonePanel: SheetJob = {
    id: 'sheet-1',
    name: 'Kaida sheet',
    characterId: 'char-1',
    stackId: 'stack-1',
    seed: 42,
    account: 'auto',
    useReference: false,
    status: 'complete',
    panels: [
      {
        id: 'p1',
        kind: 'front',
        label: 'Front view',
        promptModifier: 'front view',
        seed: 42,
        status: 'done',
        outputs: ['https://example.com/front.png'],
        submitNonce: 1,
      },
    ],
    createdAt: '2026-10-01T22:00:00.000Z',
    updatedAt: '2026-10-01T22:00:00.000Z',
  };

  it('character card click lands on the character page with its sheets', async () => {
    const seed = {
      'v1:char:char-1': {
        id: 'char-1',
        name: 'Kaida',
        description: 'A cyberpunk street samurai',
        traits: ['neon-blue undercut hair'],
        triggerWords: ['kaida_cyber'],
        negativePrompt: 'blurry, low quality',
        seedPolicy: 'locked',
        createdAt: '2026-10-01T22:00:00.000Z',
        updatedAt: '2026-10-01T22:00:00.000Z',
      },
      'v1:sheet:sheet-1': sheetWithDonePanel,
    };
    uninstall = installMockMoneyHost({ storage: { seed } });
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole('button', { name: 'Characters' });

    // The generated panel shows on the character card as a thumbnail…
    const card = await screen.findByTestId('char-card');
    expect(await within(card).findByTestId('char-card-thumb')).toHaveAttribute(
      'src',
      'https://example.com/front.png',
    );
    // …the seed-policy icon button is gone from the card…
    expect(within(card).queryByTestId('char-seed-info')).not.toBeInTheDocument();
    // …and clicking the card lands on the character's own page: details,
    // the New sheet action, and the sheet with its image carousel.
    await user.click(card);

    expect(await screen.findByTestId('char-view-new-sheet')).toBeInTheDocument();
    expect(screen.getByText('Kaida sheet')).toBeInTheDocument();
    expect(await screen.findByTestId('char-view-thumb')).toHaveAttribute(
      'src',
      'https://example.com/front.png',
    );
    // No status badge on the character page.
    expect(screen.queryByText('Complete')).not.toBeInTheDocument();

    // Back returns to the cast list (via the breadcrumb).
    await user.click(screen.getByRole('link', { name: 'Characters' }));
    expect(await screen.findByTestId('char-card')).toBeInTheDocument();
  });

  it('a running panel shows the generation skeleton, not a blank box', async () => {
    uninstall = installMockMoneyHost({});
    render(
      <SheetView
        library={stubLibrary({
          sheets: [
            {
              ...sheetWithDonePanel,
              status: 'running',
              panels: [
                {
                  id: 'p1',
                  kind: 'front',
                  label: 'Front view',
                  promptModifier: 'front view',
                  seed: 42,
                  status: 'running',
                  workflowId: 'wf-live-1',
                  outputs: [],
                  submitNonce: 1,
                },
              ],
            },
          ],
        })}
        sheetId="sheet-1"
        onBack={() => {}}
        onNewSheet={() => {}}
        onRegenerateSheet={() => {}}
      />,
    );
    const skeleton = await screen.findByTestId('se-panel-skeleton');
    expect(skeleton).toHaveAttribute('aria-label', 'Generating Front view');
  });
});

describe('Batch B/C leftovers', () => {
  let uninstall: (() => void) | undefined;
  afterEach(() => {
    uninstall?.();
    uninstall = undefined;
  });

  it('Builder with no characters walls into character creation', async () => {
    uninstall = installMockMoneyHost({});
    const user = userEvent.setup();
    const onCreateCharacter = vi.fn();
    render(
      <SheetBuilder
        library={stubLibrary({ characters: [] })}
        preselectedCharacterId={null}
        onOpenSheet={() => {}}
        onCreateStack={() => {}}
        onCreateCharacter={onCreateCharacter}
      />,
    );
    await user.click(await screen.findByTestId('builder-create-character'));
    expect(onCreateCharacter).toHaveBeenCalledTimes(1);
  });

  const seedChar = {
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
  const sheetShell = {
    name: 'Paused sheet',
    characterId: 'char-1',
    stackId: 'stack-1',
    seed: 42,
    account: 'auto',
    useReference: false,
    createdAt: '2026-10-01T22:00:00.000Z',
    updatedAt: '2026-10-01T22:00:00.000Z',
  };

  it('human status labels everywhere + Sheets tab exits an open sheet', async () => {
    const seed = {
      'v1:char:char-1': seedChar,
      'v1:sheet:sheet-paused': {
        ...sheetShell,
        id: 'sheet-paused',
        status: 'paused',
        panels: [
          {
            id: 'p1', kind: 'front', label: 'Front view', promptModifier: 'front',
            seed: 42, status: 'done', outputs: ['https://example.com/front.png'],
            submitNonce: 1,
          },
          {
            id: 'p2', kind: 'side', label: 'Side view', promptModifier: 'side',
            seed: 42, status: 'queued', outputs: [], submitNonce: 0,
          },
        ],
      },
      'v1:sheet:sheet-draft': {
        ...sheetShell,
        id: 'sheet-draft',
        name: 'Draft sheet',
        status: 'draft',
        panels: [
          {
            id: 'p3', kind: 'front', label: 'Front view', promptModifier: 'front',
            seed: 42, status: 'queued', outputs: [], submitNonce: 0,
          },
        ],
      },
    };
    uninstall = installMockMoneyHost({ storage: { seed } });
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole('button', { name: 'Characters' });

    // Drill in by clicking the character card (2 sheets).
    const card = await screen.findByTestId('char-card');
    await user.click(card);

    // The character page lists both sheets by name and panel counts — no
    // status badges or labels here.
    expect(await screen.findByText('Paused sheet')).toBeInTheDocument();
    expect(screen.getByText('Draft sheet')).toBeInTheDocument();
    expect(screen.queryByText('Partially done')).not.toBeInTheDocument();
    expect(screen.queryByText('Not started')).not.toBeInTheDocument();

    // Open the paused sheet by clicking its card — the count in the
    // header IS the status voice now (no duplicate header badge).
    const sheetCards = await screen.findAllByTestId('char-view-sheet');
    const pausedCard = sheetCards.find((c) => c.textContent?.includes('Paused sheet'));
    await user.click(pausedCard ?? sheetCards[0]);
    expect(await screen.findByText(/1\/2 panels done/)).toBeInTheDocument();
    expect(screen.queryByText('Partially done')).not.toBeInTheDocument();

    // The Sheets tab still speaks in human labels on the full list, and
    // clicking it while a sheet is open returns to that list.
    await user.click(screen.getByRole('button', { name: 'Sheets' }));
    expect(await screen.findByText('Partially done')).toBeInTheDocument();
    expect(screen.getByText('Not started')).toBeInTheDocument();
    expect(screen.queryByText('paused')).not.toBeInTheDocument();
    expect(screen.queryByText('draft')).not.toBeInTheDocument();
    expect((await screen.findAllByRole('button', { name: 'Open' })).length).toBe(2);
  });

  it('Submit all queued prices once, confirms the total, then submits every panel', async () => {
    const outbound: { type?: string }[] = [];
    uninstall = installMockMoneyHost({ onOutbound: (m) => outbound.push(m) });
    const user = userEvent.setup();
    const queuedSheet: SheetJob = {
      id: 'sheet-q',
      name: 'Queued batch',
      characterId: 'char-1',
      stackId: 'stack-1',
      seed: 42,
      account: 'auto',
      useReference: false,
      status: 'draft',
      panels: [
        {
          id: 'qp1', kind: 'front', label: 'Front view', promptModifier: 'front view',
          seed: 42, status: 'queued', outputs: [], submitNonce: 0,
        },
        {
          id: 'qp2', kind: 'side', label: 'Side view', promptModifier: 'side view',
          seed: 42, status: 'queued', outputs: [], submitNonce: 0,
        },
      ],
      createdAt: '2026-10-01T22:00:00.000Z',
      updatedAt: '2026-10-01T22:00:00.000Z',
    };
    render(
      <SheetView
        library={stubLibrary({ sheets: [queuedSheet] })}
        sheetId="sheet-q"
        onBack={() => {}}
        onNewSheet={() => {}}
        onRegenerateSheet={() => {}}
      />,
    );

    // One status voice: the meta line counts panels; no header badge, and
    // the completed panels speak through their images (no "Done" stamps).
    expect(await screen.findByText(/0\/2 panels done/)).toBeInTheDocument();
    const batchBtn = await screen.findByTestId('se-submit-all');
    expect(batchBtn).toHaveTextContent('Submit all queued (2)');

    await user.click(batchBtn);
    const confirm = await screen.findByTestId('se-submit-all-confirm');
    // Mock estimates at 8 Buzz per panel.
    expect(confirm).toHaveTextContent('≈16 Buzz');
    expect(outbound.filter((m) => m.type === 'ESTIMATE_WORKFLOW')).toHaveLength(2);
    expect(outbound.some((m) => m.type === 'SUBMIT_WORKFLOW')).toBe(false);

    await user.click(screen.getByTestId('se-submit-all-confirm-submit'));
    await waitFor(() =>
      expect(outbound.filter((m) => m.type === 'SUBMIT_WORKFLOW')).toHaveLength(2),
    );
    // Both panels run to completion under the mock host (poll backoff).
    await waitFor(() => expect(screen.queryByTestId('se-submit-all')).not.toBeInTheDocument());
    await waitFor(
      () => expect(screen.getByAltText('Front view')).toBeInTheDocument(),
      { timeout: 15000 },
    );
    await waitFor(
      () => expect(screen.getByAltText('Side view')).toBeInTheDocument(),
      { timeout: 15000 },
    );
    expect(screen.getByText(/2\/2 panels done/)).toBeInTheDocument();
    expect(screen.queryByText('Done')).not.toBeInTheDocument();
  });

  it('stack editor: duplicate LoRA pick says so; mismatched family warns', async () => {
    const detailLora = {
      modelVersionId: 777,
      strength: 1,
      triggerWords: [] as string[],
      name: 'Detail Booster — v1',
      baseModel: 'SDXL 1.0',
    };
    uninstall = installMockMoneyHost({
      cannedPicks: {
        LORA: {
          versionId: 777,
          modelId: 55,
          modelName: 'Detail Booster',
          versionName: 'v1',
          baseModel: 'SDXL 1.0',
          modelType: 'LORA',
          trainedWords: [],
        },
      },
    });
    const user = userEvent.setup();
    render(
      <Stacks
        library={stubLibrary({
          stacks: [{ ...demoStack, loras: [detailLora] }],
        })}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Edit' }));
    expect(await screen.findByText('LoRAs (1/5)')).toBeInTheDocument();

    // Re-picking the stacked LoRA surfaces feedback instead of a silent no-op.
    await user.click(screen.getByRole('button', { name: 'Add LoRA' }));
    const notice = await screen.findByTestId('stack-lora-notice');
    expect(notice).toHaveTextContent('already in this stack');
    expect(screen.getByText('LoRAs (1/5)')).toBeInTheDocument();

    // No mismatch while families agree.
    expect(screen.queryByTestId('stack-lora-mismatch')).not.toBeInTheDocument();
  });

  it('stack editor warns when a LoRA family mismatches the checkpoint', async () => {
    uninstall = installMockMoneyHost({});
    const user = userEvent.setup();
    const ponyStack: ModelStack = {
      ...demoStack,
      id: 'stack-pony',
      name: 'Pony stack',
      checkpoint: { modelId: 7, modelVersionId: 9, baseModel: 'Pony', name: 'Pony XL' },
      loras: [
        {
          modelVersionId: 777,
          strength: 1,
          triggerWords: [],
          name: 'Detail Booster — v1',
          baseModel: 'SDXL 1.0',
        },
      ],
    };
    render(<Stacks library={stubLibrary({ stacks: [ponyStack] })} />);
    await user.click(screen.getByRole('button', { name: 'Edit' }));
    const warn = await screen.findByTestId('stack-lora-mismatch');
    expect(warn).toHaveTextContent('SDXL 1.0');
    expect(warn).toHaveTextContent('Pony');
    // Checkpoint label shows the name without re-appending its family.
    expect(screen.getAllByText('Pony XL').length).toBeGreaterThan(0);
    expect(screen.queryByText(/Pony XL \(Pony\)/)).not.toBeInTheDocument();
  });

  it('delete confirmations say what happens to the sheets', async () => {
    uninstall = installMockMoneyHost({});
    const user = userEvent.setup();
    const sheet: SheetJob = {
      id: 'sheet-1',
      name: 'Kaida sheet',
      characterId: 'char-1',
      stackId: 'stack-1',
      seed: 42,
      account: 'auto',
      useReference: false,
      status: 'complete',
      panels: [
        {
          id: 'p1', kind: 'front', label: 'Front view', promptModifier: 'front',
          seed: 42, status: 'done', outputs: ['https://example.com/f.png'],
          submitNonce: 1,
        },
      ],
      createdAt: '2026-10-01T22:00:00.000Z',
      updatedAt: '2026-10-01T22:00:00.000Z',
    };
    const library = stubLibrary({ sheets: [sheet] });
    const { unmount } = render(
      <Characters library={library} onBuildSheet={() => {}} onViewSheets={() => {}} />,
    );
    // Delete now lives in the card's 3-dot menu; picking it surfaces the
    // confirm row (with the sheets consequence) on the card.
    await user.click(screen.getByTestId('char-menu'));
    await user.click(screen.getByTestId('char-menu-delete'));
    expect(
      await screen.findByText(/keep their\s+images, labeled “Unknown character”/),
    ).toBeInTheDocument();
    unmount();

    render(<Stacks library={library} />);
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    expect(
      await screen.findByText(/keep\s+their images, labeled “Unknown stack”/),
    ).toBeInTheDocument();
  });
});

describe('UX audit fix batch (P0/P1)', () => {
  let uninstall: (() => void) | undefined;
  afterEach(() => {
    uninstall?.();
    uninstall = undefined;
  });

  const panelFixture = (over: Record<string, unknown> = {}) => ({
    id: 'fp1',
    kind: 'front' as const,
    label: 'Front view',
    promptModifier: 'front view',
    seed: 42,
    status: 'queued' as const,
    outputs: [] as string[],
    submitNonce: 0,
    ...over,
  });

  const sheetFixture = (panels: ReturnType<typeof panelFixture>[], over: Record<string, unknown> = {}): SheetJob =>
    ({
      id: 'sheet-fx',
      name: 'Fixture sheet',
      characterId: 'char-1',
      stackId: 'stack-1',
      seed: 42,
      account: 'auto',
      useReference: false,
      status: 'draft',
      panels,
      createdAt: '2026-10-01T22:00:00.000Z',
      updatedAt: '2026-10-01T22:00:00.000Z',
      ...over,
    }) as SheetJob;

  it('Cancel sticks: the poll loop can never resurrect a canceled panel', async () => {
    const outbound: { type?: string }[] = [];
    uninstall = installMockMoneyHost({
      pollsUntilDone: 99, // generation never finishes during this test
      onOutbound: (m) => outbound.push(m),
    });
    const user = userEvent.setup();
    render(
      <SheetView
        library={stubLibrary({ sheets: [sheetFixture([panelFixture()])] })}
        sheetId="sheet-fx"
        onBack={() => {}}
        onNewSheet={() => {}}
        onRegenerateSheet={() => {}}
      />,
    );

    // Price the queued panel and submit it.
    await user.click(await screen.findByRole('button', { name: 'Submit' }));
    await user.click(await screen.findByTestId('se-panel-confirm-submit'));
    await screen.findByTestId('se-panel-skeleton');

    // Cancel while it's generating.
    await user.click(await screen.findByRole('button', { name: 'Cancel' }));
    await screen.findByText('Canceled');
    expect(
      screen.getByRole('button', { name: 'Submit again' }),
    ).toBeInTheDocument();
    expect(screen.queryByTestId('se-panel-skeleton')).not.toBeInTheDocument();

    // The mock keeps answering 'processing' for a canceled workflow — the
    // old code snapped the panel back to "Generating…" within one poll.
    const pollsAtCancel = outbound.filter((m) => m.type === 'POLL_WORKFLOW').length;
    await new Promise((r) => setTimeout(r, 4600));
    expect(outbound.filter((m) => m.type === 'POLL_WORKFLOW')).toHaveLength(
      pollsAtCancel,
    );
    expect(screen.getByText('Canceled')).toBeInTheDocument();
    expect(screen.queryByTestId('se-panel-skeleton')).not.toBeInTheDocument();
  }, 20000);

  it('a panel persisted running-without-workflow heals back to Queued', async () => {
    uninstall = installMockMoneyHost({});
    render(
      <SheetView
        library={stubLibrary({
          sheets: [
            sheetFixture(
              [panelFixture({ status: 'running' })], // no workflowId — the zombie shape
              { status: 'running' },
            ),
          ],
        })}
        sheetId="sheet-fx"
        onBack={() => {}}
        onNewSheet={() => {}}
        onRegenerateSheet={() => {}}
      />,
    );
    // Never a running panel with no resolving action: it offers Submit.
    expect(await screen.findByText('Queued')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Submit' })).toBeInTheDocument();
    expect(screen.queryByTestId('se-panel-skeleton')).not.toBeInTheDocument();
  });

  it('Builder gates on hydration, then self-heals the phantom selection', async () => {
    const outbound: { type?: string }[] = [];
    uninstall = installMockMoneyHost({ onOutbound: (m) => outbound.push(m) });
    const user = userEvent.setup();
    const props = {
      preselectedCharacterId: null,
      onOpenSheet: () => {},
      onCreateStack: () => {},
      onCreateCharacter: () => {},
    };
    const { rerender } = render(
      <SheetBuilder
        library={stubLibrary({ ready: false, characters: [], stacks: [] })}
        {...props}
      />,
    );
    // Cold open: no create-first cards, no dead selects — just loading.
    expect(screen.getByText('Loading your library…')).toBeInTheDocument();
    expect(screen.queryByTestId('builder-create-character')).not.toBeInTheDocument();

    rerender(<SheetBuilder library={stubLibrary()} {...props} />);
    await user.click(await screen.findByTestId('builder-step-tab-2'));
    // Landing on Review auto-prices. The select DISPLAYED Kaida while state
    // was '' before the fix; pricing now runs against the healed selection
    // instead of dead-ending.
    await waitFor(() =>
      expect(outbound.some((m) => m.type === 'ESTIMATE_WORKFLOW')).toBe(true),
    );
    expect(screen.queryByText('Pick a character first.')).not.toBeInTheDocument();
  });

  it('confirm card refuses to arm Generate when the balance cannot cover it', async () => {
    uninstall = installMockMoneyHost({
      buzzBalance: { blue: 0, green: 0, yellow: 0 },
    });
    const user = userEvent.setup();
    render(
      <SheetBuilder
        library={stubLibrary()}
        preselectedCharacterId={null}
        onOpenSheet={() => {}}
        onCreateStack={() => {}}
        onCreateCharacter={() => {}}
      />,
    );

    await user.click(await screen.findByTestId('builder-step-tab-2'));
    // Auto-priced on arrival: 4 default panels × 8 Buzz against a 0 balance:
    // warned HERE, with the top-up on the card — not discovered via four
    // failed panels later.
    await screen.findByTestId('se-builder-insufficient');
    const generate = screen.getByRole('button', { name: /Generate 4 panels/ });
    expect(generate).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Top up Buzz' })).toBeInTheDocument();
  });

  it('a shared insufficient-balance failure becomes ONE sheet-level banner', async () => {
    uninstall = installMockMoneyHost({});
    render(
      <SheetView
        library={stubLibrary({
          sheets: [
            sheetFixture(
              [
                panelFixture({ id: 'fp1', status: 'failed', errorCode: 'unaffordable', workflowId: 'wf-a' }),
                panelFixture({ id: 'fp2', kind: 'side', label: 'Side view', status: 'failed', errorCode: 'unaffordable', workflowId: 'wf-b' }),
                panelFixture({ id: 'fp3', kind: 'back', label: 'Back view', status: 'failed', errorCode: 'generation-failed', workflowId: 'wf-c' }),
              ],
              { status: 'failed' },
            ),
          ],
        })}
        sheetId="sheet-fx"
        onBack={() => {}}
        onNewSheet={() => {}}
        onRegenerateSheet={() => {}}
      />,
    );

    // One banner with one Top up for the shared cause; the unrelated panel
    // failure keeps its own card; every failed panel keeps its Retry.
    await screen.findByTestId('se-batch-insufficient');
    expect(screen.getAllByRole('button', { name: 'Top up Buzz' })).toHaveLength(1);
    expect(screen.queryByTestId('se-panel-top-up')).not.toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Retry' })).toHaveLength(3);
  });
});

describe('Character form randomizer + seed toggle', () => {
  const renderCharacters = () =>
    render(
      <Characters
        library={stubLibrary({ characters: [demoChar] })}
        onBuildSheet={() => {}}
        onViewSheets={() => {}}
      />,
    );

  const field = (label: string) =>
    screen.getByLabelText(label, { exact: false }) as HTMLInputElement | HTMLTextAreaElement;

  const nextStep = async (
    user: ReturnType<typeof userEvent.setup>,
    times = 1,
  ) => {
    for (let i = 0; i < times; i++) {
      await user.click(screen.getByTestId('char-step-next'));
    }
  };

  it('name dice appears in create mode only and fills the name', async () => {
    const user = userEvent.setup();
    renderCharacters();

    await user.click(screen.getByRole('button', { name: 'New character' }));
    const nameInput = screen.getByTestId('char-name') as HTMLInputElement;
    expect(nameInput.value).toBe('');
    await user.click(screen.getByTestId('char-name-dice'));
    expect(nameInput.value).not.toBe('');

    // Edit mode: no dice (the name is the character's identity already).
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await user.click(screen.getByTestId('char-menu'));
    await user.click(screen.getByTestId('char-menu-edit'));
    expect(screen.queryByTestId('char-name-dice')).not.toBeInTheDocument();
  });

  it('randomize fills a clean form in one click', async () => {
    const user = userEvent.setup();
    renderCharacters();
    await user.click(screen.getByRole('button', { name: 'New character' }));
    await user.click(screen.getByTestId('char-randomize'));

    expect((screen.getByTestId('char-name') as HTMLInputElement).value).not.toBe('');
    await nextStep(user);
    expect(field('Positive prompt').value).toMatch(/^an? /);
    // The negative prompt is a separate, clearly optional field on the same
    // step; randomize does not invent one.
    expect(field('Negative prompt (optional)').value).toBe('');
    await nextStep(user);
    expect(field('Traits').value).not.toBe('');
    await nextStep(user);
    expect(field('Trigger words').value).not.toBe('');
    // No confirm was needed — nothing of the user's was overwritten.
    expect(screen.queryByTestId('char-randomize-confirm')).not.toBeInTheDocument();
  });

  it('randomize asks before replacing typed fields', async () => {
    const user = userEvent.setup();
    renderCharacters();
    await user.click(screen.getByRole('button', { name: 'New character' }));
    await user.type(screen.getByTestId('char-name'), 'Mine');
    await nextStep(user);
    await user.type(field('Positive prompt'), 'my own concept');

    await user.click(screen.getByTestId('char-randomize'));
    // Confirm shows and nothing has changed yet.
    expect(await screen.findByTestId('char-randomize-confirm')).toBeInTheDocument();
    expect(field('Positive prompt').value).toBe('my own concept');

    await user.click(screen.getByTestId('char-randomize-confirm'));
    expect(field('Positive prompt').value).toMatch(/^an? /);
    await user.click(screen.getByTestId('char-step-back'));
    expect((screen.getByTestId('char-name') as HTMLInputElement).value).not.toBe('');
  });

  it('seed policy is a toggle switch, not a select', async () => {
    const user = userEvent.setup();
    renderCharacters();
    await user.click(screen.getByRole('button', { name: 'New character' }));
    await user.type(screen.getByTestId('char-name'), 'Seedling');
    await nextStep(user, 5);

    const toggle = screen.getByTestId('char-seed-toggle');
    expect(toggle).toHaveAttribute('role', 'switch');
    expect(toggle).toHaveAttribute('aria-checked', 'true');
    expect(toggle).toHaveTextContent('Locked');
    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    expect(toggle).toHaveTextContent('Varied');
  });

  it('character form is stepped, puts both prompts together, and omits stack selection', async () => {
    const user = userEvent.setup();
    renderCharacters();
    await user.click(screen.getByRole('button', { name: 'New character' }));
    await user.type(screen.getByTestId('char-name'), 'Stepper');

    // One input on the first step, with its help directly below it.
    expect(screen.getByTestId('char-step-indicator')).toHaveTextContent(
      'Step 1 of 6 · Name',
    );
    expect(screen.getByText(/name shown on character cards/)).toBeInTheDocument();
    expect(screen.queryByTestId('char-positive-prompt')).not.toBeInTheDocument();

    // Positive + negative prompts share the next step. Negative is labeled
    // optional and its help repeats that it can be left blank.
    await nextStep(user);
    expect(screen.getByTestId('char-step-indicator')).toHaveTextContent(
      'Step 2 of 6 · Prompts',
    );
    expect(screen.getByTestId('char-positive-prompt')).toBeInTheDocument();
    expect(screen.getByTestId('char-negative-prompt')).toBeInTheDocument();
    expect(screen.getByText(/not required/)).toBeInTheDocument();

    // No step offers a stack/default selection: characters are not linked to
    // a stack ahead of a sheet run anymore.
    for (let i = 0; i < 4; i++) {
      await nextStep(user);
      expect(screen.queryByText('Default stack')).not.toBeInTheDocument();
      expect(screen.queryByText(/preferred stack/i)).not.toBeInTheDocument();
    }
    expect(screen.getByTestId('char-step-indicator')).toHaveTextContent(
      'Step 6 of 6 · Seed policy',
    );
  });

  it('profile step picks from generated images; the pick sticks on save', async () => {
    const user = userEvent.setup();
    const saved: Character[] = [];
    const sheet: SheetJob = {
      id: 'sheet-1',
      name: 'Kaida sheet',
      characterId: 'char-1',
      stackId: 'stack-1',
      seed: 42,
      account: 'auto',
      useReference: false,
      status: 'complete',
      panels: [
        {
          id: 'p1', kind: 'front', label: 'Front view', promptModifier: 'front view',
          seed: 42, status: 'done', outputs: ['https://images.example/front.png'], submitNonce: 1,
        },
        {
          id: 'p2', kind: 'side', label: 'Side view', promptModifier: 'side view',
          seed: 43, status: 'done', outputs: ['https://images.example/side.png'], submitNonce: 1,
        },
      ],
      createdAt: '2026-10-02T00:00:00.000Z',
      updatedAt: '2026-10-02T00:00:00.000Z',
    };
    render(
      <Characters
        library={stubLibrary({
          characters: [demoChar],
          sheets: [sheet],
          saveCharacter: async (c) => {
            saved.push(c);
            return null;
          },
        })}
        onBuildSheet={() => {}}
        onViewSheets={() => {}}
      />,
    );

    await user.click(screen.getByTestId('char-menu'));
    await user.click(screen.getByTestId('char-menu-edit'));
    // With generated images the form gains a step: Profile sits between
    // Reference portrait and Seed policy (6 of 7).
    await nextStep(user, 5);
    expect(screen.getByTestId('char-step-indicator')).toHaveTextContent(
      'Step 6 of 7 · Profile image',
    );
    const options = screen.getAllByTestId('char-profile-option');
    expect(options.map((o) => o.dataset.url)).toEqual([
      'https://images.example/front.png',
      'https://images.example/side.png',
    ]);
    // No pick yet → the first generated image reads as the current profile.
    expect(options[0].dataset.selected).toBe('true');

    // Reset returns to the default; picking again sticks.
    await user.click(options[1]);
    expect(options[1].dataset.selected).toBe('true');
    await user.click(screen.getByTestId('char-profile-reset'));
    expect(options[0].dataset.selected).toBe('true');
    await user.click(options[1]);

    await nextStep(user);
    expect(screen.getByTestId('char-step-indicator')).toHaveTextContent(
      'Step 7 of 7 · Seed policy',
    );
    await user.click(screen.getByTestId('char-save'));
    expect(saved).toHaveLength(1);
    expect(saved[0].profileImageUrl).toBe('https://images.example/side.png');
  });
});

describe('Builder card pickers + inline create (v0.1.20)', () => {
  const renderBuilder = (over: Partial<SheetLibrary> = {}) =>
    render(
      <SheetBuilder
        library={stubLibrary(over)}
        preselectedCharacterId={null}
        onOpenSheet={() => {}}
        onCreateStack={() => {}}
        onCreateCharacter={() => {}}
      />,
    );

  it('stack cards carry the full stack details', async () => {
    renderBuilder();
    const card = (await screen.findAllByTestId('builder-stack-card'))[0];
    expect(card).toHaveTextContent('SDXL Anime');
    expect(card).toHaveTextContent('SDXL 1.0');
    expect(card).toHaveTextContent(/LoRA/);
  });

  it('inline stack create: a preset prefills the editor and saving hands back the stack', async () => {
    const savedStacks: ModelStack[] = [];
    const user = userEvent.setup();
    renderBuilder({
      saveStack: async (s) => {
        savedStacks.push(s);
        return null;
      },
    });

    await user.click(await screen.findByTestId('builder-stack-new'));
    await user.click(screen.getByTestId('builder-stack-preset-anime'));
    const nameInput = (await screen.findByTestId('stack-name')) as HTMLInputElement;
    expect(nameInput.value).toBe('Anime Sheet');

    await user.click(screen.getByTestId('stack-save'));
    await waitFor(() => expect(savedStacks).toHaveLength(1));
    expect(savedStacks[0].name).toBe('Anime Sheet');
  });

  it('custom panels: create counts toward pricing, remove takes it back out', async () => {
    // Installed so the auto-price on Review can complete its consent +
    // estimate round-trips; uninstalled at the end of this test.
    const uninstallHost = installMockMoneyHost({});
    const user = userEvent.setup();
    renderBuilder();
    await user.click(await screen.findByTestId('builder-step-tab-1'));

    await user.click(screen.getByTestId('builder-panel-new'));
    await user.type(screen.getByTestId('builder-panel-label'), 'Sky whale ride');
    await user.type(screen.getByTestId('builder-panel-prompt'), 'riding a sky-whale at dawn');
    await user.click(screen.getByTestId('builder-panel-add'));

    const custom = await screen.findByTestId('builder-panel-custom');
    expect(custom).toHaveTextContent('Sky whale ride');

    // The custom panel counts: landing on Review auto-prices 5 panels.
    await user.click(screen.getByTestId('builder-step-tab-2'));
    expect(
      await screen.findByRole('button', { name: /Generate 5 panels/ }),
    ).toBeInTheDocument();

    // Removing it takes it back out of the price on the next arrival.
    await user.click(screen.getByTestId('se-confirm-back'));
    await user.click(screen.getByTestId('builder-step-tab-1'));
    await user.click(screen.getByTestId(`builder-panel-remove-${custom.dataset.panelId}`));
    await user.click(screen.getByTestId('builder-step-tab-2'));
    expect(
      await screen.findByRole('button', { name: /Generate 4 panels/ }),
    ).toBeInTheDocument();
    uninstallHost();
  });

  it('the Enhance button exists only inside the custom-panel editor', async () => {
    const user = userEvent.setup();
    renderBuilder();
    await user.click(await screen.findByTestId('builder-step-tab-1'));
    expect(screen.queryByTestId('se-enhance')).not.toBeInTheDocument();

    await user.click(screen.getByTestId('builder-panel-new'));
    expect(await screen.findByTestId('se-enhance')).toBeInTheDocument();
  });
});
