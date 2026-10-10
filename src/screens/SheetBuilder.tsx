// Sheet Builder: configure a sheet, price every panel, confirm once, submit.
//
// The batch money path, in order:
//   1. setup      — character + stack + panels + seed (+ optional img2img)
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
import type { PanelSpec, SheetJob } from '../sheet/types.js';
import { defaultPanelSpecs, newSheetJob } from '../sheet/types.js';
import type { SheetLibrary } from '../sheet/useSheetLibrary.js';
import { storeErrorMessage } from './common.js';

export interface SheetBuilderProps {
  library: SheetLibrary;
  preselectedCharacterId: string | null;
  /** Stack handed over by a return trip from the Stacks tab (create flow). */
  preselectedStackId?: string | null;
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

interface PanelEstimate {
  cost?: number;
  errorTitle?: string;
  errorBody?: string;
}

function randomSeed(): number {
  return 100000 + Math.floor(Math.random() * 900000);
}

export function SheetBuilder({ library, preselectedCharacterId, preselectedStackId, onOpenSheet, onCreateStack, onCreateCharacter }: SheetBuilderProps) {
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
  const [seed, setSeed] = useState<number | null>(() => randomSeed());
  const [useReference, setUseReference] = useState(false);
  const [account, setAccount] = useState<AccountChoice>('auto');

  const [phase, setPhase] = useState<BuilderPhase>('idle');
  const [draft, setDraft] = useState<SheetJob | null>(null);
  const [estimates, setEstimates] = useState<Record<string, PanelEstimate>>({});
  const [submitProgress, setSubmitProgress] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);

  // Prompt enhancement (AI rewrite per selected panel, priced before it runs).
  const [enhancedBySpec, setEnhancedBySpec] = useState<Record<number, string>>({});
  const [enhancePhase, setEnhancePhase] = useState<
    'idle' | 'estimating' | 'confirming' | 'running'
  >('idle');
  const [enhanceQuote, setEnhanceQuote] = useState<{
    total: number;
    specIndexes: number[];
  } | null>(null);
  const [enhanceNotice, setEnhanceNotice] = useState<string | null>(null);
  const [enhanceConsentWait, setEnhanceConsentWait] = useState(false);
  const enhanceIntentRef = useRef(false);
  const enhanceRunRef = useRef(0);
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

  const selectedSpecs: PanelSpec[] = useMemo(
    () => allSpecs.filter((_, i) => specSelected[i]),
    [allSpecs, specSelected],
  );

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
      setError('Pick a stack first — create one on the Stacks screen.');
      setPhase('idle');
      return;
    }
    const specs = allSpecs.filter((_, i) => specSelected[i]);
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
    const selectedIdx = allSpecs
      .map((_, i) => i)
      .filter((i) => specSelected[i]);
    job.panels = job.panels.map((p, i) => ({
      ...p,
      seed: resolvePanelSeed(seedVal, i, c.seedPolicy),
      // AI-enhanced prompts (if the viewer enhanced before pricing) ride the
      // panel into the sheet — the composer then uses them verbatim.
      ...(enhancedBySpec[selectedIdx[i]]
        ? { enhancedPrompt: enhancedBySpec[selectedIdx[i]] }
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
    allSpecs,
    bodyOpts,
    characterId,
    enhancedBySpec,
    estimate,
    library.characters,
    library.settings,
    library.stacks,
    seed,
    specSelected,
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
      setError('Pick a stack first — create one on the Stacks screen.');
      return;
    }
    if (selectedSpecs.length === 0) {
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
    granted,
    requestConsentFor,
    requestSignIn,
    selectedSpecs.length,
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

  // --- prompt enhancement ------------------------------------------------------
  // An AI rewrite of each selected panel's composed prompt through the host's
  // registered chat-completion step. Same money rules as generation: estimate
  // every call, park ONE confirm with the summed price, submit only on
  // confirm. The enhanced text is kept per spec index and lands on the sheet's
  // panels at creation, where the composer uses it verbatim — so regenerates
  // stay byte-identical to the original run.

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

  const estimateEnhance = useCallback(async () => {
    const c = library.characters.find((x) => x.id === characterId);
    const s = library.stacks.find((x) => x.id === stackId);
    if (!c || !s) {
      setEnhanceNotice('Pick a character and a stack first.');
      setEnhancePhase('idle');
      return;
    }
    const indexes = allSpecs.map((_, i) => i).filter((i) => specSelected[i]);
    if (indexes.length === 0) {
      setEnhanceNotice('Select at least one panel to enhance.');
      setEnhancePhase('idle');
      return;
    }
    setEnhancePhase('estimating');
    setEnhanceNotice(null);
    setEnhanceQuote(null);
    let total = 0;
    try {
      for (const i of indexes) {
        const composed = composePanelPrompt(
          c,
          s,
          { ...allSpecs[i], id: 'enhance-tmp', seed: 0, status: 'queued', outputs: [], submitNonce: 0 },
          library.settings,
        ).prompt;
        const snap = await estimate(buildEnhanceBody(composed, s.checkpoint.baseModel));
        const cost = snap.cost?.total;
        if (snap.status === 'failed' || snap.error || typeof cost !== 'number') {
          setEnhanceNotice(
            'Couldn’t price the enhancement — your original prompts are unchanged.',
          );
          setEnhancePhase('idle');
          return;
        }
        total += cost;
      }
    } catch {
      setEnhanceNotice(
        'Couldn’t price the enhancement — your original prompts are unchanged.',
      );
      setEnhancePhase('idle');
      return;
    }
    setEnhanceQuote({ total, specIndexes: indexes });
    setEnhancePhase('confirming');
  }, [allSpecs, characterId, estimate, library, specSelected, stackId]);
  const estimateEnhanceRef = useRef(estimateEnhance);
  estimateEnhanceRef.current = estimateEnhance;

  const startEnhance = useCallback(() => {
    setEnhanceNotice(null);
    if (!characterId) {
      setEnhanceNotice('Pick a character first.');
      return;
    }
    if (!stackId) {
      setEnhanceNotice('Pick a stack first.');
      return;
    }
    if (selectedSpecs.length === 0) {
      setEnhanceNotice('Select at least one panel to enhance.');
      return;
    }
    if (anon) {
      requestSignIn();
      setEnhanceNotice("You're browsing as a guest — sign in to enhance prompts.");
      return;
    }
    if (!granted) {
      // Same consent as generation (the step spends Buzz) — resume into
      // pricing when the grant lands.
      enhanceIntentRef.current = true;
      setEnhanceConsentWait(true);
      requestConsent({ scopes: [BUDGETED_SCOPE] });
      return;
    }
    void estimateEnhanceRef.current();
  }, [
    anon,
    characterId,
    granted,
    requestConsent,
    requestSignIn,
    selectedSpecs.length,
    stackId,
  ]);

  // Auto-resume enhancement pricing after a consent grant.
  useEffect(() => {
    if (granted && enhanceIntentRef.current) {
      enhanceIntentRef.current = false;
      setEnhanceConsentWait(false);
      void estimateEnhanceRef.current();
    }
  }, [granted]);

  useEffect(() => {
    if (refusal && enhanceConsentWait) {
      enhanceIntentRef.current = false;
      setEnhanceConsentWait(false);
      setEnhanceNotice(
        'Spending approval isn’t available in this environment, so enhancement can’t run here.',
      );
    }
  }, [refusal, enhanceConsentWait]);

  const runEnhanceSubmit = useCallback(async () => {
    const quote = enhanceQuote;
    const c = library.characters.find((x) => x.id === characterId);
    const s = library.stacks.find((x) => x.id === stackId);
    if (!quote || !c || !s) {
      setEnhancePhase('idle');
      setEnhanceQuote(null);
      return;
    }
    setEnhancePhase('running');
    enhanceRunRef.current += 1;
    const runId = enhanceRunRef.current;
    const results: Record<number, string> = {};
    let failures = 0;
    let withheld: string | null = null;
    for (const i of quote.specIndexes) {
      const composed = composePanelPrompt(
        c,
        s,
        { ...allSpecs[i], id: 'enhance-tmp', seed: 0, status: 'queued', outputs: [], submitNonce: 0 },
        library.settings,
      ).prompt;
      const outcome = await runEnhanceWorkflowRef.current(
        buildEnhanceBody(composed, s.checkpoint.baseModel),
        idempotencyKeyFor('enhance', `${c.id}:${i}`, runId),
      );
      if (outcome.type === 'text') results[i] = outcome.text;
      else {
        failures += 1;
        if (outcome.type === 'withheld') withheld = outcome.reason;
      }
    }
    setEnhancedBySpec((cur) => ({ ...cur, ...results }));
    setEnhanceQuote(null);
    setEnhancePhase('idle');
    // A prompt change invalidates any priced draft — the confirmed price must
    // always match the submitted body byte-for-byte.
    setDraft(null);
    setEstimates({});
    if (phase === 'confirm') setPhase('idle');
    const got = Object.keys(results).length;
    if (got > 0 && failures === 0) {
      setEnhanceNotice(
        `Enhanced ${got} prompt${got === 1 ? '' : 's'} — look for the Enhanced badges below, then price when you're ready.`,
      );
    } else if (got > 0) {
      setEnhanceNotice(
        `Enhanced ${got} of ${quote.specIndexes.length} prompts — the rest keep their original text.`,
      );
    } else if (withheld) {
      setEnhanceNotice(
        `The enhancement was withheld: ${withheld} Your original prompts are unchanged.`,
      );
    } else {
      setEnhanceNotice(
        'The enhancement didn’t come back — your original prompts are unchanged.',
      );
    }
  }, [allSpecs, characterId, enhanceQuote, library, phase, stackId]);

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
  if (library.stacks.length === 0) {
    return (
      <Card>
        <Stack gap="sm">
          <p style={{ margin: 0, opacity: 0.75 }}>
            Sheets generate with a stack — a checkpoint plus LoRAs. You don’t
            have one yet, so let’s fix that first.
          </p>
          <div>
            <Button
              onClick={() => onCreateStack(characterId)}
              data-testid="builder-create-stack"
            >
              Create a stack
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

  return (
    <Stack gap="md">
      <h2 style={{ margin: 0, fontSize: 20 }}>Sheet Builder</h2>

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
          <Stack gap="sm">
            <Group gap="md" align="flex-end">
              <Select
                label="Character"
                value={characterId}
                onChange={(v) => {
                  setCharacterId(v);
                  // Enhanced prompts are composed from the old character —
                  // they don't carry over to a different one.
                  setEnhancedBySpec({});
                  setEnhanceQuote(null);
                  setEnhancePhase('idle');
                  setEnhanceNotice(null);
                }}
                options={library.characters.map((c) => ({ value: c.id, label: c.name }))}
              />
              <Select
                label="Stack"
                value={stackId}
                onChange={(v) => {
                  setStackId(v);
                  // The rewrite is tuned to the old checkpoint's family.
                  setEnhancedBySpec({});
                  setEnhanceQuote(null);
                  setEnhancePhase('idle');
                  setEnhanceNotice(null);
                }}
                options={library.stacks.map((s) => ({ value: s.id, label: s.name }))}
              />
            </Group>

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

            <div>
              <div style={{ fontSize: 14, fontWeight: 500, marginBottom: 6 }}>
                Panels ({selectedSpecs.length}/{allSpecs.length})
              </div>
              <div className="css-panel-picker">
                {allSpecs.map((spec, i) => (
                  <label
                    key={`${spec.kind}-${i}`}
                    style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 14, cursor: 'pointer' }}
                  >
                    <input
                      type="checkbox"
                      checked={!!specSelected[i]}
                      disabled={busy}
                      onChange={(e) =>
                        setSpecSelected((cur) => cur.map((v, j) => (j === i ? e.target.checked : v)))
                      }
                    />
                    <span style={{ fontWeight: 500 }}>{spec.label}</span>
                    <Badge size="sm" variant="outline" style={{ textTransform: 'capitalize' }}>
                      {spec.kind}
                    </Badge>
                    {enhancedBySpec[i] && (
                      <span
                        data-testid="se-enhance-applied"
                        style={{ fontSize: 12, display: 'inline-flex', maxWidth: '45%', flexDirection: 'column' }}
                      >
                        <Badge size="sm" color="grape">Enhanced ✦</Badge>
                        <span style={{ opacity: 0.6, marginTop: 2 }}>{enhancedBySpec[i]}</span>
                      </span>
                    )}
                  </label>
                ))}
              </div>
            </div>

            <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 14, cursor: character?.referenceImage ? 'pointer' : 'default', opacity: character?.referenceImage ? 1 : 0.5 }}>
              <input
                type="checkbox"
                checked={useReference}
                disabled={busy || !character?.referenceImage}
                onChange={(e) => setUseReference(e.target.checked)}
              />
              Use reference portrait as img2img source
              {!character?.referenceImage && ' (no portrait on this character)'}
            </label>

            <Stack gap="xs">
              <Group justify="space-between" align="center">
                <span style={{ fontSize: 13, opacity: 0.7 }}>
                  AI can rewrite the selected prompts with richer visual detail
                  before you price — priced first, like everything else.
                </span>
                <Button
                  variant="light"
                  color="grape"
                  onClick={startEnhance}
                  loading={enhancePhase === 'estimating' || enhancePhase === 'running'}
                  disabled={busy || enhancePhase === 'confirming' || selectedSpecs.length === 0}
                  data-testid="se-enhance"
                >
                  {enhancePhase === 'running'
                    ? 'Enhancing…'
                    : enhancePhase === 'estimating'
                      ? 'Pricing…'
                      : 'Enhance prompts ✦'}
                </Button>
              </Group>
              {enhanceConsentWait && (
                <Alert color="info" data-testid="se-enhance-consent">
                  <Loader size="sm" /> Waiting for your approval in the Civitai dialog…
                </Alert>
              )}
              {enhancePhase === 'confirming' && enhanceQuote && (
                <Alert color="info" data-testid="se-enhance-confirm">
                  <Stack gap="xs">
                    <span>
                      Enhance {enhanceQuote.specIndexes.length} prompt
                      {enhanceQuote.specIndexes.length === 1 ? '' : 's'} · ≈
                      {formatCost(enhanceQuote.total)} Buzz
                    </span>
                    <Group justify="flex-end">
                      <Button
                        variant="subtle"
                        onClick={() => {
                          setEnhanceQuote(null);
                          setEnhancePhase('idle');
                        }}
                      >
                        Cancel
                      </Button>
                      <Button
                        color="grape"
                        onClick={() => void runEnhanceSubmit()}
                        data-testid="se-enhance-confirm-run"
                      >
                        Enhance · {formatCost(enhanceQuote.total)} Buzz
                      </Button>
                    </Group>
                  </Stack>
                </Alert>
              )}
              {enhanceNotice && (
                <Alert color="info" data-testid="se-enhance-notice">
                  {enhanceNotice}
                </Alert>
              )}
            </Stack>

            {phase === 'estimating' && (
              <Group gap="sm" align="center">
                <Loader size="sm" />
                <span style={{ fontSize: 14 }}>
                  Pricing panels… {Object.keys(estimates).length}/{selectedSpecs.length}
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
                disabled={busy || selectedSpecs.length === 0}
                data-testid="se-builder-price"
              >
                {anon
                  ? 'Sign in to generate'
                  : selectedSpecs.length === 0
                    ? 'Select a panel to price'
                    : `Price ${selectedSpecs.length} panel${selectedSpecs.length === 1 ? '' : 's'}`}
              </Button>
            </Group>
          </Stack>
        </Card>
      ) : (
        draft && (
          <Card>
            <Stack gap="sm">
              <h3 style={{ margin: 0 }}>Confirm sheet</h3>
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
              <Group justify="flex-end">
                <Button
                  variant="subtle"
                  onClick={() => {
                    setDraft(null);
                    setEstimates({});
                    setPhase('idle');
                  }}
                >
                  Back
                </Button>
                <Button
                  onClick={startConfirmedSubmit}
                  disabled={totalEstimate == null || shortBy != null}
                >
                  Generate {draft.panels.length} panels · {totalEstimate != null ? `${formatCost(totalEstimate)} Buzz` : ''}
                </Button>
              </Group>
            </Stack>
          </Card>
        )
      )}
    </Stack>
  );
}
