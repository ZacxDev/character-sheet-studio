import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { CharacterView } from './screens/CharacterView.js';
import { SheetBuilder } from './screens/SheetBuilder.js';
import { installMockMoneyHost } from './mock-buzz.js';
import {
  DEFAULT_SETTINGS,
  defaultPanelSpecs,
  type Character,
  type ModelStack,
  type SheetJob,
} from './sheet/types.js';
import type { SheetLibrary } from './sheet/useSheetLibrary.js';

const kaida: Character = {
  id: 'char-1',
  name: 'Kaida',
  description: 'A cyberpunk street samurai',
  traits: ['neon-blue undercut hair'],
  triggerWords: ['kaida_cyber'],
  negativePrompt: '',
  seedPolicy: 'locked',
  createdAt: '2026-10-01T22:00:00.000Z',
  updatedAt: '2026-10-01T22:00:00.000Z',
};

const mira: Character = {
  ...kaida,
  id: 'char-2',
  name: 'Mira',
  description: 'A wandering healer',
  triggerWords: ['mira_heal'],
};

const stackA: ModelStack = {
  id: 'stack-1',
  name: 'Stack A',
  checkpoint: { modelId: 101055, modelVersionId: 128078, baseModel: 'SDXL 1.0', name: 'SDXL 1.0' },
  loras: [],
  notes: '',
  createdAt: '2026-10-01T22:00:00.000Z',
  updatedAt: '2026-10-01T22:00:00.000Z',
};

const stackB: ModelStack = { ...stackA, id: 'stack-2', name: 'Stack B' };

function stubLibrary(over: Partial<SheetLibrary> = {}): SheetLibrary {
  return {
    ready: true,
    characters: [kaida, mira],
    stacks: [stackA, stackB],
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

const frontSpec = defaultPanelSpecs().find((s) => s.kind === 'front')!;

const kaidaSheet: SheetJob = {
  id: 'sheet-1',
  name: 'Kaida sheet',
  characterId: 'char-1',
  stackId: 'stack-2',
  seed: 42,
  account: 'auto',
  useReference: false,
  status: 'complete',
  panels: [
    {
      id: 'p1',
      kind: 'front',
      label: 'Front view',
      promptModifier: frontSpec.promptModifier,
      seed: 42,
      status: 'done',
      outputs: ['https://example.com/front.png'],
      submitNonce: 1,
    },
    {
      id: 'p2',
      kind: 'front',
      label: 'Hero front',
      promptModifier: 'dramatic low-angle hero framing, wind in the hair',
      seed: 42,
      status: 'done',
      outputs: ['https://example.com/hero.png'],
      submitNonce: 1,
    },
  ],
  createdAt: '2026-10-02T22:00:00.000Z',
  updatedAt: '2026-10-02T22:00:00.000Z',
};

describe('Character page', () => {
  let uninstall: (() => void) | undefined;
  afterEach(() => {
    uninstall?.();
    uninstall = undefined;
  });

  it('shows the character and every sheet with a carousel — and no status badge', async () => {
    const onNewSheet = vi.fn();
    render(
      <CharacterView
        library={stubLibrary({ sheets: [kaidaSheet] })}
        characterId="char-1"
        onBack={() => {}}
        onEdit={() => {}}
        onNewSheet={onNewSheet}
        onOpenSheet={() => {}}
        onRunSheet={() => {}}
      />,
    );

    expect(screen.getByRole('heading', { name: 'Kaida' })).toBeInTheDocument();
    expect(screen.getByText('Kaida sheet')).toBeInTheDocument();
    const thumbs = screen.getAllByTestId('char-view-thumb');
    expect(thumbs.map((t) => t.getAttribute('src'))).toEqual([
      'https://example.com/front.png',
      'https://example.com/hero.png',
    ]);
    // Status badges are gone from this page — counts speak instead.
    expect(screen.queryByText('Complete')).not.toBeInTheDocument();
    expect(screen.getByText(/2\/2 panels generated/)).toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(screen.getByTestId('char-view-new-sheet'));
    expect(onNewSheet).toHaveBeenCalledTimes(1);
  });

  it('runs a sheet on any character picked in the row', async () => {
    const onRunSheet = vi.fn();
    render(
      <CharacterView
        library={stubLibrary({ sheets: [kaidaSheet] })}
        characterId="char-1"
        onBack={() => {}}
        onEdit={() => {}}
        onNewSheet={() => {}}
        onOpenSheet={() => {}}
        onRunSheet={onRunSheet}
      />,
    );

    const user = userEvent.setup();
    await user.selectOptions(screen.getByTestId('char-view-run-for'), 'char-2');
    await user.click(screen.getByTestId('char-view-run'));
    expect(onRunSheet).toHaveBeenCalledWith('char-2', 'sheet-1');
  });

  it('Builder seeded from a sheet adopts its stack and panel setup', async () => {
    uninstall = installMockMoneyHost({});
    render(
      <SheetBuilder
        library={stubLibrary({ sheets: [kaidaSheet] })}
        preselectedCharacterId="char-2"
        seedSheetId="sheet-1"
        onOpenSheet={() => {}}
        onCreateStack={() => {}}
        onCreateCharacter={() => {}}
      />,
    );

    // The sheet's stack (B), not the first stack, is selected.
    const stackCards = await screen.findAllByTestId('builder-stack-card');
    const selected = stackCards.find((c) => c.dataset.selected === 'true');
    expect(selected?.textContent).toContain('Stack B');

    // One panel matched the default Front spec; the other returns as a
    // selected custom panel with its own label — 2 panels priced in total.
    expect(await screen.findByText('Hero front')).toBeInTheDocument();
    expect(
      await screen.findByRole('button', { name: /Price 2 panels/ }),
    ).toBeInTheDocument();
  });
});
