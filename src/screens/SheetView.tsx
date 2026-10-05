// Sheet View — the per-sheet detail screen: live panel grid, resume-on-mount,
// regenerate / retry / cancel, export, publish.
//
// Resumability: on mount, every panel with a workflowId and a non-terminal
// status gets a poll loop (the ported adaptive-backoff loop — the mock host
// has no watch support). Poll loops cancel on unmount; the sheet is persisted
// after every panel transition, so a tab close mid-batch resumes on the next
// visit. No React-free logic here beyond what batch.ts already covers.

import { useCallback, useEffect, useRef, useState } from 'react';

import {
  useBlockContext,
  useBlockToken,
  useBuzzPurchase,
  useBuzzWorkflow,
  useConsentUnavailable,
  useCreatePostFromApp,
  usePublishGenerationOutputs,
  useRequestConsent,
  useRequestSignIn,
  useSaveImage,
} from '@civitai/blocks-react';
import {
  Alert,
  Badge,
  Button,
  Card,
  Group,
  Loader,
  Stack,
  TextInput,
} from '@civitai/blocks-react/ui';
import type { BlockWorkflowSnapshot } from '@civitai/app-sdk/blocks';

import {
  BUDGETED_SCOPE,
  classifyPricedFailure,
  classifySubmitRejection,
  estimateErrorCopy,
  formatCost,
  hasBudgetedScope,
  isTerminalStatus,
} from '../money/generation.js';
import { startPollLoop } from '../money/pollLoop.js';
import { buildSheetPanelBody } from '../sheet/body.js';
import {
  createPostErrorCopy,
  hasPostsScope,
  isScopeShapedPostError,
  POSTS_SCOPE,
  type CreatePostErrorLike,
} from '../sheet/posting.js';
import {
  deriveSheetStatus,
  idempotencyKeyFor,
  panelErrorCopy,
  pricedKindToErrorCode,
  resumablePanels,
  type PanelErrorCode,
} from '../sheet/batch.js';
import type { SheetJob, SheetPanel } from '../sheet/types.js';
import { isTerminalPanelStatus } from '../sheet/types.js';
import type { SheetLibrary } from '../sheet/useSheetLibrary.js';
import { storeErrorMessage } from './common.js';

interface SheetViewProps {
  library: SheetLibrary;
  sheetId: string;
  onBack: () => void;
}

function randomSeed(): number {
  return Math.floor(Math.random() * 2_147_483_647);
}

/** Elapsed wait for a running panel, m:ss — null when it never started here. */
function formatElapsed(startedAt: string | undefined, nowMs: number): string | null {
  if (!startedAt) return null;
  const start = Date.parse(startedAt);
  if (Number.isNaN(start)) return null;
  const secs = Math.max(0, Math.floor((nowMs - start) / 1000));
  return `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
}

const STATUS_LABEL: Record<SheetPanel['status'], string> = {
  queued: 'Queued',
  running: 'Generating…',
  done: 'Done',
  failed: 'Failed',
  canceled: 'Canceled',
};

const STATUS_COLOR: Record<SheetPanel['status'], string> = {
  queued: 'warning',
  running: 'info',
  done: 'success',
  failed: 'error',
  canceled: 'warning',
};

/** Error codes where a retry reuses the same idempotency key (same nonce). */
function retryReusesKey(panel: SheetPanel): boolean {
  if (!panel.workflowId) return true;
  return panel.errorCode === 'submit-failed' || panel.errorCode === 'submit-interrupted';
}

export function SheetView({ library, sheetId, onBack }: SheetViewProps) {
  const { ready, viewer } = useBlockContext();
  const token = useBlockToken();
  const { estimate, submit, poll, cancel } = useBuzzWorkflow();
  const { openPurchaseModal } = useBuzzPurchase();
  const { requestSignIn } = useRequestSignIn();
  const { requestConsent } = useRequestConsent();
  const { refusal } = useConsentUnavailable();
  const { saveImage } = useSaveImage();
  const { publish } = usePublishGenerationOutputs();
  const { createPost } = useCreatePostFromApp();

  const anon = ready && !viewer;
  const granted = hasBudgetedScope(token?.scopes);

  const [sheet, setSheet] = useState<SheetJob | null>(() =>
    library.sheets.find((s) => s.id === sheetId) ?? null,
  );
  const [error, setError] = useState<string | null>(null);
  const [busyPanel, setBusyPanel] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [consentWait, setConsentWait] = useState(false);
  const [exporting, setExporting] = useState<string | null>(null);
  const [exportFlash, setExportFlash] = useState<string | null>(null);
  const [publishing, setPublishing] = useState<string | null>(null);
  // A priced-but-not-yet-submitted panel action: the viewer sees the exact
  // cost and confirms before any Buzz moves (the batch flow's rule, applied
  // to single panels). `next` is the prepared panel state (new seed for
  // regenerate) so estimate and submit run the identical body.
  const [panelConfirm, setPanelConfirm] = useState<{
    panelId: string;
    mode: 'retry' | 'regenerate';
    cost: number;
    next: SheetPanel;
  } | null>(null);
  // "Submit all queued": every queued panel is priced up front and parked
  // behind ONE confirm showing the total, then submitted sequentially.
  const [batchBusy, setBatchBusy] = useState(false);
  const [batchConfirm, setBatchConfirm] = useState<{
    items: { panelId: string; next: SheetPanel; cost: number }[];
    total: number;
  } | null>(null);
  const submitAllIntentRef = useRef(false);
  // Post-to-profile: which target is mid-post (panel id or 'sheet'), plus the
  // last post outcome message (Posted ✓ / error copy from posting.ts).
  const [posting, setPosting] = useState<string | null>(null);
  const [postNotice, setPostNotice] = useState<string | null>(null);
  // Which panel's "More" menu (Export / Publish / New variation) is open.
  const [menuPanelId, setMenuPanelId] = useState<string | null>(null);
  // 1s ticker that only runs while a panel is generating — drives the
  // elapsed-time readout on running panels.
  const [nowMs, setNowMs] = useState(() => Date.now());
  const anyRunning = sheet?.panels.some((p) => p.status === 'running') ?? false;
  useEffect(() => {
    if (!anyRunning) return;
    setNowMs(Date.now());
    const t = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [anyRunning]);
  // The posts:write:self grant state + the post parked behind its consent
  // prompt. `postConsentTriedRef` is the one-round-trip guard: a scope
  // failure AFTER a consent round-trip becomes the honest notice instead of
  // looping consent dialogs.
  const postsGranted = hasPostsScope(token?.scopes);
  const postIntentRef = useRef<(() => void) | null>(null);
  const postConsentTriedRef = useRef(false);
  // useBlockToken spreads a fresh object every render, so identity can't
  // detect a re-mint — the raw JWT string can (it changes on every mint).
  const tokenRawRef = useRef(token?.raw);

  const sheetRef = useRef(sheet);
  sheetRef.current = sheet;
  const consentIntentRef = useRef<{ panelId: string; mode: 'retry' | 'regenerate' } | null>(null);

  // Adopt the sheet if it arrives after mount (hydration race with navigation).
  useEffect(() => {
    if (!sheetRef.current) {
      const found = library.sheets.find((s) => s.id === sheetId);
      if (found) setSheet(found);
    }
  }, [library.sheets, sheetId]);

  /** Apply a mutator to the current sheet, render it, and persist best-effort. */
  const updateSheet = useCallback(
    async (mut: (s: SheetJob) => SheetJob): Promise<void> => {
      const cur = sheetRef.current;
      if (!cur) return;
      const next: SheetJob = { ...mut(cur), updatedAt: new Date().toISOString() };
      next.status = deriveSheetStatus(next.panels);
      sheetRef.current = next;
      setSheet(next);
      const saveErr = await library.saveSheet(next);
      if (saveErr) setError(storeErrorMessage(saveErr));
    },
    [library],
  );
  const updateSheetRef = useRef(updateSheet);
  updateSheetRef.current = updateSheet;

  const setPanel = useCallback(
    (panelId: string, mut: (p: SheetPanel) => SheetPanel) =>
      updateSheetRef.current((s) => ({
        ...s,
        panels: s.panels.map((p) => (p.id === panelId ? mut(p) : p)),
      })),
    [],
  );

  const failPanel = useCallback(
    (panelId: string, code: PanelErrorCode) =>
      setPanel(panelId, (p) => ({ ...p, status: 'failed', errorCode: code })),
    [setPanel],
  );

  // --- poll loops ------------------------------------------------------------
  // One loop per panel, keyed by panel id in a registry — so Cancel can stop
  // EXACTLY the loop that would otherwise resurrect its panel by stamping
  // 'running' over the canceled state on the next snapshot (the audit's
  // zombie-panel bug: cancel changed the status but left the loop alive).
  // Every snapshot is also revalidated against the panel's CURRENT state:
  // a panel that is terminal or has moved to a different workflow ignores
  // the loop, and the loop retires itself.

  const pollRef = useRef(poll);
  pollRef.current = poll;

  const pollLoopsRef = useRef(new Map<string, () => void>());

  const stopPanelLoop = useCallback((panelId: string) => {
    const stop = pollLoopsRef.current.get(panelId);
    if (stop) {
      pollLoopsRef.current.delete(panelId);
      stop();
    }
  }, []);

  const stopAllPanelLoops = useCallback(() => {
    const loops = pollLoopsRef.current;
    pollLoopsRef.current = new Map();
    for (const stop of loops.values()) stop();
  }, []);

  const startPanelLoop = useCallback(
    (panelId: string, workflowId: string) => {
      stopPanelLoop(panelId);
      const cancelLoop = startPollLoop(pollRef.current, workflowId, {
        onSnapshot: (snap: BlockWorkflowSnapshot) => {
          const current = sheetRef.current?.panels.find((p) => p.id === panelId);
          if (
            !current ||
            current.workflowId !== workflowId ||
            isTerminalPanelStatus(current.status)
          ) {
            stopPanelLoop(panelId);
            return;
          }
          if (snap.status === 'succeeded') {
            stopPanelLoop(panelId);
            void setPanel(panelId, (p) => ({
              ...p,
              status: 'done',
              outputs: snap.imageUrls ?? [],
              errorCode: undefined,
            }));
          } else if (isTerminalStatus(snap.status)) {
            stopPanelLoop(panelId);
            void failPanel(
              panelId,
              pricedKindToErrorCode(classifyPricedFailure(snap.error)),
            );
          } else {
            void setPanel(panelId, (p) =>
              p.status === 'running'
                ? p
                : {
                    ...p,
                    status: 'running',
                    startedAt: p.startedAt ?? new Date().toISOString(),
                  },
            );
          }
        },
        onUnreachable: () => {
          stopPanelLoop(panelId);
          // Transport is down, not the workflow — keep the workflowId so a
          // later visit resumes it.
          void failPanel(panelId, 'poll-unreachable');
        },
      });
      pollLoopsRef.current.set(panelId, cancelLoop);
    },
    [failPanel, setPanel, stopPanelLoop],
  );
  const startPanelLoopRef = useRef(startPanelLoop);
  startPanelLoopRef.current = startPanelLoop;

  // Resume on open: attach a loop to every live workflow. Also heal any
  // panel persisted as 'running' WITHOUT a workflowId (zombie state left
  // behind by the pre-fix cancel bug) back to queued, where Submit is
  // possible again — a revisit must never show a running panel with no
  // action that can resolve it.
  const sheetPresent = sheet !== null;
  useEffect(() => {
    if (!sheetPresent) return;
    const cur = sheetRef.current;
    if (!cur) return;
    if (cur.panels.some((p) => p.status === 'running' && !p.workflowId)) {
      void updateSheetRef.current((s) => ({
        ...s,
        panels: s.panels.map((p) =>
          p.status === 'running' && !p.workflowId
            ? { ...p, status: 'queued', startedAt: undefined }
            : p,
        ),
      }));
    }
    for (const panel of resumablePanels(cur.panels)) {
      startPanelLoopRef.current(panel.id, panel.workflowId as string);
    }
    return () => {
      stopAllPanelLoops();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sheetId, sheetPresent]);

  // --- regenerate / retry ----------------------------------------------------

  const requestConsentFor = useCallback(
    (panelId: string, mode: 'retry' | 'regenerate') => {
      consentIntentRef.current = { panelId, mode };
      setConsentWait(true);
      requestConsent({ scopes: [BUDGETED_SCOPE] });
    },
    [requestConsent],
  );

  /**
   * Price one panel action (retry or regenerate). Estimate is free; the
   * result NEVER submits — it parks a confirm the viewer must accept, so no
   * per-panel spend is ever blind. On estimate failure the panel fails with
   * the priced-refusal code, exactly like the batch flow.
   */
  const pricePanel = useCallback(
    async (panelId: string, mode: 'retry' | 'regenerate') => {
      const cur = sheetRef.current;
      const character = library.characters.find((c) => c.id === cur?.characterId);
      const stack = library.stacks.find((s) => s.id === cur?.stackId);
      const panel = cur?.panels.find((p) => p.id === panelId);
      if (!cur || !character || !stack || !panel) {
        setError('The sheet is gone — go back and reopen it.');
        return;
      }
      const reuseKey = mode === 'retry' && retryReusesKey(panel);
      const next: SheetPanel = {
        ...panel,
        seed: mode === 'regenerate' ? randomSeed() : panel.seed,
        submitNonce: reuseKey ? panel.submitNonce : panel.submitNonce + 1,
        status: 'running',
        workflowId: undefined,
        outputs: [],
        errorCode: undefined,
      };
      const body = buildSheetPanelBody(next, character, stack, library.settings, {
        account: cur.account,
        useReference: cur.useReference,
      });

      setBusyPanel(panelId);
      setError(null);
      setPanelConfirm(null);
      try {
        const est: BlockWorkflowSnapshot = await estimate(body);
        const cost = est.cost?.total;
        if (est.status === 'failed' || est.error || typeof cost !== 'number') {
          await failPanel(
            panelId,
            pricedKindToErrorCode(classifyPricedFailure(est.error)),
          );
          return;
        }
        setPanelConfirm({ panelId, mode, cost, next });
      } catch (err) {
        const code = (err as { code?: unknown } | null)?.code;
        await setPanel(panelId, (p) => ({
          ...p,
          status: 'failed',
          errorCode: 'estimate-failed',
        }));
        setError(`Couldn’t price this panel. ${estimateErrorCopy(code)}`);
      } finally {
        setBusyPanel(null);
      }
    },
    [estimate, failPanel, library, setPanel],
  );
  const pricePanelRef = useRef(pricePanel);
  pricePanelRef.current = pricePanel;

  /**
   * Price every queued panel (never submitted, no workflow id). Each panel
   * that prices clean joins ONE parked confirm with the summed total;
   * priced refusals fail their own panel, exactly like a single submit.
   */
  const priceSubmitAll = useCallback(async () => {
    const cur = sheetRef.current;
    const character = library.characters.find((c) => c.id === cur?.characterId);
    const stack = library.stacks.find((s) => s.id === cur?.stackId);
    if (!cur || !character || !stack) {
      setError('The sheet is gone — go back and reopen it.');
      return;
    }
    const queued = cur.panels.filter((p) => p.status === 'queued' && !p.workflowId);
    if (queued.length === 0) return;
    setBatchBusy(true);
    setError(null);
    setBatchConfirm(null);
    setPanelConfirm(null);
    const items: { panelId: string; next: SheetPanel; cost: number }[] = [];
    let total = 0;
    try {
      for (const panel of queued) {
        // Same prepared-state rule as a single retry: the submitted body is
        // byte-identical to the estimated one (nonce untouched — a queued
        // panel was never submitted, so its key must stay stable).
        const next: SheetPanel = {
          ...panel,
          status: 'running',
          workflowId: undefined,
          outputs: [],
          errorCode: undefined,
        };
        const body = buildSheetPanelBody(next, character, stack, library.settings, {
          account: cur.account,
          useReference: cur.useReference,
        });
        try {
          const est: BlockWorkflowSnapshot = await estimate(body);
          const cost = est.cost?.total;
          if (est.status === 'failed' || est.error || typeof cost !== 'number') {
            await failPanel(panel.id, pricedKindToErrorCode(classifyPricedFailure(est.error)));
            continue;
          }
          items.push({ panelId: panel.id, next, cost });
          total += cost;
        } catch {
          await failPanel(panel.id, 'estimate-failed');
        }
      }
    } finally {
      setBatchBusy(false);
    }
    if (items.length === 0) {
      setError('Couldn’t price the queued panels — each one shows its own error on its card.');
      return;
    }
    setBatchConfirm({ items, total });
  }, [estimate, failPanel, library]);
  const priceSubmitAllRef = useRef(priceSubmitAll);
  priceSubmitAllRef.current = priceSubmitAll;

  /** Submit the prepared panel state (the exact body the viewer priced). */
  const runPanelSubmit = useCallback(
    async (panelId: string, next: SheetPanel) => {
      const cur = sheetRef.current;
      const character = library.characters.find((c) => c.id === cur?.characterId);
      const stack = library.stacks.find((s) => s.id === cur?.stackId);
      if (!cur || !character || !stack) {
        setError('The sheet is gone — go back and reopen it.');
        return;
      }
      const body = buildSheetPanelBody(next, character, stack, library.settings, {
        account: cur.account,
        useReference: cur.useReference,
      });

      setBusyPanel(panelId);
      setError(null);
      try {
        try {
          const snap: BlockWorkflowSnapshot = await submit(body, {
            idempotencyKey: idempotencyKeyFor(cur.id, panelId, next.submitNonce),
          });
          if (isTerminalStatus(snap.status)) {
            if (snap.status === 'succeeded') {
              await setPanel(panelId, () => ({
                ...next,
                status: 'done',
                outputs: snap.imageUrls ?? [],
              }));
            } else {
              await failPanel(
                panelId,
                pricedKindToErrorCode(classifyPricedFailure(snap.error)),
              );
            }
            return;
          }
          await setPanel(panelId, () => ({
            ...next,
            workflowId: snap.workflowId,
            startedAt: new Date().toISOString(),
          }));
          startPanelLoopRef.current(panelId, snap.workflowId);
        } catch (err) {
          const rej = classifySubmitRejection(err);
          if (rej.kind === 'workflow-failed' && rej.pollWorkflowId) {
            // Money may be committed; the poll loop learns the actual fate.
            await setPanel(panelId, () => ({
              ...next,
              workflowId: rej.pollWorkflowId as string,
              startedAt: new Date().toISOString(),
            }));
            startPanelLoopRef.current(panelId, rej.pollWorkflowId as string);
          } else if (rej.kind === 'exception') {
            await failPanel(panelId, 'submit-interrupted');
          } else {
            await failPanel(panelId, 'submit-failed');
          }
        }
      } finally {
        setBusyPanel(null);
      }
    },
    [failPanel, library, setPanel, submit],
  );
  const runPanelSubmitRef = useRef(runPanelSubmit);
  runPanelSubmitRef.current = runPanelSubmit;

  const confirmPanelSubmit = useCallback(() => {
    const c = panelConfirm;
    if (!c) return;
    setPanelConfirm(null);
    void runPanelSubmitRef.current(c.panelId, { ...c.next, cost: c.cost });
  }, [panelConfirm]);

  /** Submit the priced batch sequentially; each submit starts its own poll. */
  const confirmSubmitAll = useCallback(async () => {
    const c = batchConfirm;
    if (!c) return;
    setBatchConfirm(null);
    for (const item of c.items) {
      await runPanelSubmitRef.current(item.panelId, { ...item.next, cost: item.cost });
    }
  }, [batchConfirm]);

  const startPanelAction = useCallback(
    (panelId: string, mode: 'retry' | 'regenerate') => {
      if (anon) {
        requestSignIn();
        return;
      }
      if (!granted) {
        requestConsentFor(panelId, mode);
        return;
      }
      void pricePanelRef.current(panelId, mode);
    },
    [anon, granted, requestConsentFor, requestSignIn],
  );

  const startSubmitAll = useCallback(() => {
    if (anon) {
      requestSignIn();
      return;
    }
    if (!granted) {
      submitAllIntentRef.current = true;
      setConsentWait(true);
      requestConsent({ scopes: [BUDGETED_SCOPE] });
      return;
    }
    void priceSubmitAllRef.current();
  }, [anon, granted, requestConsent, requestSignIn]);

  // Auto-resume the waiting intent after a consent grant.
  useEffect(() => {
    const intent = consentIntentRef.current;
    const wantSubmitAll = submitAllIntentRef.current;
    if (granted && (intent || wantSubmitAll)) {
      consentIntentRef.current = null;
      submitAllIntentRef.current = false;
      setConsentWait(false);
      if (intent) void pricePanelRef.current(intent.panelId, intent.mode);
      else void priceSubmitAllRef.current();
    }
  }, [granted]);

  // A consent refusal is final for this environment. Scoped to GENERATION
  // intents — the post flow parks its own intent and handles refusal itself.
  useEffect(() => {
    if (refusal && (consentIntentRef.current || submitAllIntentRef.current)) {
      consentIntentRef.current = null;
      submitAllIntentRef.current = false;
      setConsentWait(false);
      setError(
        'Spending approval isn’t available in this environment, so panels can’t be regenerated here.',
      );
    }
  }, [refusal]);

  // --- cancel ------------------------------------------------------------------

  const cancelPanel = useCallback(
    async (panel: SheetPanel) => {
      if (!panel.workflowId) return;
      setBusyPanel(panel.id);
      // Stop the poll loop FIRST. As long as it lives, its snapshots keep
      // stamping 'running' over any local state — the audit verified the
      // panel still reading "Generating…" 8s after cancel, persisted as
      // running-with-no-workflow (a zombie no action could resolve).
      stopPanelLoop(panel.id);
      try {
        await cancel(panel.workflowId);
      } catch {
        // Best-effort: the orchestrator may already be done. Either way the
        // panel leaves the live set.
      } finally {
        // Canceled is terminal and LOCAL: the snapshot guard now ignores
        // any stray loop output for this panel. Bump the nonce so a later
        // "Submit again" never idempotently replays the canceled workflow.
        await setPanel(panel.id, (p) => ({
          ...p,
          status: 'canceled',
          workflowId: undefined,
          startedAt: undefined,
          errorCode: undefined,
          submitNonce: p.submitNonce + 1,
        }));
        setBusyPanel(null);
      }
    },
    [cancel, setPanel, stopPanelLoop],
  );

  // --- export / publish ----------------------------------------------------------

  const exportPanel = useCallback(
    async (panel: SheetPanel) => {
      const url = panel.outputs[0];
      if (!url) return;
      setExporting(panel.id);
      try {
        await saveImage({ url, filename: `${panel.label.replace(/\s+/g, '-').toLowerCase()}.png` });
        // Visible confirmation — a silent export reads as a failed one.
        setExportFlash(panel.id);
        window.setTimeout(
          () => setExportFlash((cur) => (cur === panel.id ? null : cur)),
          2000,
        );
      } catch {
        setError('Export failed — the host refused the download. Try again.');
      } finally {
        setExporting(null);
      }
    },
    [saveImage],
  );

  const publishPanel = useCallback(
    async (panel: SheetPanel) => {
      if (!panel.workflowId) return;
      setPublishing(panel.id);
      try {
        await publish({ workflowId: panel.workflowId, imageIndexes: [0], title: panel.label });
        // Persistent marker (survives reload) so Publish never looks unclicked.
        await setPanel(panel.id, (p) => ({ ...p, published: true }));
      } catch {
        setError('Publish failed — the host refused (or you dismissed the confirm).');
      } finally {
        setPublishing(null);
      }
    },
    [publish],
  );

  // --- post to profile -----------------------------------------------------------
  // Publishes a real, feed-visible Civitai post from this app's own workflow
  // outputs (the host re-derives the images server-side; the per-call host
  // confirm IS the consent). Error handling follows the SDK contract in
  // posting.ts: declined → silent, timeout → "check your profile", never
  // auto-retry.

  // Posting publishes to the viewer's PROFILE — a consent-gated scope
  // (posts:write:self). Asking the host cold hits a scope error, so Post
  // checks the token first: no grant → park the action behind the consent
  // prompt and resume it when the host answers (the refreshed token carries
  // the scope, or the grant is action-scoped and the per-call host confirm
  // is the final gate). A scope-shaped failure despite that gets ONE
  // consent round-trip; the second failure is the honest notice.

  const consentForPost = useCallback(
    (action: () => void) => {
      postIntentRef.current = action;
      postConsentTriedRef.current = true;
      setConsentWait(true);
      requestConsent({ scopes: [POSTS_SCOPE] });
    },
    [requestConsent],
  );

  const runPost = useCallback(
    (action: () => void) => {
      if (anon) {
        requestSignIn();
        setPostNotice('Sign in to post to your profile.');
        return;
      }
      if (postsGranted) {
        action();
        return;
      }
      consentForPost(action);
    },
    [anon, consentForPost, postsGranted, requestSignIn],
  );

  // Resume the parked post when the host answers the consent request: the
  // refreshed token either carries the scope or (in hosts that scope the
  // grant to the action) simply signals the grant — the per-call host
  // confirm remains the final gate. A re-mint is detected by the raw JWT
  // changing (useBlockToken returns a fresh object identity every render).
  useEffect(() => {
    const rawChanged = token?.raw !== tokenRawRef.current;
    tokenRawRef.current = token?.raw;
    const action = postIntentRef.current;
    if (!action) return;
    if (!postsGranted && !rawChanged) return;
    postIntentRef.current = null;
    setConsentWait(false);
    action();
  }, [postsGranted, token]);

  // A refused post consent: honest note, never an error wall.
  useEffect(() => {
    if (refusal && postIntentRef.current) {
      postIntentRef.current = null;
      postConsentTriedRef.current = false;
      setConsentWait(false);
      setPostNotice(
        'Posting needs the “post to your profile” permission, which isn’t available in this environment.',
      );
    }
  }, [refusal]);

  const handlePostError = useCallback(
    (err: unknown, retry: () => void) => {
      const e = (err ?? {}) as CreatePostErrorLike;
      // Scope-shaped failure despite everything → one consent round-trip.
      if (isScopeShapedPostError(e) && !postConsentTriedRef.current) {
        consentForPost(retry);
        return;
      }
      const copy = createPostErrorCopy(e);
      if (copy.action === 'sign-in') {
        requestSignIn();
        setPostNotice('Sign in to post to your profile.');
      } else if (copy.action === 'notice') {
        setPostNotice(copy.message);
      }
      // 'silent' — the viewer dismissed the host confirm themselves.
    },
    [consentForPost, requestSignIn],
  );

  const doPostPanel = useCallback(
    async (panel: SheetPanel) => {
      if (!panel.workflowId || !sheet) return;
      setPostNotice(null);
      setPosting(panel.id);
      try {
        const result = await createPost({
          sources: [
            { kind: 'workflow', workflowId: panel.workflowId, imageIndexes: [0] },
          ],
          title: panel.label,
          detail: `From the sheet “${sheet.name}” — made with Character Sheet Studio.`,
        });
        postConsentTriedRef.current = false;
        await setPanel(panel.id, (p) => ({
          ...p,
          posted: true,
          postUrl: result.url,
        }));
        setPostNotice('Posted to your profile ✓');
      } catch (err) {
        handlePostError(err, () => void doPostPanel(panel));
      } finally {
        setPosting(null);
      }
    },
    [createPost, handlePostError, setPanel, sheet],
  );

  const postPanel = useCallback(
    (panel: SheetPanel) => {
      runPost(() => void doPostPanel(panel));
    },
    [doPostPanel, runPost],
  );

  const doPostSheet = useCallback(async () => {
    if (!sheet) return;
    // Only panels not already in a post — the server refuses (or duplicates)
    // images that are already posted.
    const targets = sheet.panels.flatMap((p) =>
      p.status === 'done' && p.workflowId && !p.posted
        ? [{ id: p.id, workflowId: p.workflowId }]
        : [],
    );
    if (targets.length === 0) return;
    setPostNotice(null);
    setPosting('sheet');
    try {
      const result = await createPost({
        sources: targets.map((t) => ({
          kind: 'workflow' as const,
          workflowId: t.workflowId,
          imageIndexes: [0],
        })),
        title: sheet.name,
        detail: `Character sheet — made with Character Sheet Studio.`,
      });
      postConsentTriedRef.current = false;
      const targetIds = new Set(targets.map((t) => t.id));
      await updateSheet((s) => ({
        ...s,
        postUrl: result.url,
        panels: s.panels.map((p) =>
          targetIds.has(p.id) ? { ...p, posted: true, postUrl: result.url } : p,
        ),
      }));
      setPostNotice('Posted to your profile ✓');
    } catch (err) {
      handlePostError(err, () => void doPostSheet());
    } finally {
      setPosting(null);
    }
  }, [createPost, handlePostError, sheet, updateSheet]);

  const postSheet = useCallback(() => {
    runPost(() => void doPostSheet());
  }, [doPostSheet, runPost]);

  // --- rename / delete -------------------------------------------------------------

  const commitRename = useCallback(async () => {
    const name = nameDraft.trim();
    setRenaming(false);
    if (!name) return;
    await updateSheet((s) => ({ ...s, name }));
  }, [nameDraft, updateSheet]);

  const deleteSheet = useCallback(async () => {
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    const err = await library.deleteSheet(sheetId);
    if (err) {
      setError(storeErrorMessage(err));
      setConfirmDelete(false);
      return;
    }
    onBack();
  }, [confirmDelete, library, onBack, sheetId]);

  // --- render ----------------------------------------------------------------------

  if (!library.ready) {
    return (
      <Card>
        <Group gap="sm" align="center">
          <Loader size="sm" />
          <span style={{ fontSize: 14 }}>Loading…</span>
        </Group>
      </Card>
    );
  }

  if (!sheet) {
    return (
      <Stack gap="md">
        <Button variant="subtle" onClick={onBack} style={{ alignSelf: 'flex-start' }}>
          ← All sheets
        </Button>
        <Card>
          <p style={{ margin: 0, opacity: 0.75 }}>This sheet doesn’t exist anymore.</p>
        </Card>
      </Stack>
    );
  }

  const character = library.characters.find((c) => c.id === sheet.characterId);
  const stack = library.stacks.find((s) => s.id === sheet.stackId);
  const doneCount = sheet.panels.filter((p) => p.status === 'done').length;
  const queuedPanels = sheet.panels.filter((p) => p.status === 'queued' && !p.workflowId);
  // Done panels the sheet-level Post can still publish, and the batch-level
  // insufficient-balance group (ONE banner, not one alert per panel).
  const unpostedDone = sheet.panels.filter(
    (p) => p.status === 'done' && p.workflowId && !p.posted,
  );
  const unaffordablePanels = sheet.panels.filter(
    (p) => p.status === 'failed' && p.errorCode === 'unaffordable',
  );
  const sharedFailureIds =
    unaffordablePanels.length >= 2
      ? new Set(unaffordablePanels.map((p) => p.id))
      : new Set<string>();

  return (
    <Stack gap="md">
      <Group justify="space-between" align="center">
        <Button variant="subtle" onClick={onBack}>
          ← All sheets
        </Button>
        <Group gap="sm">
          <Button
            variant="subtle"
            color="error"
            onClick={() => void deleteSheet()}
            onBlur={() => setConfirmDelete(false)}
          >
            {confirmDelete ? 'Confirm delete' : 'Delete'}
          </Button>
        </Group>
      </Group>

      <Card>
        <Stack gap="xs">
          {renaming ? (
            <Group gap="sm">
              <TextInput
                value={nameDraft}
                onChange={(e) => setNameDraft(e.target.value)}
                placeholder="Sheet name"
                style={{ flex: 1 }}
              />
              <Button size="sm" onClick={() => void commitRename()}>
                Save
              </Button>
              <Button size="sm" variant="subtle" onClick={() => setRenaming(false)}>
                Cancel
              </Button>
            </Group>
          ) : (
            <Group gap="sm" align="center">
              <h2 style={{ margin: 0, fontSize: 20 }}>{sheet.name}</h2>
              <Button
                size="sm"
                variant="subtle"
                onClick={() => {
                  setNameDraft(sheet.name);
                  setRenaming(true);
                }}
              >
                Rename
              </Button>
            </Group>
          )}
          <div style={{ fontSize: 14, opacity: 0.8 }}>
            {character?.name ?? 'Unknown character'} · {stack?.name ?? 'Unknown stack'} ·{' '}
            {doneCount}/{sheet.panels.length} panels done
          </div>
          {unpostedDone.length > 0 ? (
            <Group gap="sm" align="center">
              <Button
                size="sm"
                loading={posting === 'sheet'}
                disabled={posting !== null}
                onClick={() => void postSheet()}
                data-testid="se-post-sheet"
              >
                {sheet.postUrl ? 'Post new panels to profile' : 'Post sheet to profile'}
              </Button>
              <span style={{ fontSize: 13, opacity: 0.7 }}>
                {unpostedDone.length} finished panel
                {unpostedDone.length === 1 ? '' : 's'} ready
              </span>
            </Group>
          ) : sheet.postUrl ? (
            <Group gap="sm" align="center">
              <span style={{ fontSize: 13 }}>Posted ✓</span>
              <a
                href={sheet.postUrl}
                target="_blank"
                rel="noreferrer"
                style={{ fontSize: 13 }}
              >
                View post
              </a>
            </Group>
          ) : null}
        </Stack>
      </Card>

      {confirmDelete && (
        <p style={{ margin: 0, fontSize: 13, opacity: 0.75 }}>
          This deletes the sheet and its panel records — generated images stay
          in your Civitai creations.
        </p>
      )}

      {error && <Alert color="error">{error}</Alert>}
      {postNotice && (
        <Alert color="info" data-testid="se-post-notice">
          {postNotice}
        </Alert>
      )}
      {consentWait && (
        <Alert color="info">
          <Loader size="sm" /> Waiting for your approval in the Civitai dialog…
        </Alert>
      )}

      {sharedFailureIds.size > 0 && (
        <Alert color="error" title="Not enough Buzz" data-testid="se-batch-insufficient">
          <Stack gap="xs">
            <span style={{ fontSize: 13 }}>
              {sharedFailureIds.size} panels couldn’t run — your Buzz balance
              doesn’t cover them. Top up, then retry the panels you want.
            </span>
            <div>
              <Button
                size="sm"
                variant="light"
                onClick={() => void openPurchaseModal()}
              >
                Top up Buzz
              </Button>
            </div>
          </Stack>
        </Alert>
      )}

      {batchConfirm ? (
        <Card padding="sm" data-testid="se-submit-all-confirm">
          <Group gap="sm" align="center" wrap>
            <span style={{ fontSize: 14 }}>
              Submit {batchConfirm.items.length} queued panel
              {batchConfirm.items.length === 1 ? '' : 's'}?
            </span>
            <Badge variant="light">≈{formatCost(batchConfirm.total)} Buzz</Badge>
            <Button
              size="sm"
              onClick={() => void confirmSubmitAll()}
              data-testid="se-submit-all-confirm-submit"
            >
              Submit
            </Button>
            <Button size="sm" variant="subtle" onClick={() => setBatchConfirm(null)}>
              Cancel
            </Button>
          </Group>
        </Card>
      ) : (
        queuedPanels.length > 0 && (
          <Card padding="sm">
            <Group justify="space-between" align="center" wrap>
              <span style={{ fontSize: 14 }}>
                {queuedPanels.length} panel{queuedPanels.length === 1 ? '' : 's'}{' '}
                queued — price them together, submit one by one.
              </span>
              <Button
                size="sm"
                loading={batchBusy}
                disabled={batchBusy || busyPanel !== null}
                onClick={startSubmitAll}
                data-testid="se-submit-all"
              >
                Submit all queued ({queuedPanels.length})
              </Button>
            </Group>
          </Card>
        )
      )}

      <div className="css-panel-grid">
        {sheet.panels.map((panel) => {
          const busy = busyPanel === panel.id;
          // A failure shared by 2+ panels is stated ONCE at sheet level;
          // those panels keep only their Retry action.
          const errCopy =
            panel.errorCode && !sharedFailureIds.has(panel.id)
              ? panelErrorCopy(panel.errorCode as PanelErrorCode)
              : null;
          const confirming =
            panelConfirm?.panelId === panel.id && panel.status !== 'running';
          const elapsed = formatElapsed(panel.startedAt, nowMs);
          const menuOpen = menuPanelId === panel.id;
          return (
            <Card key={panel.id} padding="sm">
              <Stack gap="sm">
                <Group justify="space-between" align="center">
                  <strong style={{ fontSize: 14 }}>{panel.label}</strong>
                  {(busy ||
                    panel.status === 'queued' ||
                    panel.status === 'failed' ||
                    panel.status === 'canceled') && (
                    <Badge color={STATUS_COLOR[panel.status]} variant="light">
                      {busy ? 'Working…' : STATUS_LABEL[panel.status]}
                    </Badge>
                  )}
                </Group>

                {panel.outputs[0] ? (
                  <img
                    src={panel.outputs[0]}
                    alt={panel.label}
                    style={{ width: '100%', borderRadius: 6, display: 'block' }}
                  />
                ) : panel.status === 'running' ? (
                  <div
                    className="css-skeleton"
                    data-testid="se-panel-skeleton"
                    role="status"
                    aria-label={`Generating ${panel.label}`}
                    style={{
                      aspectRatio: '1 / 1',
                      borderRadius: 6,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    <span style={{ fontSize: 13, color: 'var(--civitai-color-text-dimmed)' }}>
                      Generating…{elapsed ? ` ${elapsed}` : ''}
                      {panel.cost != null ? ` · ≈${formatCost(panel.cost)} Buzz` : ''}
                    </span>
                  </div>
                ) : (
                  <div
                    style={{
                      aspectRatio: '1 / 1',
                      borderRadius: 6,
                      background: 'var(--civitai-color-surface-2)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      color: 'var(--civitai-color-text-dimmed)',
                      fontSize: 13,
                    }}
                  >
                    No image yet
                  </div>
                )}

                {errCopy && (
                  <Alert color="error" title={errCopy.title}>
                    <span style={{ fontSize: 13 }}>{errCopy.body}</span>
                  </Alert>
                )}

                {errCopy?.showTopUp && (
                  <Button
                    size="sm"
                    variant="light"
                    disabled={busy}
                    onClick={() => void openPurchaseModal()}
                    data-testid="se-panel-top-up"
                  >
                    Top up Buzz
                  </Button>
                )}

                {confirming ? (
                  <Group gap="xs" align="center" wrap>
                    <Badge variant="light">{formatCost(panelConfirm?.cost ?? 0)} Buzz</Badge>
                    <Button size="sm" onClick={confirmPanelSubmit} data-testid="se-panel-confirm-submit">
                      Submit
                    </Button>
                    <Button size="sm" variant="subtle" onClick={() => setPanelConfirm(null)}>
                      Cancel
                    </Button>
                  </Group>
                ) : (
                <Stack gap="xs">
                <Group gap="xs" wrap>
                  {panel.status === 'done' && (
                    <>
                      <Button
                        size="sm"
                        loading={posting === panel.id}
                        disabled={!panel.workflowId || panel.posted || posting !== null}
                        onClick={() => void postPanel(panel)}
                        data-testid="se-panel-post"
                      >
                        {panel.posted ? 'Posted ✓' : 'Post to profile'}
                      </Button>
                      {panel.posted && panel.postUrl && (
                        <a
                          href={panel.postUrl}
                          target="_blank"
                          rel="noreferrer"
                          style={{ fontSize: 13, alignSelf: 'center' }}
                        >
                          View post
                        </a>
                      )}
                      <Button
                        size="sm"
                        variant="subtle"
                        disabled={busy}
                        onClick={() =>
                          setMenuPanelId((cur) => (cur === panel.id ? null : panel.id))
                        }
                        data-testid="se-panel-more"
                      >
                        {menuOpen ? 'Less' : 'More'}
                      </Button>
                    </>
                  )}
                  {(panel.status === 'failed' || panel.status === 'canceled') && (
                    <>
                      <Button
                        size="sm"
                        disabled={busy}
                        onClick={() => startPanelAction(panel.id, 'retry')}
                      >
                        {panel.status === 'canceled' ? 'Submit again' : 'Retry'}
                      </Button>
                      <Button
                        size="sm"
                        variant="subtle"
                        disabled={busy}
                        onClick={() =>
                          setMenuPanelId((cur) => (cur === panel.id ? null : panel.id))
                        }
                        data-testid="se-panel-more"
                      >
                        {menuOpen ? 'Less' : 'More'}
                      </Button>
                    </>
                  )}
                  {panel.status === 'running' && (
                    <Button
                      size="sm"
                      variant="subtle"
                      color="error"
                      disabled={busy || !panel.workflowId}
                      onClick={() => void cancelPanel(panel)}
                    >
                      Cancel
                    </Button>
                  )}
                  {panel.status === 'queued' && !panel.workflowId && !batchConfirm && (
                    <Button
                      size="sm"
                      disabled={busy}
                      onClick={() => startPanelAction(panel.id, 'retry')}
                    >
                      Submit
                    </Button>
                  )}
                </Group>
                {menuOpen &&
                  (panel.status === 'done' ||
                    panel.status === 'failed' ||
                    panel.status === 'canceled') && (
                    <Stack gap={6}>
                      {panel.status === 'done' && (
                        <>
                          <Group gap="xs" align="center" wrap>
                            <Button
                              size="sm"
                              variant="subtle"
                              loading={exporting === panel.id}
                              disabled={exportFlash === panel.id}
                              onClick={() => void exportPanel(panel)}
                            >
                              {exportFlash === panel.id ? 'Exported ✓' : 'Export'}
                            </Button>
                            <span style={{ fontSize: 12, opacity: 0.65 }}>
                              Download this panel’s image
                            </span>
                          </Group>
                          <Group gap="xs" align="center" wrap>
                            <Button
                              size="sm"
                              variant="subtle"
                              loading={publishing === panel.id}
                              disabled={!panel.workflowId || panel.published}
                              onClick={() => void publishPanel(panel)}
                            >
                              {panel.published ? 'Published ✓' : 'Publish'}
                            </Button>
                            <span style={{ fontSize: 12, opacity: 0.65 }}>
                              List it on Civitai as a generation — Post (above)
                              shares it to your profile instead
                            </span>
                          </Group>
                        </>
                      )}
                      <Group gap="xs" align="center" wrap>
                        <Button
                          size="sm"
                          variant="subtle"
                          disabled={busy}
                          onClick={() => startPanelAction(panel.id, 'regenerate')}
                        >
                          New variation
                        </Button>
                        <span style={{ fontSize: 12, opacity: 0.65 }}>
                          {panel.status === 'done'
                            ? 'Fresh take — new seed, same setup'
                            : 'New seed, fresh take — the button above re-runs the same seed'}
                        </span>
                      </Group>
                    </Stack>
                  )}
                </Stack>
                )}
              </Stack>
            </Card>
          );
        })}
      </div>
    </Stack>
  );
}
