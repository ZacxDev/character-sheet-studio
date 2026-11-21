// Leftovers from the 0.3.4 / 0.3.5 audits (PRs #9 and #10):
//   1. A sheet delete stops the sheet's share link first. If the delete then
//      fails, the error says the link was already stopped (as #10 does for a
//      character delete).
//   2. A throw while building an Enhance request (the Builder's panel editor
//      and the character editor) is handled like a run that returned nothing:
//      the notice shows and the Enhance button is usable again, instead of
//      staying on "Enhancing…".
//   3. Confirm delete on a character stays on screen while its sheets' share
//      links are stopped, so its busy spinner is visible. (A character with
//      no shared sheets leaves the screen at once: the library removes it
//      before it awaits the store.)
// The store is the SDK fake over the committed manifest (test-setup).

import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const enhance = vi.hoisted(() => ({ throwOnBuild: false }));

vi.mock('./sheet/enhance.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('./sheet/enhance.js')>();
  return {
    ...mod,
    buildEnhanceBody: (...args: Parameters<typeof mod.buildEnhanceBody>) => {
      if (enhance.throwOnBuild) throw new Error('body build failed');
      return mod.buildEnhanceBody(...args);
    },
    buildCharacterPromptEnhanceBody: (
      ...args: Parameters<typeof mod.buildCharacterPromptEnhanceBody>
    ) => {
      if (enhance.throwOnBuild) throw new Error('body build failed');
      return mod.buildCharacterPromptEnhanceBody(...args);
    },
  };
});

import { installMockMoneyHost } from './mock-buzz.js';
import { Characters } from './screens/Characters.js';
import { SheetBuilder } from './screens/SheetBuilder.js';
import { SheetView } from './screens/SheetView.js';
import {
  DEFAULT_SETTINGS,
  type Character,
  type ModelStack,
  type SheetJob,
  type SheetPanel,
} from './sheet/types.js';
import type { SheetLibrary } from './sheet/useSheetLibrary.js';
import { testDocStore } from './test-doc-store.js';

const char: Character = {
  id: 'char-1',
  name: 'Kaida',
  description: 'A cyberpunk street samurai',
  traits: ['neon-blue undercut hair'],
  triggerWords: ['kaida_cyber'],
  negativePrompt: 'blurry',
  seedPolicy: 'locked',
  createdAt: '2026-10-01T22:00:00.000Z',
  updatedAt: '2026-10-01T22:00:00.000Z',
};

const stack: ModelStack = {
  id: 'stack-1',
  name: 'SDXL Anime',
  checkpoint: { modelId: 101055, modelVersionId: 128078, baseModel: 'SDXL 1.0', name: 'SDXL 1.0' },
  loras: [],
  notes: '',
  createdAt: '2026-10-01T22:00:00.000Z',
  updatedAt: '2026-10-01T22:00:00.000Z',
};

function panel(over: Partial<SheetPanel>): SheetPanel {
  return {
    id: 'p1',
    kind: 'front',
    label: 'Front view',
    promptModifier: 'front view',
    seed: 42,
    status: 'done',
    workflowId: 'wf-a',
    outputs: ['https://image.example.test/front.png'],
    submitNonce: 1,
    ...over,
  };
}

function sheetWith(over: Partial<SheetJob>): SheetJob {
  return {
    id: 'sheet-1',
    name: 'Front set',
    characterId: 'char-1',
    stackId: 'stack-1',
    seed: 42,
    account: 'auto',
    useReference: false,
    status: 'complete',
    panels: [panel({})],
    createdAt: '2026-10-01T22:00:00.000Z',
    updatedAt: '2026-10-01T22:00:00.000Z',
    ...over,
  };
}

function stubLibrary(over: Partial<SheetLibrary> = {}): SheetLibrary {
  return {
    ready: true,
    characters: [char],
    stacks: [stack],
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

const RECORD = {
  v: 1,
  characterName: 'Kaida',
  sheetName: 'Front set',
  panels: [{ label: 'Front view', imageId: 4242 }],
};

const shared = () => testDocStore().storage.collection('shared_sheets');

async function confirmSheetDelete() {
  fireEvent.click(await screen.findByTestId('se-sheet-menu', {}, { timeout: 8000 }));
  fireEvent.click(await screen.findByTestId('se-sheet-delete'));
  fireEvent.click(await screen.findByTestId('se-sheet-delete-confirm'));
}

describe('0.3.4 / 0.3.5 audit leftovers', () => {
  let uninstall: (() => void) | undefined;
  afterEach(() => {
    uninstall?.();
    uninstall = undefined;
    enhance.throwOnBuild = false;
  });

  // --- 1. sheet delete fails after its share link was stopped --------------------------

  it('1: a failed sheet delete says the share link was already stopped', async () => {
    uninstall = installMockMoneyHost({ consentGranted: true });
    const rec = await shared().create(RECORD);
    const deleted: string[] = [];
    const sheet = sheetWith({ shareKey: rec.key });
    const onBack = vi.fn();
    render(
      <SheetView
        library={stubLibrary({
          sheets: [sheet],
          deleteSheet: async (id) => {
            deleted.push(id);
            return 'request-failed';
          },
        })}
        sheetId={sheet.id}
        onBack={onBack}
        onNewSheet={() => {}}
        onRegenerateSheet={() => {}}
      />,
    );
    await confirmSheetDelete();

    expect(
      await screen.findByText(
        '“Front set” wasn’t deleted. Saving failed — the connection dropped. Your changes are still on screen; try again. ' +
          'Its share link was already stopped; press Update shared sheet to share it again if you want it public.',
        {},
        { timeout: 8000 },
      ),
    ).toBeInTheDocument();
    expect(deleted).toEqual(['sheet-1']);
    expect(await shared().get(rec.key)).toBeNull();
    expect(onBack).not.toHaveBeenCalled();
  }, 20000);

  it('1: a failed delete of a sheet that was never shared keeps the plain storage error', async () => {
    uninstall = installMockMoneyHost({ consentGranted: true });
    const sheet = sheetWith({});
    render(
      <SheetView
        library={stubLibrary({ sheets: [sheet], deleteSheet: async () => 'request-failed' })}
        sheetId={sheet.id}
        onBack={() => {}}
        onNewSheet={() => {}}
        onRegenerateSheet={() => {}}
      />,
    );
    await confirmSheetDelete();

    expect(
      await screen.findByText(
        'Saving failed — the connection dropped. Your changes are still on screen; try again.',
        {},
        { timeout: 8000 },
      ),
    ).toBeInTheDocument();
  }, 20000);

  // --- 2. a throw while building the Enhance request ----------------------------------

  it('2: a throw while building the Enhance request shows the notice and frees the button', async () => {
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
    await user.click(await screen.findByTestId('builder-step-tab-1'));
    for (const card of screen.getAllByTestId('builder-panel-card')) {
      if (card.dataset.selected === 'true') await user.click(card);
    }
    await user.click(screen.getByTestId('builder-panel-new'));
    await user.type(screen.getByTestId('builder-panel-label'), 'Sky whale ride');
    await user.type(screen.getByTestId('builder-panel-prompt'), 'riding a sky-whale at dawn');

    // Pricing builds the body too, so the throw is armed only for the submit.
    await user.click(await screen.findByTestId('se-enhance'));
    await screen.findByTestId('se-enhance-confirm');
    enhance.throwOnBuild = true;
    await user.click(screen.getByTestId('se-enhance-confirm-run'));

    expect(await screen.findByTestId('se-enhance-notice', {}, { timeout: 8000 })).toHaveTextContent(
      'The enhancement didn’t come back — your prompt is unchanged.',
    );
    const button = screen.getByTestId('se-enhance');
    expect(button).not.toHaveAttribute('aria-busy');
    expect(button).toBeEnabled();
    expect(button).toHaveTextContent('Enhance prompt ✦');
  }, 20000);

  it('2: a throw while building the character-editor Enhance request shows the notice and frees the button', async () => {
    uninstall = installMockMoneyHost({});
    const user = userEvent.setup();
    render(<Characters library={stubLibrary()} onBuildSheet={() => {}} onViewSheets={() => {}} />);
    await user.click(screen.getByRole('button', { name: 'New character' }));
    await user.type(screen.getByTestId('char-name'), 'Nyx');
    await user.click(screen.getByTestId('char-step-next'));
    await user.type(screen.getByTestId('char-positive-prompt'), 'a cyberpunk fox mercenary');

    // Pricing builds the body too, so the throw is armed only for the submit.
    await user.click(screen.getByTestId('char-enhance-positive'));
    await screen.findByTestId('char-enhance-confirm');
    enhance.throwOnBuild = true;
    await user.click(screen.getByTestId('char-enhance-confirm-run'));

    expect(await screen.findByTestId('char-enhance-notice', {}, { timeout: 8000 })).toHaveTextContent(
      'The enhancement didn’t come back — your prompt is unchanged.',
    );
    const button = screen.getByTestId('char-enhance-positive');
    expect(button).not.toHaveAttribute('aria-busy');
    expect(button).toBeEnabled();
    expect(button).toHaveTextContent('Enhance ✦');
  }, 20000);

  // --- 3. the character-delete spinner --------------------------------------------------

  // The visible wait is the share-link stop: the real library's deleteCharacter
  // removes the character from screen before it awaits the store, so a
  // character with no shared sheets is gone at once. The gate is the sheet
  // save that follows each stopped link, as in useSheetLibrary.
  it('3: Confirm delete stays visible and busy while the share links are stopped', async () => {
    uninstall = installMockMoneyHost({ consentGranted: true });
    const rec = await shared().create(RECORD);
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const deletedChars: string[] = [];
    const savedSheets: SheetJob[] = [];
    const user = userEvent.setup();
    render(
      <Characters
        library={stubLibrary({
          sheets: [sheetWith({ shareKey: rec.key })],
          saveSheet: async (s) => {
            await gate;
            savedSheets.push(s);
            return null;
          },
          deleteCharacter: async (id) => {
            deletedChars.push(id);
            return null;
          },
        })}
        onBuildSheet={() => {}}
        onViewSheets={() => {}}
      />,
    );
    await user.click(screen.getByTestId('char-menu'));
    await user.click(screen.getByTestId('char-menu-delete'));
    await user.click(await screen.findByTestId('char-confirm-delete'));

    // The link is stopped and its sheet save is in flight: the button is still
    // there, busy, with its spinner.
    await waitFor(async () => expect(await shared().get(rec.key)).toBeNull(), { timeout: 8000 });
    const confirm = await screen.findByTestId('char-confirm-delete');
    expect(confirm).toBeVisible();
    expect(confirm).toHaveAttribute('aria-busy', 'true');
    expect(confirm).toBeDisabled();
    // The Button's Loader is aria-hidden (the button's aria-busy carries the
    // state for assistive tech), so it is found with hidden: true.
    expect(within(confirm).getByRole('status', { hidden: true })).toBeVisible();
    expect(savedSheets).toEqual([]);
    expect(deletedChars).toEqual([]);

    release();
    await waitFor(() => expect(deletedChars).toEqual(['char-1']), { timeout: 8000 });
    expect(savedSheets.map((s) => s.id)).toEqual(['sheet-1']);
    await waitFor(() => expect(screen.queryByTestId('char-confirm-delete')).not.toBeInTheDocument());
  }, 20000);
});
