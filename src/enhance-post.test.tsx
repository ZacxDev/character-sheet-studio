// Component contracts for AI prompt enhancement (Builder) and Post-to-profile
// (Sheet View), driven through the real SDK transport against the mock host.
//
// Enhancement: the stock mock host has no chat-step text replies, so
// `stepTextOutputs` on installMockMoneyHost arms the canned reply the host
// attaches as `textOutputs` — the same field the real host uses to release
// the moderation-scanned model output. The degradation test omits it.
//
// Post: the mock answers CREATE_POST_FROM_APP natively (default result:
// post 4242). `createPostError: 'declined'` is the one refusal every block
// must survive silently.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

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

type Outbound = { type?: string; payload?: unknown };

/** Leave exactly one panel (the first) checked in the Builder. */
async function keepOnePanel(user: ReturnType<typeof userEvent.setup>) {
  const boxes = screen
    .getAllByRole('checkbox')
    .filter((b) => !(b as HTMLInputElement).disabled) as HTMLInputElement[];
  const checked = boxes.filter((b) => b.checked);
  for (const box of checked.slice(1)) await user.click(box);
}

describe('Builder prompt enhancement', () => {
  let uninstall: (() => void) | undefined;
  afterEach(() => {
    uninstall?.();
    uninstall = undefined;
  });

  it('prices, confirms, enhances, and the enhanced text is the generation prompt', async () => {
    const outbound: Outbound[] = [];
    const saved: SheetJob[] = [];
    uninstall = installMockMoneyHost({
      stepTextOutputs: ['ENHANCED: kaida_cyber in chrome armor, neon rain'],
      onOutbound: (msg) => {
        outbound.push(msg as Outbound);
      },
    });
    const onOpenSheet = vi.fn();
    const library = stubLibrary({
      saveSheet: async (s) => {
        saved.push(s);
        return null;
      },
    });
    const user = userEvent.setup();
    render(
      <SheetBuilder
        library={library}
        preselectedCharacterId={null}
        onOpenSheet={onOpenSheet}
        onCreateStack={() => {}}
        onCreateCharacter={() => {}}
      />,
    );
    await keepOnePanel(user);

    // Price the enhancement first — nothing submits before the confirm.
    await user.click(await screen.findByTestId('se-enhance'));
    const confirm = await screen.findByTestId('se-enhance-confirm');
    expect(confirm).toHaveTextContent(/Enhance 1 prompt/);
    expect(confirm).toHaveTextContent(/8 Buzz/);
    expect(
      outbound.some(
        (m) =>
          m.type === 'SUBMIT_WORKFLOW' &&
          (m.payload as { body?: { kind?: string } })?.body?.kind === 'step',
      ),
    ).toBe(false);

    await user.click(screen.getByTestId('se-enhance-confirm-run'));
    // The step runs through the adaptive poll loop (2s first backoff) — allow
    // well beyond findBy's 1s default.
    const badge = await screen.findByTestId('se-enhance-applied', {}, { timeout: 15_000 });
    expect(badge).toHaveTextContent('Enhanced ✦');
    expect(badge).toHaveTextContent('ENHANCED: kaida_cyber in chrome armor, neon rain');

    // The step submit carried the composed prompt (trigger word included).
    const stepSubmit = outbound.find(
      (m) =>
        m.type === 'SUBMIT_WORKFLOW' &&
        (m.payload as { body?: { kind?: string } })?.body?.kind === 'step',
    );
    const stepBody = (
      stepSubmit?.payload as {
        body?: { step?: string; params?: { model?: string; messages?: { content: string }[] } };
      }
    )?.body;
    expect(stepBody?.step).toBe('chat-completion');
    expect(stepBody?.params?.model).toBe('openai/gpt-4o-mini');
    expect(stepBody?.params?.messages?.[1]?.content).toContain('kaida_cyber');

    // Price + generate: the textToImage submit must carry the enhanced text
    // verbatim — the composer does not re-compose around it.
    await user.click(screen.getByTestId('se-builder-price'));
    await user.click(await screen.findByRole('button', { name: /Generate 1 panel/ }));
    await waitFor(() => expect(onOpenSheet).toHaveBeenCalled(), { timeout: 15_000 });
    const genSubmit = outbound.find(
      (m) =>
        m.type === 'SUBMIT_WORKFLOW' &&
        (m.payload as { body?: { kind?: string } })?.body?.kind === 'textToImage',
    );
    const genPrompt = (
      genSubmit?.payload as { body?: { params?: { prompt?: string } } }
    )?.body?.params?.prompt;
    expect(genPrompt).toBe('ENHANCED: kaida_cyber in chrome armor, neon rain');
    // And the enhanced prompt persisted onto the saved sheet's panel.
    expect(
      saved.some((s) =>
        s.panels.some(
          (p) => p.enhancedPrompt === 'ENHANCED: kaida_cyber in chrome armor, neon rain',
        ),
      ),
    ).toBe(true);
  });

  it('degrades gracefully when the host returns no text: original prompt kept', async () => {
    uninstall = installMockMoneyHost({}); // no stepTextOutputs armed
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
    await keepOnePanel(user);

    await user.click(await screen.findByTestId('se-enhance'));
    await user.click(await screen.findByTestId('se-enhance-confirm-run'));
    const notice = await screen.findByTestId('se-enhance-notice', {}, { timeout: 15_000 });
    expect(notice).toHaveTextContent(/didn’t come back/);
    expect(screen.queryByTestId('se-enhance-applied')).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------

const doneSheet = (over: Partial<SheetJob> = {}): SheetJob => ({
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
      outputs: ['https://images.example/front.png'],
      workflowId: 'wf-front',
      submitNonce: 1,
    },
    {
      id: 'p2',
      kind: 'side',
      label: 'Side view',
      promptModifier: 'side view',
      seed: 43,
      status: 'done',
      outputs: ['https://images.example/side.png'],
      workflowId: 'wf-side',
      submitNonce: 1,
    },
  ],
  createdAt: '2026-10-02T00:00:00.000Z',
  updatedAt: '2026-10-02T00:00:00.000Z',
  ...over,
});

describe('Sheet View post-to-profile', () => {
  let uninstall: (() => void) | undefined;
  afterEach(() => {
    uninstall?.();
    uninstall = undefined;
  });

  it('posts one panel and marks it Posted ✓ persistently', async () => {
    const outbound: Outbound[] = [];
    const saved: SheetJob[] = [];
    uninstall = installMockMoneyHost({
      onOutbound: (msg) => {
        outbound.push(msg as Outbound);
      },
    });
    const user = userEvent.setup();
    render(
      <SheetView
        library={stubLibrary({
          sheets: [doneSheet()],
          saveSheet: async (s) => {
            saved.push(s);
            return null;
          },
        })}
        sheetId="sheet-1"
        onBack={() => {}}
      />,
    );

    const postButtons = await screen.findAllByTestId('se-panel-post');
    await user.click(postButtons[0]);

    await waitFor(() =>
      expect(
        outbound.some((m) => m.type === 'CREATE_POST_FROM_APP'),
      ).toBe(true),
    );
    const postMsg = outbound.find((m) => m.type === 'CREATE_POST_FROM_APP');
    expect(JSON.stringify(postMsg?.payload)).toContain('"workflowId":"wf-front"');
    expect(JSON.stringify(postMsg?.payload)).toContain('[0]');

    await screen.findByTestId('se-post-notice');
    expect(screen.getByTestId('se-post-notice')).toHaveTextContent(/Posted to your profile/);
    expect(postButtons[0]).toHaveTextContent('Posted ✓');
    expect(postButtons[0]).toBeDisabled();
    // The other panel is untouched.
    expect(postButtons[1]).toHaveTextContent('Post');
    expect(
      saved.some((s) =>
        s.panels.some(
          (p) =>
            p.id === 'p1' && p.posted === true && p.postUrl === 'https://civitai.com/posts/4242',
        ),
      ),
    ).toBe(true);
  });

  it('stays silent when the viewer declines the host confirm', async () => {
    const outbound: Outbound[] = [];
    uninstall = installMockMoneyHost({
      createPostError: 'declined',
      onOutbound: (msg) => {
        outbound.push(msg as Outbound);
      },
    });
    const user = userEvent.setup();
    render(
      <SheetView
        library={stubLibrary({ sheets: [doneSheet()] })}
        sheetId="sheet-1"
        onBack={() => {}}
      />,
    );

    const postButtons = await screen.findAllByTestId('se-panel-post');
    await user.click(postButtons[0]);
    await waitFor(() =>
      expect(outbound.some((m) => m.type === 'CREATE_POST_FROM_APP')).toBe(true),
    );
    // Nothing to say about a choice the viewer made themselves.
    expect(screen.queryByTestId('se-post-notice')).not.toBeInTheDocument();
    expect(postButtons[0]).toHaveTextContent('Post');
    expect(postButtons[0]).not.toBeDisabled();
  });

  it('shows a free-text server error verbatim', async () => {
    uninstall = installMockMoneyHost({ createPostError: 'Post service unavailable' });
    const user = userEvent.setup();
    render(
      <SheetView
        library={stubLibrary({ sheets: [doneSheet()] })}
        sheetId="sheet-1"
        onBack={() => {}}
      />,
    );
    const postButtons = await screen.findAllByTestId('se-panel-post');
    await user.click(postButtons[0]);
    const notice = await screen.findByTestId('se-post-notice');
    expect(notice).toHaveTextContent('Post service unavailable');
  });

  it('posts the whole sheet: every unposted done panel in one post', async () => {
    const outbound: Outbound[] = [];
    const saved: SheetJob[] = [];
    uninstall = installMockMoneyHost({
      onOutbound: (msg) => {
        outbound.push(msg as Outbound);
      },
    });
    const user = userEvent.setup();
    render(
      <SheetView
        library={stubLibrary({
          sheets: [doneSheet()],
          saveSheet: async (s) => {
            saved.push(s);
            return null;
          },
        })}
        sheetId="sheet-1"
        onBack={() => {}}
      />,
    );

    await user.click(await screen.findByTestId('se-post-sheet'));
    await waitFor(() =>
      expect(outbound.some((m) => m.type === 'CREATE_POST_FROM_APP')).toBe(true),
    );
    const payload = JSON.stringify(
      outbound.find((m) => m.type === 'CREATE_POST_FROM_APP')?.payload,
    );
    expect(payload).toContain('"workflowId":"wf-front"');
    expect(payload).toContain('"workflowId":"wf-side"');

    await waitFor(() =>
      expect(screen.getByTestId('se-post-sheet')).toHaveTextContent('Posted ✓'),
    );
    expect(screen.getByTestId('se-post-sheet')).toBeDisabled();
    expect(
      saved.some(
        (s) =>
          s.postUrl === 'https://civitai.com/posts/4242' &&
          s.panels.every((p) => p.posted === true),
      ),
    ).toBe(true);
  });
});
