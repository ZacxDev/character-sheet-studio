import { afterEach, describe, expect, it } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { installMockMoneyHost, type MockMoneyHostOptions } from './mock-buzz.js';
import { SheetBuilder } from './screens/SheetBuilder.js';
import { SheetView } from './screens/SheetView.js';
import {
  DEFAULT_SETTINGS,
  type Character,
  type ModelStack,
  type SheetJob,
} from './sheet/types.js';
import type { SheetLibrary } from './sheet/useSheetLibrary.js';

// Feedback #189 (v0.2.0): "can't get past pricing and can't see if i did
// something wrong". Every state that stops the viewer at the Review/pricing
// step must say WHY, in app-owned copy — never the raw server text (which is
// unsanitised and may carry internals) and never a bare count.
//
// Driven through the real SDK transport against the mock host. The server
// messages below are the literal strings `blocks.estimateWorkflow` throws on
// civitai/civitai main (resolvePageLoraGates / assertViewerCanGeneratePageResources)
// plus the orchestrator's ecosystem validation failure seen in another app's report.

const char: Character = {
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

const stack: ModelStack = {
  id: 'stack-1',
  name: 'Zeta Stack',
  checkpoint: { modelId: 101055, modelVersionId: 128078, baseModel: 'SDXL 1.0', name: 'SDXL 1.0' },
  loras: [],
  notes: '',
  createdAt: '2026-10-01T22:00:00.000Z',
  updatedAt: '2026-10-01T22:00:00.000Z',
};

function library(sheets: SheetJob[] = []): SheetLibrary {
  return {
    ready: true,
    characters: [char],
    stacks: [stack],
    sheets,
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
}

let uninstall: (() => void) | undefined;
afterEach(() => {
  uninstall?.();
  uninstall = undefined;
});

/**
 * The mock host replaces `window.parent` with an object whose `postMessage`
 * handles outbound block messages. `swallow` drops the named types before the
 * mock sees them — i.e. the host never answers.
 */
function swallowOutbound(type: string): { count: () => number } {
  let n = 0;
  const parent = window.parent as unknown as { postMessage: (msg: unknown, ...rest: unknown[]) => void };
  const orig = parent.postMessage.bind(parent);
  parent.postMessage = (msg: unknown, ...rest: unknown[]) => {
    if ((msg as { type?: string } | null)?.type === type) {
      n += 1;
      return;
    }
    orig(msg, ...rest);
  };
  return { count: () => n };
}

async function openReview(options: MockMoneyHostOptions, beforeRender?: () => void) {
  uninstall = installMockMoneyHost(options);
  beforeRender?.();
  const user = userEvent.setup();
  render(
    <SheetBuilder
      library={library()}
      preselectedCharacterId={null}
      onOpenSheet={() => {}}
      onCreateStack={() => {}}
      onCreateCharacter={() => {}}
    />,
  );
  await screen.findByTestId('builder-stack-card');
  await user.click(screen.getByTestId('builder-step-tab-2'));
  return user;
}

async function failedEstimate(message: string) {
  await openReview({
    consentGranted: true,
    generation: { failEstimate: 'failed', failEstimateMessage: message },
  });
  return screen.findByTestId('se-builder-price-failures', {}, { timeout: 4000 });
}

describe('pricing blockers explain themselves (feedback #189)', () => {
  it('an incompatible LoRA names the stack problem, not "try again"', async () => {
    const box = await failedEstimate(
      'a selected LoRA is not compatible with the checkpoint base model',
    );
    expect(box).toHaveTextContent(/LoRA in “Zeta Stack” doesn’t match its checkpoint/);
    expect(box).not.toHaveTextContent(/try again/i);
    // Never the raw server words.
    expect(document.body).not.toHaveTextContent('a selected LoRA is not compatible');
    // Price stays usable after a failure (re-price after fixing).
    expect(screen.getByTestId('se-builder-price')).toBeEnabled();
  });

  it('a resource not available to apps says which kind of fix is needed', async () => {
    const box = await failedEstimate('a selected resource is not available to apps');
    expect(box).toHaveTextContent(/model or LoRA in “Zeta Stack” can’t be used/);
  });

  it('an unavailable ecosystem points at the checkpoint, not at the viewer', async () => {
    const box = await failedEstimate(
      'Validation failed: ecosystem: Ecosystem is currently unavailable',
    );
    expect(box).toHaveTextContent(/checkpoint family in “Zeta Stack” isn’t available/);
  });

  it('insufficient Buzz at pricing time shows Not enough Buzz + Top up', async () => {
    const box = await failedEstimate('Insufficient buzz balance');
    expect(box).toHaveTextContent('Not enough Buzz');
    expect(screen.getByRole('button', { name: 'Top up Buzz' })).toBeInTheDocument();
  });

  it('a price that comes back empty says so (no-cost producer)', async () => {
    await openReview({ consentGranted: true, generation: { failEstimate: 'no-cost' } });
    const box = await screen.findByTestId('se-builder-price-failures', {}, { timeout: 4000 });
    expect(box).toHaveTextContent(/didn’t return a price/);
  });

  it('a dismissed approval dialog never soft-locks the Price button', async () => {
    // The real host sends NOTHING back when the viewer closes the consent
    // dialog (no grant, no CONSENT_UNAVAILABLE) — model that by swallowing
    // REQUEST_CONSENT before the mock host sees it.
    let consent: { count: () => number } | undefined;
    const user = await openReview({ consentGranted: false }, () => {
      consent = swallowOutbound('REQUEST_CONSENT');
    });
    const consentRequests = () => consent?.count() ?? 0;

    await waitFor(() => expect(consentRequests()).toBe(1));
    expect(await screen.findByTestId('se-builder-consent-wait')).toHaveTextContent(
      /If you closed it/,
    );
    const price = screen.getByTestId('se-builder-price');
    expect(price).toBeEnabled();
    await user.click(price);
    await waitFor(() => expect(consentRequests()).toBe(2));
  });

  it('a Generate waiting on approval resumes as a RE-PRICE, never a blind submit', async () => {
    // Reach the confirm card with approval granted, then have the host push a
    // token WITHOUT the spend scope (expired/revoked approval). Generate then
    // waits on a consent dialog the viewer closes; pressing Price and granting
    // must show the price again — not submit the panels unseen.
    const outbound: string[] = [];
    let consent: { count: () => number } | undefined;
    const user = await openReview(
      { consentGranted: true, onOutbound: (m) => void outbound.push(m.type ?? '') },
      () => {
        consent = swallowOutbound('REQUEST_CONSENT');
      },
    );
    const generate = await screen.findByRole('button', { name: /Generate 4 panels · 32 Buzz/ });
    const pushToken = (scopes: string[]) =>
      act(() => {
        window.dispatchEvent(
          new MessageEvent('message', {
            origin: window.location.origin,
            data: {
              type: 'TOKEN_REFRESH',
              payload: {
                token: {
                  raw: `test-token.${scopes.length}`,
                  scopes,
                  expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
                  ...(scopes.length ? { buzzBudget: 300 } : {}),
                },
              },
            },
          }),
        );
      });
    pushToken([]);
    await user.click(generate);
    await waitFor(() => expect(consent?.count()).toBe(1));
    expect(await screen.findByTestId('se-builder-consent-wait')).toBeInTheDocument();
    await user.click(screen.getByTestId('se-builder-price'));
    await waitFor(() => expect(consent?.count()).toBe(2));
    pushToken(['ai:write:budgeted']);
    // The resume fires on the grant; give it time to reach the host, then
    // assert nothing was submitted and a fresh pricing round ran instead.
    await new Promise((r) => setTimeout(r, 500));
    expect(outbound).not.toContain('SUBMIT_WORKFLOW');
    expect(outbound.filter((t) => t === 'ESTIMATE_WORKFLOW').length).toBeGreaterThan(4);
    expect(
      await screen.findByRole('button', { name: /Generate 4 panels · 32 Buzz/ }, { timeout: 4000 }),
    ).toBeInTheDocument();
  });

  it('Sheet View re-price shows app copy, never the raw server reason', async () => {
    const raw = 'a selected LoRA is not compatible with the checkpoint base model';
    uninstall = installMockMoneyHost({
      consentGranted: true,
      generation: { failEstimate: 'failed', failEstimateMessage: raw },
    });
    const user = userEvent.setup();
    const sheet: SheetJob = {
      id: 'sheet-1',
      name: 'Kaida sheet',
      characterId: 'char-1',
      stackId: 'stack-1',
      seed: 42,
      account: 'auto',
      useReference: false,
      status: 'draft',
      panels: [
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
      ],
      createdAt: '2026-10-01T22:00:00.000Z',
      updatedAt: '2026-10-01T22:00:00.000Z',
    };
    render(
      <SheetView
        library={library([sheet])}
        sheetId="sheet-1"
        onBack={() => {}}
        onNewSheet={() => {}}
        onRegenerateSheet={() => {}}
      />,
    );
    await user.click(await screen.findByRole('button', { name: 'Submit' }));
    expect(
      await screen.findByText(/LoRA in “Zeta Stack” doesn’t match its checkpoint/, {}, { timeout: 4000 }),
    ).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent(raw);
  });
});
