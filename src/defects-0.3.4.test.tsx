// 0.3.4: the defects left open on 0.3.0-0.3.3.
//   1. Delete is disabled while a share is in flight (a late share would
//      re-save the deleted sheet with a live link).
//   2. Deleting a character stops sharing its sheets, and the confirm says so.
//      The sheets themselves stay, as the confirm already says.
//   3. A throttled poll reply (`throttled: true`, a poll the host could not
//      serve) is not an observation: Share, Unlock and Use as reference say
//      Civitai is busy instead of treating the panel as having no image, and an
//      Update shared sheet never drops a panel from the live record.
//   5. A reference portrait keeps the host's `ready` flag (civitai#9189), and
//      one still being checked says so in the editor and the Sheet Builder,
//      before any submit. A run the host accepts with it clears the flag.
//
// Poll replies are scripted per workflow; publish / persist / unlock are
// spies, through a partial mock of @civitai/blocks-react. Everything else runs
// against the SDK mock host and the in-memory document store (test-setup).

import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import type { BlockWorkflowSnapshot } from '@civitai/app-sdk/blocks';

const host = vi.hoisted(() => ({
  replies: new Map<string, unknown[]>(),
  pollCalls: [] as string[],
  publishCalls: [] as unknown[],
  publishGate: null as null | Promise<void>,
  publishIds: [777] as number[],
  persistCalls: [] as unknown[],
  persistResult: null as unknown,
  unlockCalls: [] as unknown[],
}));

vi.mock('@civitai/blocks-react', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@civitai/blocks-react')>();
  return {
    ...mod,
    useBlockToken: () => {
      const real = mod.useBlockToken();
      return { ...real, scopes: [...(real.scopes ?? []), 'apps:storage:publish'] };
    },
    useBuzzWorkflow: () => {
      const real = mod.useBuzzWorkflow();
      return {
        ...real,
        poll: async (workflowId: string) => {
          host.pollCalls.push(workflowId);
          const queue = host.replies.get(workflowId);
          if (!queue || queue.length === 0) return real.poll(workflowId);
          return (queue.length > 1 ? queue.shift() : queue[0]) as BlockWorkflowSnapshot;
        },
      };
    },
    usePublishGenerationOutputs: () => ({
      publish: async (args: unknown) => {
        host.publishCalls.push(args);
        if (host.publishGate) await host.publishGate;
        return [...host.publishIds];
      },
    }),
    usePersistGenerationSource: () => ({
      persist: async (args: unknown) => {
        host.persistCalls.push(args);
        return host.persistResult;
      },
      isPending: false,
      error: null,
    }),
    useOutputUnlock: () => ({
      unlockOutput: async (workflowId: string, position: number) => {
        host.unlockCalls.push([workflowId, position]);
        return { outcome: 'not-restricted' };
      },
    }),
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

const PANEL_URL = 'https://image.example.test/front.png';
const REF_URL = 'https://image.example.test/portrait.jpeg';

const BUSY_SHARE =
  'Civitai is busy right now, so the sheet wasn’t shared. Panels already published are kept. Press Share sheet again in a moment.';
const BUSY_UPDATE =
  'Civitai is busy right now, so the shared sheet wasn’t updated. The link still shows the last version. Press Update shared sheet again in a moment.';
const BUSY_PANEL = 'Civitai is busy right now. Try again in a moment.';
const PORTRAIT_PENDING =
  'Civitai was still checking this portrait when it was added. If a sheet that uses it is refused, wait a minute and run it again.';

const THROTTLED = (workflowId: string) =>
  ({ workflowId, status: 'processing', throttled: true }) as BlockWorkflowSnapshot;
const SUCCEEDED = (workflowId: string, url = PANEL_URL) =>
  ({ workflowId, status: 'succeeded', imageUrls: [url], outputs: [{ url }] }) as unknown as BlockWorkflowSnapshot;

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
    outputs: [PANEL_URL],
    submitNonce: 1,
    ...over,
  };
}

function sheetWith(over: Partial<SheetJob>): SheetJob {
  return {
    id: 'sheet-1',
    name: 'Kaida sheet',
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

interface Spy {
  savedSheets: SheetJob[];
  deletedSheets: string[];
  savedChars: Character[];
  deletedChars: string[];
}

function newSpy(): Spy {
  return { savedSheets: [], deletedSheets: [], savedChars: [], deletedChars: [] };
}

function stubLibrary(spy: Spy, over: Partial<SheetLibrary> = {}): SheetLibrary {
  return {
    ready: true,
    characters: [char],
    stacks: [stack],
    sheets: [],
    settings: DEFAULT_SETTINGS,
    quota: null,
    saveCharacter: async (c) => {
      spy.savedChars.push(c);
      return null;
    },
    deleteCharacter: async (id) => {
      spy.deletedChars.push(id);
      return null;
    },
    saveStack: async () => null,
    deleteStack: async () => null,
    saveSheet: async (s) => {
      spy.savedSheets.push(s);
      return null;
    },
    deleteSheet: async (id) => {
      spy.deletedSheets.push(id);
      return null;
    },
    saveSettings: async () => null,
    refreshQuota: async () => undefined,
    ...over,
  };
}

function renderSheet(sheet: SheetJob, spy: Spy) {
  return render(
    <SheetView
      library={stubLibrary(spy, { sheets: [sheet] })}
      sheetId={sheet.id}
      onBack={() => {}}
      onNewSheet={() => {}}
      onRegenerateSheet={() => {}}
    />,
  );
}

const RECORD = {
  v: 1,
  characterName: 'Kaida',
  sheetName: 'Kaida sheet',
  panels: [
    { label: 'Front view', imageId: 4242 },
    { label: 'Side view', imageId: 4343 },
  ],
};

const shared = () => testDocStore().storage.collection('shared_sheets');

describe('0.3.4 defects', () => {
  let uninstall: (() => void) | undefined;
  afterEach(() => {
    uninstall?.();
    uninstall = undefined;
    host.replies.clear();
    host.pollCalls.length = 0;
    host.publishCalls.length = 0;
    host.publishGate = null;
    host.publishIds = [777];
    host.persistCalls.length = 0;
    host.persistResult = null;
    host.unlockCalls.length = 0;
  });

  // --- 1. delete while a share is in flight -----------------------------------------

  it('1: Delete sheet and Confirm delete are disabled while a share is in flight', async () => {
    uninstall = installMockMoneyHost({ consentGranted: true });
    host.replies.set('wf-a', [SUCCEEDED('wf-a')]);
    let release!: () => void;
    host.publishGate = new Promise<void>((r) => {
      release = r;
    });
    const spy = newSpy();
    renderSheet(sheetWith({}), spy);

    // The confirm is open before the share starts.
    fireEvent.click(await screen.findByTestId('se-sheet-menu', {}, { timeout: 8000 }));
    fireEvent.click(await screen.findByTestId('se-sheet-delete'));
    const confirm = await screen.findByTestId('se-sheet-delete-confirm');

    fireEvent.click(screen.getByTestId('se-share-sheet'));
    await waitFor(() => expect(host.publishCalls).toHaveLength(1), { timeout: 8000 });

    expect(screen.getByTestId('se-sheet-delete-confirm')).toBeDisabled();
    fireEvent.click(confirm);
    fireEvent.click(screen.getByTestId('se-sheet-menu'));
    expect(await screen.findByTestId('se-sheet-delete')).toBeDisabled();

    release();
    await waitFor(() =>
      expect(screen.getByTestId('se-share-notice')).toHaveTextContent('Shared 1 panel. Press Copy link to send it.'),
    );
    // Nothing was deleted while the share ran; afterwards Delete works again.
    expect(spy.deletedSheets).toEqual([]);
    expect(screen.getByTestId('se-sheet-delete-confirm')).toBeEnabled();
  }, 20000);

  it('1: a delete in flight disables Share, and the share does not run', async () => {
    uninstall = installMockMoneyHost({ consentGranted: true });
    host.replies.set('wf-a', [SUCCEEDED('wf-a')]);
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const spy = newSpy();
    const sheet = sheetWith({});
    render(
      <SheetView
        library={stubLibrary(spy, {
          sheets: [sheet],
          deleteSheet: async (id) => {
            await gate;
            spy.deletedSheets.push(id);
            return null;
          },
        })}
        sheetId={sheet.id}
        onBack={() => {}}
        onNewSheet={() => {}}
        onRegenerateSheet={() => {}}
      />,
    );

    fireEvent.click(await screen.findByTestId('se-sheet-menu', {}, { timeout: 8000 }));
    fireEvent.click(await screen.findByTestId('se-sheet-delete'));
    fireEvent.click(await screen.findByTestId('se-sheet-delete-confirm'));
    await waitFor(() => expect(screen.getByTestId('se-share-sheet')).toBeDisabled());
    fireEvent.click(screen.getByTestId('se-share-sheet'));

    release();
    await waitFor(() => expect(spy.deletedSheets).toEqual(['sheet-1']), { timeout: 8000 });
    expect(host.publishCalls).toEqual([]);
    expect(host.pollCalls).toEqual([]);
  }, 20000);

  it('1: a share still running after Back holds off both deletes until it finishes', async () => {
    uninstall = installMockMoneyHost({ consentGranted: true });
    host.replies.set('wf-a', [SUCCEEDED('wf-a')]);
    let release!: () => void;
    host.publishGate = new Promise<void>((r) => {
      release = r;
    });
    const spy = newSpy();
    const sheet = sheetWith({});
    const view = renderSheet(sheet, spy);
    fireEvent.click(await screen.findByTestId('se-share-sheet', {}, { timeout: 8000 }));
    await waitFor(() => expect(host.publishCalls).toHaveLength(1), { timeout: 8000 });
    // Back: the Sheet View goes away, the share keeps running.
    view.unmount();

    // The sheet opened again: Delete is disabled.
    const again = renderSheet(sheet, spy);
    fireEvent.click(await screen.findByTestId('se-sheet-menu', {}, { timeout: 8000 }));
    expect(await screen.findByTestId('se-sheet-delete')).toBeDisabled();
    again.unmount();

    // Deleting the character: Confirm delete is disabled and deletes nothing.
    const user = userEvent.setup();
    render(
      <Characters library={stubLibrary(spy, { sheets: [sheet] })} onBuildSheet={() => {}} onViewSheets={() => {}} />,
    );
    await user.click(screen.getByTestId('char-menu'));
    await user.click(screen.getByTestId('char-menu-delete'));
    const confirm = await screen.findByTestId('char-confirm-delete');
    expect(confirm).toBeDisabled();
    fireEvent.click(confirm);
    expect(spy.deletedChars).toEqual([]);

    // The share finishes: the character can be deleted, and it stops the new link.
    release();
    await waitFor(() => expect(spy.savedSheets.some((s) => s.shareKey)).toBe(true), { timeout: 8000 });
    await waitFor(() => expect(screen.getByTestId('char-confirm-delete')).toBeEnabled());
  }, 25000);

  // --- 2. character delete stops sharing its sheets ---------------------------------

  it('2: deleting a character stops sharing its sheets and the confirm says so', async () => {
    uninstall = installMockMoneyHost({ consentGranted: true });
    const rec = await shared().create(RECORD);
    const spy = newSpy();
    const sheets = [
      sheetWith({ id: 'sheet-1', shareKey: rec.key }),
      sheetWith({ id: 'sheet-2', name: 'Kaida sheet 2' }),
    ];
    const user = userEvent.setup();
    render(
      <Characters library={stubLibrary(spy, { sheets })} onBuildSheet={() => {}} onViewSheets={() => {}} />,
    );

    await user.click(screen.getByTestId('char-menu'));
    await user.click(screen.getByTestId('char-menu-delete'));
    expect(await screen.findByTestId('char-delete-copy')).toHaveTextContent(
      'Deleting Kaida won’t delete their sheets — 2 sheets keep their images, labeled “Unknown character”. ' +
        '1 shared sheet stops being shared: its link stops working. Images you published stay on Civitai.',
    );
    await user.click(screen.getByTestId('char-confirm-delete'));

    await waitFor(() => expect(spy.deletedChars).toEqual(['char-1']), { timeout: 8000 });
    expect(await shared().get(rec.key)).toBeNull();
    // The sheet that was shared is saved without its key; the other is untouched.
    expect(spy.savedSheets.map((s) => s.id)).toEqual(['sheet-1']);
    expect('shareKey' in spy.savedSheets[0]).toBe(false);
  }, 20000);

  it('2: a share link that cannot be stopped keeps the character', async () => {
    uninstall = installMockMoneyHost({ consentGranted: true });
    // Another author's record: this viewer's delete is refused (write: own).
    const theirs = await testDocStore()
      .as({ viewer: { username: 'someone-else' } })
      .storage.collection('shared_sheets')
      .create(RECORD);
    const spy = newSpy();
    const user = userEvent.setup();
    render(
      <Characters
        library={stubLibrary(spy, { sheets: [sheetWith({ shareKey: theirs.key })] })}
        onBuildSheet={() => {}}
        onViewSheets={() => {}}
      />,
    );

    await user.click(screen.getByTestId('char-menu'));
    await user.click(screen.getByTestId('char-menu-delete'));
    await user.click(await screen.findByTestId('char-confirm-delete'));

    expect(
      await screen.findByText(
        'Couldn’t stop sharing Kaida’s sheets, so Kaida was kept. Try again.',
        {},
        { timeout: 8000 },
      ),
    ).toBeInTheDocument();
    expect(spy.deletedChars).toEqual([]);
    expect(await shared().get(theirs.key)).not.toBeNull();
  }, 20000);

  it('2: a character with no shared sheets keeps the old confirm copy', async () => {
    uninstall = installMockMoneyHost({ consentGranted: true });
    const spy = newSpy();
    const user = userEvent.setup();
    render(
      <Characters library={stubLibrary(spy, { sheets: [sheetWith({})] })} onBuildSheet={() => {}} onViewSheets={() => {}} />,
    );
    await user.click(screen.getByTestId('char-menu'));
    await user.click(screen.getByTestId('char-menu-delete'));
    expect(await screen.findByTestId('char-delete-copy')).toHaveTextContent(
      'Deleting Kaida won’t delete their sheets — 1 sheet keep their images, labeled “Unknown character”.',
    );
    expect(screen.getByTestId('char-delete-copy')).not.toHaveTextContent('shared');
  }, 20000);

  // --- 3. a throttled poll is not "no image" ------------------------------------------

  it('3: Share with a throttled poll says Civitai is busy and publishes nothing', async () => {
    uninstall = installMockMoneyHost({ consentGranted: true });
    host.replies.set('wf-a', [THROTTLED('wf-a')]);
    const spy = newSpy();
    renderSheet(sheetWith({}), spy);

    fireEvent.click(await screen.findByTestId('se-share-sheet', {}, { timeout: 8000 }));
    await waitFor(() => expect(screen.getByTestId('se-share-notice')).toHaveTextContent(BUSY_SHARE), {
      timeout: 8000,
    });
    expect(host.publishCalls).toEqual([]);
    expect(spy.savedSheets.some((s) => s.shareKey)).toBe(false);
  }, 20000);

  it('3: Update shared sheet with a throttled poll keeps every panel on the live record', async () => {
    uninstall = installMockMoneyHost({ consentGranted: true });
    const rec = await shared().create(RECORD);
    host.replies.set('wf-b', [THROTTLED('wf-b')]);
    const spy = newSpy();
    renderSheet(
      sheetWith({
        shareKey: rec.key,
        panels: [
          panel({ id: 'p1', publishedImageId: 4242, published: true }),
          // Re-generated since the last share: not published yet, so Share polls it.
          panel({ id: 'p2', label: 'Side view', workflowId: 'wf-b' }),
        ],
      }),
      spy,
    );

    fireEvent.click(await screen.findByTestId('se-share-sheet', {}, { timeout: 8000 }));
    await waitFor(() => expect(screen.getByTestId('se-share-notice')).toHaveTextContent(BUSY_UPDATE), {
      timeout: 8000,
    });
    expect((await shared().get(rec.key))?.data).toEqual(RECORD);
    expect(host.publishCalls).toEqual([]);
  }, 20000);

  it('3: Use as reference with a throttled poll says Civitai is busy, not "no image"', async () => {
    uninstall = installMockMoneyHost({ consentGranted: true });
    host.replies.set('wf-a', [THROTTLED('wf-a')]);
    renderSheet(sheetWith({}), newSpy());

    fireEvent.click(await screen.findByTestId('se-panel-more', {}, { timeout: 8000 }));
    fireEvent.click(await screen.findByRole('button', { name: 'Use as reference' }));
    expect(await screen.findByTestId('se-panel-notice', {}, { timeout: 8000 })).toHaveTextContent(BUSY_PANEL);
    expect(host.persistCalls).toEqual([]);
  }, 20000);

  it('3: Unlock with a throttled poll says Civitai is busy and keeps the lock', async () => {
    uninstall = installMockMoneyHost({ consentGranted: true });
    host.replies.set('wf-a', [THROTTLED('wf-a')]);
    const spy = newSpy();
    renderSheet(sheetWith({ panels: [panel({ outputs: [], locked: 'pool' })] }), spy);

    fireEvent.click(await screen.findByRole('button', { name: 'Unlock with Yellow Buzz' }, { timeout: 8000 }));
    expect(await screen.findByTestId('se-panel-notice', {}, { timeout: 8000 })).toHaveTextContent(BUSY_PANEL);
    expect(host.unlockCalls).toEqual([]);
    expect(screen.getByTestId('se-panel-locked')).toBeInTheDocument();
  }, 20000);

  // --- 5. the portrait's scan state -----------------------------------------------------

  async function uploadPortrait(upload: Record<string, unknown>, spy: Spy) {
    uninstall = installMockMoneyHost({ consentGranted: true, cannedGenerationSourceUpload: upload as never });
    const user = userEvent.setup();
    render(
      <Characters
        library={stubLibrary(spy, { characters: [] })}
        onBuildSheet={() => {}}
        onViewSheets={() => {}}
        initialEditor={{ mode: 'create' }}
      />,
    );
    const nameInput = await screen.findByTestId('char-name');
    await user.clear(nameInput);
    await user.type(nameInput, 'Mira');
    // name -> prompts -> traits -> triggers -> portrait
    for (let i = 0; i < 4; i += 1) await user.click(screen.getByTestId('char-step-next'));
    await user.click(screen.getByRole('button', { name: 'Upload portrait' }));
    await screen.findByRole('img', { name: 'Reference portrait' }, { timeout: 8000 });
    return user;
  }

  it('5: an upload still being checked says so in the editor and is saved with ready: false', async () => {
    const spy = newSpy();
    const user = await uploadPortrait({ url: REF_URL, width: 640, height: 960, imageId: 9, ready: false }, spy);

    expect(screen.getByTestId('char-portrait-pending')).toHaveTextContent(PORTRAIT_PENDING);
    await user.click(screen.getByTestId('char-step-next'));
    await user.click(screen.getByTestId('char-save'));
    await waitFor(() => expect(spy.savedChars).toHaveLength(1));
    expect(spy.savedChars[0].referenceImage).toEqual({ url: REF_URL, width: 640, height: 960, ready: false });
  }, 20000);

  it('5: a checked upload shows no pending note and is saved with ready: true', async () => {
    const spy = newSpy();
    const user = await uploadPortrait({ url: REF_URL, width: 640, height: 960, imageId: 9, ready: true }, spy);

    expect(screen.queryByTestId('char-portrait-pending')).toBeNull();
    await user.click(screen.getByTestId('char-step-next'));
    await user.click(screen.getByTestId('char-save'));
    await waitFor(() => expect(spy.savedChars).toHaveLength(1));
    expect(spy.savedChars[0].referenceImage).toEqual({ url: REF_URL, width: 640, height: 960, ready: true });
  }, 20000);

  it('5: Use as reference keeps ready: false from the host', async () => {
    uninstall = installMockMoneyHost({ consentGranted: true });
    host.replies.set('wf-a', [SUCCEEDED('wf-a')]);
    host.persistResult = { url: REF_URL, width: 640, height: 960, imageId: 5, ready: false };
    const spy = newSpy();
    renderSheet(sheetWith({}), spy);

    fireEvent.click(await screen.findByTestId('se-panel-more', {}, { timeout: 8000 }));
    fireEvent.click(await screen.findByRole('button', { name: 'Use as reference' }));
    await waitFor(() => expect(spy.savedChars).toHaveLength(1), { timeout: 8000 });
    expect(spy.savedChars[0].referenceImage).toEqual({ url: REF_URL, width: 640, height: 960, ready: false });
  }, 20000);

  it('5: the Sheet Builder shows a pending portrait up front; an accepted run clears it and sends only url/width/height', async () => {
    const bodies: unknown[] = [];
    uninstall = installMockMoneyHost({
      consentGranted: true,
      onOutbound: (msg) => {
        if (msg.type === 'SUBMIT_WORKFLOW') bodies.push((msg.payload as { body?: unknown }).body);
      },
    });
    const spy = newSpy();
    const pending: Character = {
      ...char,
      referenceImage: { url: REF_URL, width: 640, height: 960, ready: false },
    };
    const user = userEvent.setup();
    render(
      <SheetBuilder
        library={stubLibrary(spy, { characters: [pending] })}
        preselectedCharacterId="char-1"
        onOpenSheet={() => {}}
        onCreateStack={() => {}}
        onCreateCharacter={() => {}}
      />,
    );
    await screen.findByTestId('builder-stack-card');
    // Review prices itself on arrival; the portrait toggle is one step back.
    await user.click(screen.getByTestId('builder-step-tab-2'));
    await screen.findByRole('button', { name: /^Generate \d+ panels/ }, { timeout: 8000 });
    // Not using the portrait: the confirm says nothing about it.
    expect(screen.queryByTestId('sb-portrait-pending')).toBeNull();
    await user.click(screen.getByTestId('se-confirm-back'));
    expect(await screen.findByTestId('sb-portrait-pending')).toHaveTextContent(PORTRAIT_PENDING);

    await user.click(screen.getByRole('checkbox', { name: 'Use reference portrait as img2img source' }));
    // The toggle changes the priced inputs, so Review re-prices by itself.
    const generate = await screen.findByRole('button', { name: /^Generate \d+ panels/ }, { timeout: 8000 });
    // Using it: the confirm says so before anything is submitted.
    expect(screen.getByTestId('sb-portrait-pending')).toHaveTextContent(PORTRAIT_PENDING);
    expect(bodies).toEqual([]);
    await user.click(generate);

    await waitFor(() => expect(spy.savedChars).toHaveLength(1), { timeout: 10000 });
    expect(spy.savedChars[0].referenceImage).toEqual({ url: REF_URL, width: 640, height: 960, ready: true });
    expect(bodies.length).toBeGreaterThan(0);
    for (const b of bodies) {
      expect((b as { sourceImages?: unknown }).sourceImages).toEqual([{ url: REF_URL, width: 640, height: 960 }]);
    }
  }, 30000);

  it('5: a run the host refuses keeps the portrait pending', async () => {
    let submits = 0;
    uninstall = installMockMoneyHost({
      consentGranted: true,
      generation: { failSubmitException: true, failSubmitExceptionMessage: 'source-scan-pending' },
      onOutbound: (msg) => {
        if (msg.type === 'SUBMIT_WORKFLOW') submits += 1;
      },
    });
    const spy = newSpy();
    const pending: Character = {
      ...char,
      referenceImage: { url: REF_URL, width: 640, height: 960, ready: false },
    };
    const user = userEvent.setup();
    render(
      <SheetBuilder
        library={stubLibrary(spy, { characters: [pending] })}
        preselectedCharacterId="char-1"
        onOpenSheet={() => {}}
        onCreateStack={() => {}}
        onCreateCharacter={() => {}}
      />,
    );
    await screen.findByTestId('builder-stack-card');
    await user.click(screen.getByTestId('builder-step-tab-2'));
    await screen.findByRole('button', { name: /^Generate \d+ panels/ }, { timeout: 8000 });
    await user.click(screen.getByTestId('se-confirm-back'));
    await user.click(await screen.findByRole('checkbox', { name: 'Use reference portrait as img2img source' }));
    const generate = await screen.findByRole('button', { name: /^Generate (\d+) panels/ }, { timeout: 8000 });
    const panels = Number(/Generate (\d+) panels/.exec(generate.textContent ?? '')?.[1]);
    await user.click(generate);

    // Every panel was submitted and refused; the final sheet save has run.
    await waitFor(() => expect(spy.savedSheets.at(-1)?.status).toBe('failed'), { timeout: 10000 });
    expect(submits).toBe(panels);
    expect(spy.savedSheets.at(-1)?.panels.every((p) => !p.workflowId)).toBe(true);
    expect(spy.savedChars).toEqual([]);
  }, 30000);
});
