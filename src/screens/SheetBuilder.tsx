// Sheet Builder: configure a sheet, price every panel, confirm once, submit.
//
// The batch money path, in order:
//   1. setup      — character + stack (picked from full-detail cards, or a
//                   new stack created inline) + panels (icon cards, plus
//                   custom panels written inline) + seed (+ optional img2img)
//   2. consent    — BEFORE pricing when the budgeted scope is missing (the
//                   production host scope-gates estimate itself)
//   3. estimate   — EVERY panel priced; the batch total is the single confirm gate.
//                   A panel that can't be priced BLOCKS the batch (blind-
//                   submitting N panels without a price is not something we do).
//   4. confirm    — per-panel costs + total, one explicit "Generate" click
//   5. submit     — sequential, one panel at a time, stable idempotency keys
//                   derived from sheetId+panelId+submitNonce (a retry after a
//                   lost response reuses the key → one charge, not two)
//   6. handoff    — the sheet persists after EVERY panel transition, then the
//                   Sheet View takes over polling.
//
// Prompt enhancement lives ONLY in the custom-panel editor: when a viewer
// writes their own panel, AI can rewrite it — priced first, like everything
// else. The enhanced text stores on the panel; the composer uses it verbatim.
//
// The sheet is persisted only once it becomes real (first submit). The
// estimate/confirm draft lives in memory — closing the tab at the confirm
// screen leaves no orphan draft behind.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  useBlockContext,
  useBlockToken,
  useBuzzBalance,
  useBuzzPurchase,
  useBuzzWorkflow,
  useConsentUnavailable,
  useRequestConsent,
  useRequestSignIn,
} from '@civitai/blocks-react';
import {
  Alert,
  Badge,
  Button,
  Card,
  Group,
  Loader,
  NumberInput,
  Select,
  Stack,
  TextInput,
  Textarea,
} from '@civitai/blocks-react/ui';
import type { BlockWorkflowSnapshot, WorkflowBody } from '@civitai/app-sdk/blocks';

import {
  ACCOUNT_CHOICES,
  BUDGETED_SCOPE,
  accountLabel,
  classifyPricedFailure,
  classifySubmitRejection,
  estimateErrorCopy,
  formatCost,
  hasBudgetedScope,
  isTerminalStatus,
  type AccountChoice,
} from '../money/generation.js';
import { buildSheetPanelBody } from '../sheet/body.js';
import {
  buildEnhanceBody,
  enhanceOutcomeFromSnapshot,
  type EnhanceOutcome,
} from '../sheet/enhance.js';
import { composePanelPrompt } from '../sheet/prompt.js';
import { startPollLoop } from '../money/pollLoop.js';
import {
  idempotencyKeyFor,
  panelErrorCopy,
  pricedKindToErrorCode,
  resolvePanelSeed,
  type PanelErrorCode,
} from '../sheet/batch.js';
import type { ModelStack, PanelKind, PanelSpec, SheetJob, SheetPanel } from '../sheet/types.js';
import { PANEL_KINDS, PANEL_LABELS, defaultPanelSpecs, newSheetJob } from '../sheet/types.js';
import { checkpointDisplayLabel } from '../models.js';
import type { SheetLibrary } from '../sheet/useSheetLibrary.js';
import { storeErrorMessage } from './common.js';
import { StackEditor } from './Stacks.js';

export interface SheetBuilderProps {
  library: SheetLibrary;
  preselectedCharacterId: string | null;
  /** Stack handed over by a return trip from the Stacks tab (create flow). */
  preselectedStackId?: string | null;
  /** Sheet whose stack + panels seed this form ("run this sheet" from a character page). */
  seedSheetId?: string | null;
  onOpenSheet: (sheetId: string) => void;
  /** Take the viewer to create a stack, preserving the character in progress. */
  onCreateStack: (characterId: string) => void;
  /** Take the viewer to create a character. */
  onCreateCharacter: () => void;
}

type BuilderPhase =
  | 'idle'
  | 'needs-consent'
  | 'consent-unavailable'
  | 'estimating'
  | 'confirm'
  | 'submitting';

const BUILDER_STEPS = ['Character', 'Panels', 'Review'] as const;

interface PanelEstimate {
  cost?: number;
  errorTitle?: string;
  errorBody?: string;
}

/** A panel the viewer wrote inline (any base kind, own label + wording). */
interface CustomPanelDraft extends PanelSpec {
  id: string;
  selected: boolean;
  enhancedPrompt?: string;
}

type ChosenSpec = PanelSpec & { enhancedPrompt?: string };

const STACK_PRESETS: Array<{ slug: string; label: string; name: string; notes: string }> = [
  { slug: 'anime', label: 'Anime sheet', name: 'Anime Sheet', notes: 'Clean anime look for character turnarounds.' },
  { slug: 'realistic', label: 'Realistic', name: 'Realistic Portrait', notes: 'Photoreal skin, natural light.' },
  { slug: 'illustration', label: 'Illustration', name: 'Illustration', notes: 'Painterly, hand-drawn feel.' },
  { slug: 'chibi', label: 'Chibi & cute', name: 'Chibi & Cute', notes: 'Chibi proportions, bright colors.' },
];

function randomSeed(): number {
  return 100000 + Math.floor(Math.random() * 900000);
}

function newPanelId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `cp-${Date.now()}-${Math.random()}`;
}

/** Little line icons that picture what each panel kind frames. */
export function PanelKindIcon({ kind }: { kind: PanelKind }) {
  const common = {
    width: 26,
    height: 26,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.7,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
  };
  switch (kind) {
    case 'front':
      return (
        <svg {...common}>
          <circle cx="12" cy="8" r="3.4" />
          <circle cx="10.9" cy="7.8" r="0.4" fill="currentColor" />
          <circle cx="13.1" cy="7.8" r="0.4" fill="currentColor" />
          <path d="M5.5 20c.8-3.2 3.4-4.8 6.5-4.8s5.7 1.6 6.5 4.8" />
        </svg>
      );
    case 'side':
      return (
        <svg {...common}>
          <path d="M14.5 4.2a5 5 0 1 1-3.4 8.7l-1.6 2.1h4.2" />
          <path d="M11.5 20c.4-2.6 1.6-4.2 3.5-5" />
        </svg>
      );
    case 'back':
      return (
        <svg {...common}>
          <circle cx="12" cy="8" r="3.4" />
          <path d="M8.9 6.4c1-1 5.2-1 6.2 0M9.3 9.8c.8.6 4.6.6 5.4 0" />
          <path d="M5.5 20c.8-3.2 3.4-4.8 6.5-4.8s5.7 1.6 6.5 4.8" />
        </svg>
      );
    case 'three-quarter':
      return (
        <svg {...common}>
          <circle cx="12" cy="8" r="3.4" />
          <circle cx="13.2" cy="7.8" r="0.4" fill="currentColor" />
          <path d="M15.2 5.2a4.6 4.6 0 0 1 0 5.6" />
          <path d="M5.5 20c.8-3.2 3.4-4.8 6.5-4.8s5.7 1.6 6.5 4.8" />
        </svg>
      );
    case 'expression':
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="7.5" />
          <circle cx="9.3" cy="10.4" r="0.5" fill="currentColor" />
          <circle cx="14.7" cy="10.4" r="0.5" fill="currentColor" />
          <path d="M8.6 14.2c1 1.5 2.1 2.2 3.4 2.2s2.4-.7 3.4-2.2" />
        </svg>
      );
    case 'scenario':
      return (
        <svg {...common}>
          <rect x="3.5" y="5" width="17" height="14" rx="2" />
          <circle cx="9" cy="10" r="1.4" />
          <path d="M4 17.5 9.5 12l3.5 3.2 3-2.7 4 5" />
        </svg>
      );
  }
}

export function SheetBuilder({ library, preselectedCharacterId, preselectedStackId, seedSheetId, onOpenSheet, onCreateCharacter }: SheetBuilderProps) {
  const { ready, viewer } = useBlockContext();
  const token = useBlockToken();
  const { balance } = useBuzzBalance();
  const { openPurchaseModal } = useBuzzPurchase();
  const { estimate, submit, poll } = useBuzzWorkflow();
  const { requestSignIn } = useRequestSignIn();
  const { requestConsent } = useRequestConsent();
  const { refusal } = useConsentUnavailable();

  const granted = hasBudgetedScope(token?.scopes);
  const anon = ready && !viewer;

  const allSpecs = useMemo(() => defaultPanelSpecs(), []);

  const [characterId, setCharacterId] = useState(
    () =>
      preselectedCharacterId ??
      library.characters[0]?.id ??
      '',
  );
  const [stackId, setStackId] = useState('');
  const [specSelected, setSpecSelected] = useState<boolean[]>(() =>
    allSpecs.map((s) => library.settings.defaultPanels.includes(s.kind)),
  );
  const [customPanels, setCustomPanels] = useState<CustomPanelDraft[]>([]);
  const [seed, setSeed] = useState<number | null>(() => randomSeed());
  const [useReference, setUseReference] = useState(false);
  const [account, setAccount] = useState<AccountChoice>('auto');

  const [phase, setPhase] = useState<BuilderPhase>('idle');
  const [draft, setDraft] = useState<SheetJob | null>(null);
  const [estimates, setEstimates] = useState<Record<string, PanelEstimate>>({});
  const [submitProgress, setSubmitProgress] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);
  // The form is a 3-step flow, not one long scrolling card.
  const [step, setStep] = useState(0);

  // Inline stack creation (with preset starting points).
  const [stackCreateOpen, setStackCreateOpen] = useState(false);
  const [stackPreset, setStackPreset] = useState<{ name: string; notes: string } | null>(null);

  // Custom-panel editor. Enhancement lives here, nowhere else: it exists to
  // polish a panel the viewer is writing themselves.
  const [panelEditor, setPanelEditor] = useState<{
    id?: string;
    label: string;
    kind: PanelKind;
    prompt: string;
    enhancedPrompt?: string;
  } | null>(null);
  const [cpPhase, setCpPhase] = useState<'idle' | 'estimating' | 'confirming' | 'running'>('idle');
  const [cpQuote, setCpQuote] = useState<number | null>(null);
  const [cpNotice, setCpNotice] = useState<string | null>(null);
  const [cpConsentWait, setCpConsentWait] = useState(false);
  const cpIntentRef = useRef(false);
  const cpRunRef = useRef(0);
  const pollCancelsRef = useRef<Array<() => void>>([]);
  const pollRef = useRef(poll);
  pollRef.current = poll;
  useEffect(() => {
    const cancels = pollCancelsRef.current;
    return () => {
      for (const c of cancels) c();
      cancels.length = 0;
    };
  }, []);

  const consentIntentRef = useRef<'estimate' | 'submit' | null>(null);
  const runEstimateRef = useRef<() => void>(() => {});
  const runSubmitRef = useRef<() => void>(() => {});

  const character = library.characters.find((c) => c.id === characterId);
  const stack = library.stacks.find((s) => s.id === stackId);

  // With no stacks at all, the inline create starts open — creating the first
  // stack is the flow, not a detour to another tab.
  useEffect(() => {
    if (library.ready && library.stacks.length === 0) setStackCreateOpen(true);
  }, [library.ready, library.stacks.length]);

  // Character and stack are independent choices for this run. Heal the stack
  // selection only when it is empty or points at a deleted stack; switching
  // characters never changes the stack the viewer picked.
  useEffect(() => {
    if (!library.ready) return;
    setStackId((cur) => {
      if (cur && library.stacks.some((s) => s.id === cur)) return cur;
      return library.stacks[0]?.id ?? '';
    });
  }, [library.ready, library.stacks]);

  // If the preselected character arrives after mount (deep link), adopt it.
  useEffect(() => {
    if (preselectedCharacterId) setCharacterId(preselectedCharacterId);
  }, [preselectedCharacterId]);

  // Same for a stack handed over by a return trip (saved on the Stacks tab).
  useEffect(() => {
    if (preselectedStackId) setStackId(preselectedStackId);
  }, [preselectedStackId]);

  // Self-heal the selection once hydration settles: the selects' initial
  // state was computed against an EMPTY library, so on a cold open
  // characterId is '' while the native select DISPLAYS the first character —
  // the price/enhance handlers then "dead-click" with "Pick a character
  // first." Healing to a real id makes the control and the state agree.
  useEffect(() => {
    if (!library.ready || library.characters.length === 0) return;
    if (library.characters.some((c) => c.id === characterId)) return;
    const preferred =
      preselectedCharacterId &&
      library.characters.some((c) => c.id === preselectedCharacterId)
        ? preselectedCharacterId
        : library.characters[0].id;
    setCharacterId(preferred);
  }, [library.ready, library.characters, characterId, preselectedCharacterId]);

  // One-time sync of the panel selection once storage hydration settles, so a
  // saved defaultPanels preference wins over the first-render guess. The ref
  // guard keeps the user's own toggles from being clobbered.
  const specSyncedRef = useRef(false);
  useEffect(() => {
    if (library.ready && !specSyncedRef.current) {
      specSyncedRef.current = true;
      setSpecSelected(allSpecs.map((s) => library.settings.defaultPanels.includes(s.kind)));
    }
  }, [library.ready, library.settings, allSpecs]);

  // "Run this sheet" seeding (declared AFTER the settings sync so it wins in
  // the same commit): adopt the source sheet's stack and panel setup. A
  // panel that still matches a default spec (same kind + wording) re-selects
  // that spec; anything else comes back as a custom panel with its own label,
  // wording, and enhancement, so re-running reproduces the original setup.
  const seedAppliedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!seedSheetId || !library.ready || seedAppliedRef.current === seedSheetId) return;
    const sheet = library.sheets.find((s) => s.id === seedSheetId);
    if (!sheet) return;
    seedAppliedRef.current = seedSheetId;
    if (library.stacks.some((s) => s.id === sheet.stackId)) setStackId(sheet.stackId);
    const used = new Set<number>();
    const selected = allSpecs.map(() => false);
    const customs: CustomPanelDraft[] = [];
    for (const p of sheet.panels) {
      const idx = allSpecs.findIndex(
        (sp, i) => !used.has(i) && sp.kind === p.kind && sp.promptModifier === p.promptModifier,
      );
      if (idx >= 0) {
        used.add(idx);
        selected[idx] = true;
      } else {
        customs.push({
          id: newPanelId(),
          kind: p.kind,
          label: p.label,
          promptModifier: p.promptModifier,
          selected: true,
          ...(p.enhancedPrompt ? { enhancedPrompt: p.enhancedPrompt } : {}),
        });
      }
    }
    setSpecSelected(selected);
    setCustomPanels(customs);
    // Re-run goes straight to Review — the setup is already decided by the
    // source sheet; the auto-price effect below prices it on view.
    setStep(2);
  }, [seedSheetId, library.ready, library.sheets, library.stacks, allSpecs]);

  /** Everything that would generate: picked defaults + picked custom panels. */
  const chosenSpecs: ChosenSpec[] = useMemo(() => {
    const defaults = allSpecs.filter((_, i) => specSelected[i]);
    const customs = customPanels
      .filter((p) => p.selected)
      .map((p) => ({
        kind: p.kind,
        label: p.label,
        promptModifier: p.promptModifier,
        ...(p.enhancedPrompt ? { enhancedPrompt: p.enhancedPrompt } : {}),
      }));
    return [...defaults, ...customs];
  }, [allSpecs, customPanels, specSelected]);

  const totalEstimate = useMemo(() => {
    let total = 0;
    for (const p of draft?.panels ?? []) {
      const e = estimates[p.id];
      if (e?.cost == null) return null;
      total += e.cost;
    }
    return (draft?.panels.length ?? 0) > 0 ? total : null;
  }, [draft, estimates]);

  // --- workflow body -----------------------------------------------------------
  // One body per panel, built through the shared composer — identical for
  // estimate and submit, so the confirmed price is the submitted price. The
  // batch config (account + useReference) persists on the sheet so the View
  // can rebuild the exact body later.

  const bodyOpts = useMemo(
    () => ({ account, useReference }),
    [account, useReference],
  );

  // --- estimate ----------------------------------------------------------------

  const runEstimate = useCallback(async () => {
    setError(null);
    const c = library.characters.find((x) => x.id === characterId);
    const s = library.stacks.find((x) => x.id === stackId);
    // Every early return MUST reset the phase — on the consent-resume path we
    // arrive here with phase 'needs-consent', and leaving it set soft-locks
    // the screen (every control disabled, "Waiting for your approval…" never
    // clears).
    if (!c) {
      setError('Pick a character first.');
      setPhase('idle');
      return;
    }
    if (!s) {
      setError('Pick or create a stack first.');
      setPhase('idle');
      return;
    }
    const specs = chosenSpecs;
    if (specs.length === 0) {
      setError('Select at least one panel.');
      setPhase('idle');
      return;
    }
    const seedVal = seed ?? randomSeed();
    setSeed(seedVal);

    // The draft lives in memory until the first submit — no orphan rows if the
    // tab closes at the confirm screen.
    const job = newSheetJob({
      name: `${c.name} sheet`,
      characterId: c.id,
      stackId: s.id,
      seed: seedVal,
      specs,
      account,
      useReference,
    });
    job.panels = job.panels.map((p, i) => ({
      ...p,
      seed: resolvePanelSeed(seedVal, i, c.seedPolicy),
      // AI-enhanced prompts ride the panel into the sheet — the composer
      // then uses them verbatim.
      ...(specs[i]?.enhancedPrompt
        ? { enhancedPrompt: specs[i].enhancedPrompt }
        : {}),
    }));

    setDraft(job);
    setEstimates({});
    setPhase('estimating');

    const results: Record<string, PanelEstimate> = {};
    let failures = 0;
    for (const panel of job.panels) {
      const body = buildSheetPanelBody(panel, c, s, library.settings, bodyOpts);
      try {
        const snap: BlockWorkflowSnapshot = await estimate(body);
        const cost = snap.cost?.total;
        if (snap.status === 'failed' || snap.error || typeof cost !== 'number') {
          const code: PanelErrorCode = pricedKindToErrorCode(
            classifyPricedFailure(snap.error),
          );
          const copy = panelErrorCopy(code);
          results[panel.id] = { errorTitle: copy.title, errorBody: copy.body };
          failures += 1;
        } else {
          results[panel.id] = { cost };
        }
      } catch (err) {
        const code = (err as { code?: unknown } | null)?.code;
        results[panel.id] = {
          errorTitle: 'Couldn’t price this panel',
          errorBody: estimateErrorCopy(code),
        };
        failures += 1;
      }
      setEstimates({ ...results });
    }

    if (failures > 0) {
      setError(
        `${failures} panel${failures === 1 ? '' : 's'} couldn’t be priced. ` +
          'The batch is blocked until every panel has a price — adjust the setup and price again.',
      );
      setPhase('idle');
      return;
    }
    setPhase('confirm');
  }, [
    account,
    bodyOpts,
    characterId,
    chosenSpecs,
    estimate,
    library.characters,
    library.settings,
    library.stacks,
    seed,
    stackId,
  ]);
  runEstimateRef.current = runEstimate;

  // --- submit ------------------------------------------------------------------

  const runSubmit = useCallback(async () => {
    const job = draft;
    const c = library.characters.find((x) => x.id === characterId);
    const s = library.stacks.find((x) => x.id === stackId);
    if (!job || !c || !s) {
      setError('The sheet draft is gone — price it again.');
      setPhase('idle');
      return;
    }
    setError(null);
    setPhase('submitting');
    setSubmitProgress({ done: 0, total: job.panels.length });

    job.status = 'running';
    const panels = job.panels.map((p) => ({ ...p }));
    job.panels = panels;

    let done = 0;
    for (const panel of panels) {
      const body = buildSheetPanelBody(panel, c, s, library.settings, bodyOpts);
      try {
        const snap: BlockWorkflowSnapshot = await submit(body, {
          idempotencyKey: idempotencyKeyFor(job.id, panel.id, panel.submitNonce),
        });
        if (isTerminalStatus(snap.status)) {
          // An instant terminal snapshot (cached success / instant priced refusal).
          if (snap.status === 'succeeded') {
            panel.status = 'done';
            panel.outputs = snap.imageUrls ?? [];
          } else {
            panel.status = 'failed';
            panel.errorCode = pricedKindToErrorCode(classifyPricedFailure(snap.error));
          }
        } else {
          panel.workflowId = snap.workflowId;
          panel.status = 'running';
          // Elapsed-time anchor + the quoted price, persisted so Sheet View
          // shows the true wait and the committed Buzz across the handoff.
          panel.startedAt = new Date().toISOString();
          const quoted = estimates[panel.id]?.cost;
          if (quoted != null) panel.cost = quoted;
        }
      } catch (err) {
        // Never the raw server prose — classify the rejection shape.
        const rej = classifySubmitRejection(err);
        if (rej.kind === 'workflow-failed' && rej.pollWorkflowId) {
          // Money may be committed; the poll loop learns the actual fate.
          panel.workflowId = rej.pollWorkflowId;
          panel.status = 'running';
          panel.startedAt = new Date().toISOString();
          const quoted = estimates[panel.id]?.cost;
          if (quoted != null) panel.cost = quoted;
        } else if (rej.kind === 'exception') {
          panel.status = 'failed';
          panel.errorCode = 'submit-interrupted';
        } else {
          panel.status = 'failed';
          panel.errorCode = 'submit-failed';
        }
      }
      done += 1;
      setSubmitProgress({ done, total: panels.length });
      job.updatedAt = new Date().toISOString();
      // Best-effort: the in-memory job is the source of truth; a storage
      // failure here must not stop the remaining submits.
      await library.saveSheet({ ...job, panels: [...panels] });
    }

    const anyLive = panels.some((p) => p.workflowId);
    job.status = anyLive ? 'running' : 'failed';
    job.updatedAt = new Date().toISOString();
    const saveErr = await library.saveSheet({ ...job, panels: [...panels] });
    if (saveErr) {
      setError(storeErrorMessage(saveErr));
      setPhase('idle');
      return;
    }
    onOpenSheet(job.id);
  }, [
    bodyOpts,
    characterId,
    draft,
    estimates,
    library,
    onOpenSheet,
    stackId,
    submit,
  ]);
  runSubmitRef.current = runSubmit;

  // --- consent -----------------------------------------------------------------
  // Consent BEFORE pricing: the production host scope-gates estimate itself, so
  // pricing without the scope can never succeed there.

  const requestConsentFor = useCallback(
    (intent: 'estimate' | 'submit') => {
      consentIntentRef.current = intent;
      setPhase('needs-consent');
      requestConsent({ scopes: [BUDGETED_SCOPE] });
    },
    [requestConsent],
  );

  const startPricing = useCallback(() => {
    setError(null);
    // Validate BEFORE consent: asking for spend approval and only then
    // complaining about the setup burns a round-trip and (on the consent-
    // resume path) used to strand the viewer in a disabled spinner.
    if (!characterId) {
      setError('Pick a character first.');
      return;
    }
    if (!stackId) {
      setError('Pick or create a stack first.');
      return;
    }
    if (chosenSpecs.length === 0) {
      setError('Select at least one panel.');
      return;
    }
    if (anon) {
      // The guest state lives on the button itself ("Sign in to generate" +
      // the shell's one banner) — no second notice here.
      requestSignIn();
      return;
    }
    if (!granted) {
      // Never overwrite a waiting intent — resuming as 'submit' would skip
      // the price preview.
      requestConsentFor(consentIntentRef.current ?? 'estimate');
      return;
    }
    void runEstimateRef.current();
  }, [
    anon,
    characterId,
    chosenSpecs.length,
    granted,
    requestConsentFor,
    requestSignIn,
    stackId,
  ]);

  const startConfirmedSubmit = useCallback(() => {
    if (anon) {
      requestSignIn();
      return;
    }
    if (!granted) {
      requestConsentFor('submit');
      return;
    }
    void runSubmitRef.current();
  }, [anon, granted, requestConsentFor, requestSignIn]);

  // Re-run shortcut: a seeded builder opens on the Review step and pulls
  // prices on view, so the whole flow collapses to the confirm card. Fires
  // once per seed, and only once the seed has actually applied and every
  // pricing input is in place. Guests keep the manual path (their Price
  // button is the sign-in ask).
  const autoPricedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!seedSheetId || autoPricedRef.current === seedSheetId) return;
    if (seedAppliedRef.current !== seedSheetId) return;
    if (step !== 2 || phase !== 'idle' || anon) return;
    if (!characterId || !stackId || chosenSpecs.length === 0) return;
    autoPricedRef.current = seedSheetId;
    startPricing();
  }, [seedSheetId, step, phase, anon, characterId, stackId, chosenSpecs.length, startPricing]);

  // Auto-resume the waiting intent after a consent grant.
  useEffect(() => {
    if (granted && consentIntentRef.current === 'estimate') {
      consentIntentRef.current = null;
      void runEstimateRef.current();
    } else if (granted && consentIntentRef.current === 'submit') {
      consentIntentRef.current = null;
      void runSubmitRef.current();
    }
  }, [granted]);

  // A consent refusal is final for this environment — stop promising a dialog
  // that can never succeed.
  useEffect(() => {
    if (refusal && phase === 'needs-consent') {
      consentIntentRef.current = null;
      setPhase('consent-unavailable');
    }
  }, [refusal, phase]);

  // --- prompt enhancement (custom-panel editor only) ---------------------------
  // An AI rewrite of the panel being written, through the host's registered
  // chat-completion step. Same money rules as generation: estimate the call,
  // park ONE confirm with the price, submit only on confirm. The rewrite is
  // of the FULLY-COMPOSED prompt (identity clauses + triggers inside), so it
  // stores as the panel's enhancedPrompt and generates verbatim.

  const runEnhanceWorkflow = useCallback(
    (body: WorkflowBody, key: string): Promise<EnhanceOutcome> =>
      new Promise((resolve) => {
        let settled = false;
        const done = (o: EnhanceOutcome) => {
          if (!settled) {
            settled = true;
            resolve(o);
          }
        };
        void (async () => {
          try {
            const snap = await submit(body, { idempotencyKey: key });
            if (isTerminalStatus(snap.status)) {
              done(
                snap.status === 'succeeded'
                  ? enhanceOutcomeFromSnapshot(snap)
                  : { type: 'none' },
              );
              return;
            }
            const cancelLoop = startPollLoop(pollRef.current, snap.workflowId, {
              onSnapshot: (s2) => {
                if (s2.status === 'succeeded') done(enhanceOutcomeFromSnapshot(s2));
                else if (isTerminalStatus(s2.status)) done({ type: 'none' });
              },
              onUnreachable: () => done({ type: 'none' }),
            });
            pollCancelsRef.current.push(cancelLoop);
          } catch {
            done({ type: 'none' });
          }
        })();
      }),
    [submit],
  );
  const runEnhanceWorkflowRef = useRef(runEnhanceWorkflow);
  runEnhanceWorkflowRef.current = runEnhanceWorkflow;

  const editorComposedPrompt = useCallback((): string | null => {
    const c = library.characters.find((x) => x.id === characterId);
    const s = library.stacks.find((x) => x.id === stackId);
    if (!c || !s || !panelEditor) return null;
    const tempPanel: SheetPanel = {
      id: 'enhance-tmp',
      kind: panelEditor.kind,
      label: panelEditor.label || 'Custom panel',
      promptModifier: panelEditor.prompt,
      seed: 0,
      status: 'queued',
      outputs: [],
      submitNonce: 0,
    };
    return composePanelPrompt(c, s, tempPanel, library.settings).prompt;
  }, [characterId, library, panelEditor, stackId]);

  const estimateCpEnhance = useCallback(async () => {
    const c = library.characters.find((x) => x.id === characterId);
    const s = library.stacks.find((x) => x.id === stackId);
    if (!c || !s) {
      setCpNotice('Pick a character and a stack first.');
      setCpPhase('idle');
      return;
    }
    const composed = editorComposedPrompt();
    if (!composed) {
      setCpPhase('idle');
      return;
    }
    setCpPhase('estimating');
    setCpNotice(null);
    setCpQuote(null);
    try {
      const snap = await estimate(buildEnhanceBody(composed, s.checkpoint.baseModel));
      const cost = snap.cost?.total;
      if (snap.status === 'failed' || snap.error || typeof cost !== 'number') {
        setCpNotice('Couldn’t price the enhancement — your prompt is unchanged.');
        setCpPhase('idle');
        return;
      }
      setCpQuote(cost);
      setCpPhase('confirming');
    } catch {
      setCpNotice('Couldn’t price the enhancement — your prompt is unchanged.');
      setCpPhase('idle');
    }
  }, [characterId, editorComposedPrompt, estimate, library, stackId]);
  const estimateCpEnhanceRef = useRef(estimateCpEnhance);
  estimateCpEnhanceRef.current = estimateCpEnhance;

  const startCpEnhance = useCallback(() => {
    setCpNotice(null);
    if (!panelEditor || panelEditor.prompt.trim() === '') {
      setCpNotice('Write the panel prompt first, then enhance it.');
      return;
    }
    if (!characterId || !stackId) {
      setCpNotice('Pick a character and a stack first.');
      return;
    }
    if (anon) {
      requestSignIn();
      setCpNotice("You're browsing as a guest — sign in to enhance prompts.");
      return;
    }
    if (!granted) {
      cpIntentRef.current = true;
      setCpConsentWait(true);
      requestConsent({ scopes: [BUDGETED_SCOPE] });
      return;
    }
    void estimateCpEnhanceRef.current();
  }, [anon, characterId, granted, panelEditor, requestConsent, requestSignIn, stackId]);

  // Auto-resume enhancement pricing after a consent grant.
  useEffect(() => {
    if (granted && cpIntentRef.current) {
      cpIntentRef.current = false;
      setCpConsentWait(false);
      void estimateCpEnhanceRef.current();
    }
  }, [granted]);

  useEffect(() => {
    if (refusal && cpConsentWait) {
      cpIntentRef.current = false;
      setCpConsentWait(false);
      setCpNotice(
        'Spending approval isn’t available in this environment, so enhancement can’t run here.',
      );
    }
  }, [refusal, cpConsentWait]);

  const runCpEnhanceSubmit = useCallback(async () => {
    const c = library.characters.find((x) => x.id === characterId);
    const s = library.stacks.find((x) => x.id === stackId);
    const composed = editorComposedPrompt();
    if (cpQuote == null || !c || !s || !composed) {
      setCpPhase('idle');
      setCpQuote(null);
      return;
    }
    setCpPhase('running');
    cpRunRef.current += 1;
    const outcome = await runEnhanceWorkflowRef.current(
      buildEnhanceBody(composed, s.checkpoint.baseModel),
      idempotencyKeyFor('enhance', `${c.id}:panel-editor`, cpRunRef.current),
    );
    setCpQuote(null);
    setCpPhase('idle');
    if (outcome.type === 'text') {
      setPanelEditor((cur) => (cur ? { ...cur, enhancedPrompt: outcome.text } : cur));
      setCpNotice(null);
    } else if (outcome.type === 'withheld') {
      setCpNotice(`The enhancement was withheld: ${outcome.reason} Your prompt is unchanged.`);
    } else {
      setCpNotice('The enhancement didn’t come back — your prompt is unchanged.');
    }
  }, [characterId, cpQuote, editorComposedPrompt, library, stackId]);

  // --- custom panel editor -----------------------------------------------------

  const openPanelEditor = (existing?: CustomPanelDraft) => {
    setCpPhase('idle');
    setCpQuote(null);
    setCpNotice(null);
    setPanelEditor(
      existing
        ? {
            id: existing.id,
            label: existing.label,
            kind: existing.kind,
            prompt: existing.promptModifier,
            enhancedPrompt: existing.enhancedPrompt,
          }
        : { label: '', kind: 'scenario', prompt: '' },
    );
  };

  const savePanelEditor = () => {
    if (!panelEditor) return;
    const prompt = panelEditor.prompt.trim();
    if (prompt === '') {
      setCpNotice('Write what this panel should show first.');
      return;
    }
    const label =
      panelEditor.label.trim() ||
      (prompt.length > 34 ? `${prompt.slice(0, 34)}…` : prompt);
    if (panelEditor.id) {
      setCustomPanels((cur) =>
        cur.map((p) =>
          p.id === panelEditor.id
            ? {
                ...p,
                label,
                kind: panelEditor.kind,
                promptModifier: prompt,
                enhancedPrompt: panelEditor.enhancedPrompt,
              }
            : p,
        ),
      );
    } else {
      setCustomPanels((cur) => [
        ...cur,
        {
          id: newPanelId(),
          kind: panelEditor.kind,
          label,
          promptModifier: prompt,
          selected: true,
          enhancedPrompt: panelEditor.enhancedPrompt,
        },
      ]);
    }
    setPanelEditor(null);
  };

  /** Enhanced text was composed for a specific character + stack — changing
   *  either makes it stale, so it drops rather than silently mismatching. */
  const dropStaleEnhancements = () => {
    setCustomPanels((cur) =>
      cur.map((p) => (p.enhancedPrompt ? { ...p, enhancedPrompt: undefined } : p)),
    );
    setPanelEditor(null);
    setCpPhase('idle');
    setCpQuote(null);
    setCpNotice(null);
  };

  // --- render ------------------------------------------------------------------

  // Gate on hydration: before `ready`, the lists are empty because they
  // haven't LOADED, not because they're empty — showing the create-first
  // cards (or selects that display a character the state doesn't have) is
  // the cold-open dead end from the UX audit.
  if (!library.ready) {
    return (
      <Card>
        <Group gap="sm" align="center">
          <Loader size="sm" />
          <span style={{ fontSize: 14 }}>Loading your library…</span>
        </Group>
      </Card>
    );
  }

  if (library.characters.length === 0) {
    return (
      <Card>
        <Stack gap="sm">
          <p style={{ margin: 0, opacity: 0.75 }}>
            Sheets are built from a character — you don’t have one yet, so
            let’s fix that first.
          </p>
          <div>
            <Button onClick={onCreateCharacter} data-testid="builder-create-character">
              Create a character
            </Button>
          </div>
        </Stack>
      </Card>
    );
  }

  const busy = phase === 'estimating' || phase === 'submitting' || phase === 'needs-consent';

  // Per-pool balance display. 'auto' lets the host pick the pool, so show the
  // combined balance; a picked pool shows that pool's balance.
  const balanceText =
    balance == null
      ? null
      : account === 'auto'
        ? `Balance: ${formatCost(balance.blue + balance.green + balance.yellow)} Buzz`
        : `Balance: ${formatCost(balance[account])} Buzz (${accountLabel(account)})`;

  // The numeric balance the chosen pool will actually draw from — the
  // confirm card compares the total against it and refuses to arm Generate
  // when the wallet can't cover the sheet (learn it HERE, not from N failed
  // panels afterwards). Unknown balance (still loading) never blocks.
  const spendableBalance =
    balance == null
      ? null
      : account === 'auto'
        ? balance.blue + balance.green + balance.yellow
        : balance[account];
  const shortBy =
    totalEstimate != null && spendableBalance != null && totalEstimate > spendableBalance
      ? totalEstimate - spendableBalance
      : null;

  const panelCount = allSpecs.length + customPanels.length;

  return (
    <Stack gap="md">
      {error && <Alert color="error">{error}</Alert>}

      {phase === 'needs-consent' && (
        <Alert color="info">
          <Loader size="sm" /> Waiting for your approval in the Civitai dialog…
        </Alert>
      )}
      {phase === 'consent-unavailable' && (
        <Alert color="warning">
          Spending approval isn’t available in this environment, so generations
          can’t run here.
        </Alert>
      )}

      {phase !== 'confirm' ? (
        <Card>
          <Stack gap="md">
            <Group gap="sm" align="center" wrap={false}>
              {step > 0 && (
                <button
                  type="button"
                  className="css-icon-btn"
                  disabled={busy}
                  onClick={() => setStep((s) => Math.max(0, s - 1))}
                  data-testid="builder-step-back"
                  aria-label="Back"
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M15 18l-6-6 6-6" />
                  </svg>
                </button>
              )}
              <div className="css-builder-steps" role="tablist" aria-label="Sheet builder steps">
                {BUILDER_STEPS.map((label, i) => (
                  <button
                    key={label}
                    type="button"
                    className="css-step-link"
                    role="tab"
                    aria-current={i === step ? 'step' : undefined}
                    disabled={busy}
                    onClick={() => setStep(i)}
                    data-testid={`builder-step-tab-${i}`}
                  >
                    {i + 1}. {label}
                  </button>
                ))}
              </div>
            </Group>

            {step === 0 && (
              <>
            <div>
              <Select
                label="Character"
                value={characterId}
                onChange={(v) => {
                  setCharacterId(v);
                  dropStaleEnhancements();
                }}
                options={library.characters.map((c) => ({ value: c.id, label: c.name }))}
              />
            </div>

            {/* Stack picker: full-detail cards, plus inline create. */}
            <div>
              <div style={{ fontSize: 14, fontWeight: 500, marginBottom: 6 }}>Stack</div>
              {library.stacks.length === 0 && !stackCreateOpen && (
                <p style={{ margin: '0 0 8px', fontSize: 13, opacity: 0.7 }}>
                  No stacks yet — create the first one right here.
                </p>
              )}
              <div className="css-stack-picker">
                {library.stacks.map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    className="css-choice-card"
                    data-testid="builder-stack-card"
                    data-stack-id={s.id}
                    data-selected={stackId === s.id}
                    aria-pressed={stackId === s.id}
                    disabled={busy}
                    onClick={() => {
                      setStackId(s.id);
                      dropStaleEnhancements();
                    }}
                  >
                    <div style={{ fontWeight: 600, fontSize: 15 }}>{s.name}</div>
                    <div style={{ fontSize: 13, opacity: 0.8, marginTop: 2 }}>
                      {checkpointDisplayLabel(s.checkpoint)}
                    </div>
                    <Group gap="xs" wrap style={{ marginTop: 8 }}>
                      <Badge size="sm" variant="light">{s.checkpoint.baseModel}</Badge>
                      <Badge size="sm" variant="outline">
                        {s.loras.length} LoRA{s.loras.length === 1 ? '' : 's'}
                      </Badge>
                    </Group>
                    {s.loras.length > 0 && (
                      <Stack gap={2} style={{ marginTop: 8 }}>
                        {s.loras.map((l) => (
                          <span key={l.modelVersionId} style={{ fontSize: 12, opacity: 0.75 }}>
                            {l.name ?? `LoRA #${l.modelVersionId}`} · {l.strength}
                            {l.triggerWords.length > 0 ? ` · ${l.triggerWords.join(', ')}` : ''}
                          </span>
                        ))}
                      </Stack>
                    )}
                    {s.notes && (
                      <div style={{ fontSize: 12, opacity: 0.6, marginTop: 8 }}>{s.notes}</div>
                    )}
                  </button>
                ))}
                <button
                  type="button"
                  className="css-choice-card css-choice-add"
                  data-testid="builder-stack-new"
                  disabled={busy}
                  onClick={() => setStackCreateOpen((v) => !v)}
                >
                  <span style={{ fontSize: 22, lineHeight: 1 }}>＋</span>
                  <span style={{ fontSize: 14, fontWeight: 500 }}>New stack</span>
                </button>
              </div>

              {stackCreateOpen && (
                <div style={{ marginTop: 12 }}>
                  <Group gap="xs" wrap style={{ marginBottom: 10 }}>
                    {STACK_PRESETS.map((p) => (
                      <Button
                        key={p.slug}
                        size="sm"
                        variant={stackPreset?.name === p.name ? 'filled' : 'light'}
                        data-testid={`builder-stack-preset-${p.slug}`}
                        onClick={() => setStackPreset({ name: p.name, notes: p.notes })}
                      >
                        {p.label}
                      </Button>
                    ))}
                  </Group>
                  <StackEditor
                    key={stackPreset?.name ?? 'blank'}
                    preset={stackPreset ?? undefined}
                    onClose={() => {
                      setStackCreateOpen(false);
                      setStackPreset(null);
                    }}
                    onSaved={(saved: ModelStack) => {
                      setStackId(saved.id);
                      setStackCreateOpen(false);
                      setStackPreset(null);
                    }}
                    saveStack={library.saveStack}
                  />
                </div>
              )}
            </div>
              </>
            )}

            {step === 2 && (
              <>
            <div style={{ fontSize: 14, opacity: 0.85 }}>
              {character?.name} · {stack?.name} · {chosenSpecs.length} panel
              {chosenSpecs.length === 1 ? '' : 's'}:{' '}
              {chosenSpecs.map((s) => s.label).join(', ')}
            </div>
            <div>
              <Button
                size="sm"
                variant="subtle"
                onClick={() => setShowAdvanced((v) => !v)}
                data-testid="se-builder-advanced-toggle"
              >
                {showAdvanced ? 'Hide advanced settings' : 'Advanced settings'}
              </Button>
            </div>

            {showAdvanced && (
              <Stack gap="sm">
                <Group gap="md" align="flex-start">
                  <div>
                    <NumberInput
                      label="Seed"
                      value={seed}
                      onChange={setSeed}
                      min={0}
                      style={{ width: 140 }}
                    />
                    <div style={{ fontSize: 12, opacity: 0.65, marginTop: 4, maxWidth: 230 }}>
                      Same seed + same settings ≈ the same image. A fresh one
                      is rolled for you — most people never touch this.
                    </div>
                  </div>
                  <div>
                    <Select
                      label="Buzz pool"
                      value={account}
                      onChange={(v) => setAccount(v as AccountChoice)}
                      options={ACCOUNT_CHOICES.map((a) => ({ value: a, label: accountLabel(a) }))}
                    />
                    <div style={{ fontSize: 12, opacity: 0.65, marginTop: 4, maxWidth: 230 }}>
                      Which of your Buzz balances pays. “Auto” lets Civitai
                      pick for you.
                    </div>
                  </div>
                </Group>
                {character && (
                  <div style={{ fontSize: 13, opacity: 0.7 }}>
                    {character.seedPolicy === 'locked'
                      ? `Seeds are locked for ${character.name} — re-running this sheet reproduces the same panels.`
                      : `Seeds vary for ${character.name} — every panel rolls its own.`}
                    {character.triggerWords.length > 0 &&
                      ` Trigger words added to every prompt: ${character.triggerWords.join(', ')}.`}
                  </div>
                )}
              </Stack>
            )}
              </>
            )}

            {step === 1 && (
              <>
            {/* Panel picker: icon cards instead of a checkbox list. */}
            <div>
              <div style={{ fontSize: 14, fontWeight: 500, marginBottom: 6 }}>
                Panels ({chosenSpecs.length}/{panelCount})
              </div>
              <div className="css-panel-picker">
                {allSpecs.map((spec, i) => (
                  <button
                    key={`${spec.kind}-${i}`}
                    type="button"
                    className="css-choice-card"
                    data-testid="builder-panel-card"
                    data-kind={spec.kind}
                    data-selected={!!specSelected[i]}
                    aria-pressed={!!specSelected[i]}
                    disabled={busy}
                    onClick={() =>
                      setSpecSelected((cur) => cur.map((v, j) => (j === i ? !v : v)))
                    }
                  >
                    <span className="css-panel-icon">
                      <PanelKindIcon kind={spec.kind} />
                    </span>
                    <div style={{ fontWeight: 500, fontSize: 14 }}>{spec.label}</div>
                    <div
                      style={{
                        fontSize: 12,
                        opacity: 0.6,
                        marginTop: 3,
                        display: '-webkit-box',
                        WebkitLineClamp: 2,
                        WebkitBoxOrient: 'vertical',
                        overflow: 'hidden',
                      }}
                    >
                      {spec.promptModifier}
                    </div>
                  </button>
                ))}
                {customPanels.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    className="css-choice-card"
                    data-testid="builder-panel-custom"
                    data-panel-id={p.id}
                    data-selected={p.selected}
                    aria-pressed={p.selected}
                    disabled={busy}
                    onClick={() =>
                      setCustomPanels((cur) =>
                        cur.map((x) => (x.id === p.id ? { ...x, selected: !x.selected } : x)),
                      )
                    }
                  >
                    <span className="css-panel-icon">
                      <PanelKindIcon kind={p.kind} />
                    </span>
                    <div style={{ fontWeight: 500, fontSize: 14 }}>{p.label}</div>
                    <Group gap="xs" style={{ marginTop: 4 }}>
                      <Badge size="sm" color="grape" variant="light">Custom</Badge>
                      {p.enhancedPrompt && (
                        <Badge size="sm" color="grape">Enhanced ✦</Badge>
                      )}
                    </Group>
                    <div
                      style={{
                        fontSize: 12,
                        opacity: 0.6,
                        marginTop: 3,
                        display: '-webkit-box',
                        WebkitLineClamp: 2,
                        WebkitBoxOrient: 'vertical',
                        overflow: 'hidden',
                      }}
                    >
                      {p.promptModifier}
                    </div>
                    <span
                      role="button"
                      aria-label={`Edit ${p.label}`}
                      data-testid={`builder-panel-edit-${p.id}`}
                      style={{ position: 'absolute', bottom: 8, right: 34, fontSize: 12, opacity: 0.75 }}
                      onClick={(e) => {
                        e.stopPropagation();
                        openPanelEditor(p);
                      }}
                    >
                      Edit
                    </span>
                    <span
                      role="button"
                      aria-label={`Remove ${p.label}`}
                      data-testid={`builder-panel-remove-${p.id}`}
                      style={{ position: 'absolute', bottom: 8, right: 10, fontSize: 14, opacity: 0.75 }}
                      onClick={(e) => {
                        e.stopPropagation();
                        setCustomPanels((cur) => cur.filter((x) => x.id !== p.id));
                      }}
                    >
                      ×
                    </span>
                  </button>
                ))}
                <button
                  type="button"
                  className="css-choice-card css-choice-add"
                  data-testid="builder-panel-new"
                  disabled={busy}
                  onClick={() => openPanelEditor()}
                >
                  <span style={{ fontSize: 22, lineHeight: 1 }}>＋</span>
                  <span style={{ fontSize: 14, fontWeight: 500 }}>New panel</span>
                </button>
              </div>

              {panelEditor && (
                <Card padding="sm" style={{ marginTop: 12 }} data-testid="builder-panel-editor">
                  <Stack gap="sm">
                    <Group justify="space-between" align="center">
                      <strong style={{ fontSize: 14 }}>
                        {panelEditor.id ? 'Edit panel' : 'New panel'}
                      </strong>
                      <Button size="sm" variant="subtle" onClick={() => setPanelEditor(null)}>
                        Cancel
                      </Button>
                    </Group>
                    <Group gap="md" align="flex-end">
                      <TextInput
                        label="Label"
                        placeholder="Riding the sky-whale"
                        value={panelEditor.label}
                        onChange={(e) => {
                          const value = e.currentTarget.value;
                          setPanelEditor((cur) =>
                            cur ? { ...cur, label: value } : cur,
                          );
                        }}
                        data-testid="builder-panel-label"
                      />
                      <Select
                        label="Type"
                        value={panelEditor.kind}
                        onChange={(v) =>
                          setPanelEditor((cur) =>
                            cur ? { ...cur, kind: v as PanelKind } : cur,
                          )
                        }
                        options={PANEL_KINDS.map((k) => ({ value: k, label: PANEL_LABELS[k] }))}
                        data-testid="builder-panel-kind"
                      />
                    </Group>
                    <Textarea
                      label="Prompt"
                      placeholder="riding a sky-whale at dawn, wind in her hair, distant floating islands"
                      value={panelEditor.prompt}
                      onChange={(e) => {
                        const value = e.currentTarget.value;
                        // Typing over an enhanced prompt returns authorship
                        // to the viewer — drop the now-stale rewrite.
                        setPanelEditor((cur) =>
                          cur ? { ...cur, prompt: value, enhancedPrompt: undefined } : cur,
                        );
                        setCpQuote(null);
                        setCpPhase('idle');
                      }}
                      rows={3}
                      data-testid="builder-panel-prompt"
                    />

                    {/* Enhancement lives here only — for panels being written. */}
                    <Stack gap="xs">
                      <Group justify="space-between" align="center">
                        <span style={{ fontSize: 13, opacity: 0.7 }}>
                          AI can rewrite this prompt with richer visual detail —
                          priced first, like everything else.
                        </span>
                        <Button
                          variant="light"
                          color="grape"
                          onClick={startCpEnhance}
                          loading={cpPhase === 'estimating' || cpPhase === 'running'}
                          disabled={busy || cpPhase === 'confirming'}
                          data-testid="se-enhance"
                        >
                          {cpPhase === 'running'
                            ? 'Enhancing…'
                            : cpPhase === 'estimating'
                              ? 'Pricing…'
                              : 'Enhance prompt ✦'}
                        </Button>
                      </Group>
                      {cpConsentWait && (
                        <Alert color="info" data-testid="se-enhance-consent">
                          <Loader size="sm" /> Waiting for your approval in the Civitai dialog…
                        </Alert>
                      )}
                      {cpPhase === 'confirming' && cpQuote != null && (
                        <Alert color="info" data-testid="se-enhance-confirm">
                          <Stack gap="xs">
                            <span>
                              Enhance 1 prompt · ≈{formatCost(cpQuote)} Buzz
                            </span>
                            <Group justify="flex-end">
                              <Button
                                variant="subtle"
                                onClick={() => {
                                  setCpQuote(null);
                                  setCpPhase('idle');
                                }}
                              >
                                Cancel
                              </Button>
                              <Button
                                color="grape"
                                onClick={() => void runCpEnhanceSubmit()}
                                data-testid="se-enhance-confirm-run"
                              >
                                Enhance · {formatCost(cpQuote)} Buzz
                              </Button>
                            </Group>
                          </Stack>
                        </Alert>
                      )}
                      {panelEditor.enhancedPrompt && (
                        <Alert color="info" data-testid="se-enhance-applied">
                          <Stack gap={4}>
                            <span>
                              <Badge size="sm" color="grape">Enhanced ✦</Badge>
                            </span>
                            <span style={{ fontSize: 13 }}>{panelEditor.enhancedPrompt}</span>
                            <span style={{ fontSize: 12, opacity: 0.65 }}>
                              This panel generates from the enhanced text. Edit
                              the prompt above to use your own words instead.
                            </span>
                          </Stack>
                        </Alert>
                      )}
                      {cpNotice && (
                        <Alert color="info" data-testid="se-enhance-notice">
                          {cpNotice}
                        </Alert>
                      )}
                    </Stack>

                    <Group justify="flex-end">
                      <Button onClick={savePanelEditor} data-testid="builder-panel-add">
                        {panelEditor.id ? 'Save panel' : 'Add panel'}
                      </Button>
                    </Group>
                  </Stack>
                </Card>
              )}
            </div>
              </>
            )}

            {step === 2 && (
              <>
            {character?.referenceImage && (
              <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 14, cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={useReference}
                  disabled={busy}
                  onChange={(e) => setUseReference(e.target.checked)}
                />
                Use reference portrait as img2img source
              </label>
            )}

            {phase === 'estimating' && (
              <Group gap="sm" align="center">
                <Loader size="sm" />
                <span style={{ fontSize: 14 }}>
                  Pricing panels… {Object.keys(estimates).length}/{chosenSpecs.length}
                </span>
              </Group>
            )}
            {phase === 'submitting' && submitProgress && (
              <Group gap="sm" align="center">
                <Loader size="sm" />
                <span style={{ fontSize: 14 }}>
                  Submitting panels… {submitProgress.done}/{submitProgress.total}
                </span>
              </Group>
            )}

            <Group justify="space-between" align="center">
              <span style={{ fontSize: 13, opacity: 0.7 }}>
                {balanceText ?? ' '}
              </span>
              <Button
                onClick={startPricing}
                loading={phase === 'estimating'}
                disabled={busy || chosenSpecs.length === 0}
                data-testid="se-builder-price"
              >
                {anon
                  ? 'Sign in to generate'
                  : chosenSpecs.length === 0
                    ? 'Select a panel to price'
                    : `Price ${chosenSpecs.length} panel${chosenSpecs.length === 1 ? '' : 's'}`}
              </Button>
            </Group>
              </>
            )}

            {step < 2 && (
              <Group justify="flex-end" align="center">
                <Button
                  disabled={
                    busy ||
                    (step === 0 && (!characterId || !stackId)) ||
                    (step === 1 && chosenSpecs.length === 0)
                  }
                  onClick={() => setStep((s) => Math.min(2, s + 1))}
                  data-testid="builder-step-next"
                >
                  Continue
                </Button>
              </Group>
            )}
          </Stack>
        </Card>
      ) : (
        draft && (
          <Card>
            <Stack gap="sm">
              <Group gap="sm" align="center">
                <button
                  type="button"
                  className="css-icon-btn"
                  data-testid="se-confirm-back"
                  aria-label="Back"
                  onClick={() => {
                    setDraft(null);
                    setEstimates({});
                    setPhase('idle');
                  }}
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M15 18l-6-6 6-6" />
                  </svg>
                </button>
                <h3 style={{ margin: 0 }}>Confirm sheet</h3>
              </Group>
              <div style={{ fontSize: 14, opacity: 0.8 }}>
                {character?.name} · {stack?.name} · {draft.panels.length} panels
                {useReference && character?.referenceImage ? ' · img2img from portrait' : ''}
              </div>
              <Stack gap="xs">
                {draft.panels.map((p) => {
                  const e = estimates[p.id];
                  return (
                    <Group key={p.id} justify="space-between" align="center">
                      <span style={{ fontSize: 14 }}>{p.label}</span>
                      {e?.cost != null ? (
                        <Badge variant="light">{formatCost(e.cost)} Buzz</Badge>
                      ) : (
                        <Badge color="red">{e?.errorTitle ?? 'no price'}</Badge>
                      )}
                    </Group>
                  );
                })}
              </Stack>
              <Group justify="space-between" align="center">
                <span style={{ fontWeight: 600 }}>
                  Total: {totalEstimate != null ? `${formatCost(totalEstimate)} Buzz` : '—'}
                </span>
                <span style={{ fontSize: 13, opacity: 0.7 }}>
                  {balanceText ?? ''}
                </span>
              </Group>
              {shortBy != null && (
                <Alert color="warning" data-testid="se-builder-insufficient">
                  <Group justify="space-between" align="center" wrap>
                    <span style={{ fontSize: 14 }}>
                      You need {formatCost(shortBy)} more Buzz to run this
                      sheet.
                    </span>
                    <Button
                      size="sm"
                      variant="light"
                      onClick={() => void openPurchaseModal()}
                    >
                      Top up Buzz
                    </Button>
                  </Group>
                </Alert>
              )}
              <Button
                style={{ width: '100%' }}
                onClick={startConfirmedSubmit}
                disabled={totalEstimate == null || shortBy != null}
              >
                Generate {draft.panels.length} panels · {totalEstimate != null ? `${formatCost(totalEstimate)} Buzz` : ''}
              </Button>
            </Stack>
          </Card>
        )
      )}
    </Stack>
  );
}
