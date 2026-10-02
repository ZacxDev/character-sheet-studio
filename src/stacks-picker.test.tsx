import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
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
        onCreateCharacter={() => {}}
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
        onCreateCharacter={() => {}}
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

  it('character card → Sheets (1) lands on the filtered list with a preview thumbnail', async () => {
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
    await screen.findByText('Character Sheet Studio');

    const viewSheets = await screen.findByTestId('char-view-sheets');
    expect(viewSheets).toHaveTextContent('Sheets (1)');
    await user.click(viewSheets);

    // Filtered to Kaida, with the generated image as the card preview.
    await screen.findByText(/Sheets for/);
    expect(screen.getByText('Kaida')).toBeInTheDocument();
    expect(await screen.findByTestId('sheet-card-thumb')).toHaveAttribute(
      'src',
      'https://example.com/front.png',
    );
    expect(screen.getByText('Kaida sheet')).toBeInTheDocument();

    // Show all clears the drill-in.
    await user.click(screen.getByRole('button', { name: 'Show all' }));
    await waitFor(() => expect(screen.queryByText(/Sheets for/)).not.toBeInTheDocument());
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
                  outputs: [],
                  submitNonce: 1,
                },
              ],
            },
          ],
        })}
        sheetId="sheet-1"
        onBack={() => {}}
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
    await screen.findByText('Character Sheet Studio');

    // Drill in from the character card (2 sheets).
    const viewSheets = await screen.findByTestId('char-view-sheets');
    expect(viewSheets).toHaveTextContent('Sheets (2)');
    await user.click(viewSheets);

    // Human labels, not raw statuses.
    expect(await screen.findByText('Partially done')).toBeInTheDocument();
    expect(screen.getByText('Not started')).toBeInTheDocument();
    expect(screen.queryByText('paused')).not.toBeInTheDocument();
    expect(screen.queryByText('draft')).not.toBeInTheDocument();

    // Open the paused sheet — header uses the same human label.
    const openBtns = await screen.findAllByRole('button', { name: 'Open' });
    const pausedRow = openBtns.find((b) =>
      b.closest('[data-civitai-ui="card"]')?.textContent?.includes('Paused sheet'),
    );
    await user.click(pausedRow ?? openBtns[0]);
    await screen.findByText('Paused sheet');
    expect(screen.getAllByText('Partially done').length).toBeGreaterThan(0);

    // Clicking the already-active Sheets tab returns to the list.
    await user.click(screen.getByRole('tab', { name: 'Sheets' }));
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
      />,
    );

    // Human label in the header, batch CTA counts the queued panels.
    expect(await screen.findByText('Not started')).toBeInTheDocument();
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
    await waitFor(() => expect(screen.getAllByText('Done')).toHaveLength(2), {
      timeout: 15000,
    });
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
    await user.click(screen.getByRole('button', { name: 'Delete' }));
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
