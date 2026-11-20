// No document-store client (no token or host origin for this viewer) on the
// share paths: the shared view must say so instead of spinning forever, and
// Share sheet must say why nothing happened. (0.3.0's review: both were silent.)

import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

vi.mock('./sheet/doc-storage.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('./sheet/doc-storage.js')>();
  return { ...mod, useDocumentStorage: () => null };
});

import { installMockMoneyHost } from './mock-buzz.js';
import { SharedSheetView } from './screens/SharedSheetView.js';
import { SheetView } from './screens/SheetView.js';
import { DEFAULT_SETTINGS, type SheetJob } from './sheet/types.js';
import type { SheetLibrary } from './sheet/useSheetLibrary.js';

const sheet: SheetJob = {
  id: 'sheet-1',
  name: 'Morov turnaround',
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
      workflowId: 'wf-1',
      outputs: ['https://image.example.test/front.png'],
      submitNonce: 1,
    },
  ],
  createdAt: '2026-10-01T22:00:00.000Z',
  updatedAt: '2026-10-01T22:00:00.000Z',
};

const library: SheetLibrary = {
  ready: true,
  characters: [],
  stacks: [],
  sheets: [sheet],
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
};

describe('share paths with no storage client', () => {
  let uninstall: (() => void) | undefined;
  afterEach(() => {
    uninstall?.();
    uninstall = undefined;
  });

  it('the shared view says it cannot open the sheet, not "Loading"', async () => {
    uninstall = installMockMoneyHost({ consentGranted: true });
    render(<SharedSheetView shareKey="k1" onGallery={() => {}} />);
    expect(await screen.findByTestId('ss-no-client', {}, { timeout: 8000 })).toHaveTextContent(
      'This shared sheet can’t be opened here right now.',
    );
    expect(screen.queryByText('Loading the shared sheet…')).toBeNull();
  }, 15000);

  it('before the host initialises it still shows Loading, not the no-client message', async () => {
    // No mock host: BLOCK_INIT never arrives, so the block is not ready.
    render(<SharedSheetView shareKey="k1" onGallery={() => {}} />);
    expect(await screen.findByText('Loading the shared sheet…')).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 300));
    expect(screen.queryByTestId('ss-no-client')).toBeNull();
  });

  // The token carries no apps:storage:publish here, so this also pins that the
  // missing client is reported BEFORE the consent prompt.
  it('Share sheet says why nothing happened', async () => {
    uninstall = installMockMoneyHost({ consentGranted: true });
    render(
      <SheetView
        library={library}
        sheetId="sheet-1"
        onBack={() => {}}
        onNewSheet={() => {}}
        onRegenerateSheet={() => {}}
      />,
    );
    fireEvent.click(await screen.findByTestId('se-share-sheet', {}, { timeout: 8000 }));
    expect(await screen.findByTestId('se-share-notice')).toHaveTextContent(
      'Sharing isn’t available right now. Reload the app and try again.',
    );
  }, 15000);
});
