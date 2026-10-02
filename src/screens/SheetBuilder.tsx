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
//                   `sheetId-panelId-submitNonce` (a retry after a lost response
//                   reuses the key → one charge, not two)
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
import type { BlockWorkflowSnapshot } from '@civitai/app-sdk/blocks';

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
  onOpenSheet: (sheetId: string) => void;
  /** Take the viewer to the Stacks tab so they can create a stack. */
  onCreateStack: () => void;
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

export function SheetBuilder({ library, preselectedCharacterId, onOpenSheet, onCreateStack }: SheetBuilderProps) {
  const { ready, viewer } = useBlockContext();
  const token = useBlockToken();
  const { balance } = useBuzzBalance();
  const { estimate, submit } = useBuzzWorkflow();
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

  const consentIntentRef = useRef<'estimate' | 'submit' | null>(null);
  const runEstimateRef = useRef<() => void>(() => {});
  const runSubmitRef = useRef<() => void>(() => {});

  const character = library.characters.find((c) => c.id === characterId);
  const stack = library.stacks.find((s) => s.id === stackId);

  // Default the stack to the character's preferred stack when the character changes.
  useEffect(() => {
    const c = library.characters.find((x) => x.id === characterId);
    if (!c) return;
    setStackId((cur) => {
      if (cur && library.stacks.some((s) => s.id === cur)) return cur;
      return c.defaultStackId && library.stacks.some((s) => s.id === c.defaultStackId)
        ? (c.defaultStackId as string)
        : (library.stacks[0]?.id ?? '');
    });
    // Re-sync only when the character or the stack list changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [characterId, library.characters, library.stacks]);

  // If the preselected character arrives after mount (deep link), adopt it.
  useEffect(() => {
    if (preselectedCharacterId) setCharacterId(preselectedCharacterId);
  }, [preselectedCharacterId]);

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
    if (!c) {
      setError('Pick a character first.');
      return;
    }
    if (!s) {
      setError('Pick a stack first — create one on the Stacks screen.');
      return;
    }
    const specs = allSpecs.filter((_, i) => specSelected[i]);
    if (specs.length === 0) {
      setError('Select at least one panel.');
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
        }
      } catch (err) {
        // Never the raw server prose — classify the rejection shape.
        const rej = classifySubmitRejection(err);
        if (rej.kind === 'workflow-failed' && rej.pollWorkflowId) {
          // Money may be committed; the poll loop learns the actual fate.
          panel.workflowId = rej.pollWorkflowId;
          panel.status = 'running';
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
    if (anon) {
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
  }, [anon, granted, requestConsentFor, requestSignIn]);

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

  // --- render ------------------------------------------------------------------

  if (library.characters.length === 0) {
    return (
      <Card>
        <p style={{ margin: 0, opacity: 0.75 }}>
          Create a character first — then come back to build a sheet from it.
        </p>
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
            <Button onClick={onCreateStack} data-testid="builder-create-stack">
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
                onChange={setCharacterId}
                options={library.characters.map((c) => ({ value: c.id, label: c.name }))}
              />
              <Select
                label="Stack"
                value={stackId}
                onChange={setStackId}
                options={library.stacks.map((s) => ({ value: s.id, label: s.name }))}
              />
              <NumberInput
                label="Seed"
                value={seed}
                onChange={setSeed}
                min={0}
                style={{ width: 140 }}
              />
              <Select
                label="Buzz pool"
                value={account}
                onChange={(v) => setAccount(v as AccountChoice)}
                options={ACCOUNT_CHOICES.map((a) => ({ value: a, label: accountLabel(a) }))}
              />
            </Group>

            {character && (
              <div style={{ fontSize: 13, opacity: 0.7 }}>
                Seed policy: {character.seedPolicy === 'locked' ? 'locked — re-running reproduces the sheet' : 'varied — random per panel'}
                {character.triggerWords.length > 0 && ` · trigger words: ${character.triggerWords.join(', ')}`}
              </div>
            )}

            <div>
              <div style={{ fontSize: 14, fontWeight: 500, marginBottom: 6 }}>
                Panels ({selectedSpecs.length}/{allSpecs.length})
              </div>
              <Stack gap="xs">
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
                    <Badge size="sm" variant="outline">{spec.kind}</Badge>
                  </label>
                ))}
              </Stack>
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
              <Button onClick={startPricing} loading={phase === 'estimating'} disabled={busy && phase !== 'estimating'}>
                Price {selectedSpecs.length} panel{selectedSpecs.length === 1 ? '' : 's'}
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
                {character?.name} · {stack?.name} · {draft.panels.length} panels · seed {draft.seed}
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
                  disabled={totalEstimate == null}
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
