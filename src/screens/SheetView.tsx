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
  useOutputUnlock,
  usePersistGenerationSource,
  usePublishGenerationOutputs,
  useRequestConsent,
  useRequestSignIn,
  useSaveImage,
  useShareLink,
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
  classifyEstimateRejection,
  classifyPricedFailure,
  classifySubmitRejection,
  estimateFailureCopy,
  formatCost,
  hasBudgetedScope,
  isSettledSnapshot,
} from '../money/generation.js';
import { startPollLoop } from '../money/pollLoop.js';
import { sharedSheetRoute } from '../platform/route.js';
import { buildSheetPanelBody } from '../sheet/body.js';
import { useDocumentStorage } from '../sheet/doc-storage.js';
import {
  buildSharedSheetDoc,
  saveSharedSheet,
  STORAGE_PUBLISH_SCOPE,
} from '../sheet/shared-sheet.js';
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
  panelPatchForFinal,
  pricedKindToErrorCode,
  repairablePanels,
  resumablePanels,
  type PanelErrorCode,
} from '../sheet/batch.js';
import {
  etaText,
  isUnlockableLock,
  outputPosition,
  panelEta,
  unlockAction,
  unlockLabel,
  type PanelEta,
} from '../sheet/panel-actions.js';
import type { PanelLock, SheetJob, SheetPanel } from '../sheet/types.js';
import { isTerminalPanelStatus } from '../sheet/types.js';
import type { SheetLibrary } from '../sheet/useSheetLibrary.js';
import { storeErrorMessage } from './common.js';

interface SheetViewProps {
  library: SheetLibrary;
  sheetId: string;
  onBack: () => void;
  /** Start a fresh sheet for this sheet's character. */
  onNewSheet: (characterId: string) => void;
  /** Re-run this sheet's setup for its character (seeded Builder). */
  onRegenerateSheet: (characterId: string, sheetId: string) => void;
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

const STILL_CHECKING = {
  title: 'Still being checked',
  body: 'This image is still being rated. Reopen the sheet in a few minutes to load it.',
};
/** Locked-tile copy for a done panel the host returned no image for. */
const LOCK_COPY: Record<PanelLock, { title: string; body: string }> = {
  'rating-pending': STILL_CHECKING,
  unrated: STILL_CHECKING,
  ceiling: {
    title: 'Restricted',
    body: 'This image is above your content settings, so it can’t be shown here.',
  },
  // The paying account's pool, not the viewer's settings: never suggest a
  // settings change that cannot help.
  pool: {
    title: 'Restricted',
    body: 'The Buzz that paid for this doesn’t cover mature content. You can unlock it with Yellow Buzz.',
  },
  restricted: {
    title: 'Restricted',
    body: 'This image can’t be shown here.',
  },
  blocked: {
    title: 'Unavailable',
    body: 'This image was blocked by moderation.',
  },
};

/** Error codes where a retry reuses the same idempotency key (same nonce). */
function retryReusesKey(panel: SheetPanel): boolean {
  if (!panel.workflowId) return true;
  return panel.errorCode === 'submit-failed' || panel.errorCode === 'submit-interrupted';
}

export function SheetView({ library, sheetId, onBack, onNewSheet, onRegenerateSheet }: SheetViewProps) {
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
  const { unlockOutput } = useOutputUnlock();
  const { persist } = usePersistGenerationSource();
  const { share: shareLink, lastResult: shareResult, error: shareError } = useShareLink();
  const docs = useDocumentStorage();

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
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);
  const [consentWait, setConsentWait] = useState(false);
  const [exporting, setExporting] = useState<string | null>(null);
  const [exportFlash, setExportFlash] = useState<string | null>(null);
  const [publishing, setPublishing] = useState<string | null>(null);
  // Unlock / use-as-reference in flight (panel id), and the last per-panel
  // outcome line for either.
  const [unlocking, setUnlocking] = useState<string | null>(null);
  const [referencing, setReferencing] = useState<string | null>(null);
  const [panelNotice, setPanelNotice] = useState<{ panelId: string; text: string } | null>(null);
  // Share sheet: in flight, and the last outcome line.
  const [sharing, setSharing] = useState(false);
  const [shareNotice, setShareNotice] = useState<string | null>(null);
  // Live queue / progress per generating panel, from each poll's `eta`. Not
  // persisted: it is only meaningful while the poll loop runs.
  const [etaByPanel, setEtaByPanel] = useState<Record<string, PanelEta>>({});
  const setPanelEta = useCallback((panelId: string, eta: PanelEta | null | undefined) => {
    setEtaByPanel((cur) => {
      if (eta === undefined) return cur;
      if (eta === null) {
        if (!(panelId in cur)) return cur;
        const { [panelId]: _gone, ...rest } = cur;
        return rest;
      }
      return { ...cur, [panelId]: eta };
    });
  }, []);
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
  // URL of the most recent successful post — the success notice carries a
  // "View post" link (new tab) the moment a post lands.
  const [lastPostUrl, setLastPostUrl] = useState<string | null>(null);
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

  // Every save of this sheet goes through ONE chain. The store writes the whole
  // document (last writer wins), and each mutator builds on the previous
  // in-memory result — so saves issued in order must also LAND in order, or an
  // older snapshot can overwrite a newer one (two repairs finishing together
  // dropped one of the recovered images).
  const saveChainRef = useRef<Promise<void>>(Promise.resolve());

  /** Apply a mutator to the current sheet, render it, and persist best-effort. */
  const updateSheet = useCallback(
    async (mut: (s: SheetJob) => SheetJob): Promise<void> => {
      const cur = sheetRef.current;
      if (!cur) return;
      const next: SheetJob = { ...mut(cur), updatedAt: new Date().toISOString() };
      next.status = deriveSheetStatus(next.panels);
      sheetRef.current = next;
      setSheet(next);
      const save = saveChainRef.current.then(async () => {
        const saveErr = await library.saveSheet(next);
        if (saveErr) setError(storeErrorMessage(saveErr));
      });
      saveChainRef.current = save.catch(() => undefined);
      await save;
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
        onSnapshot: (snap: BlockWorkflowSnapshot, final: boolean) => {
          const current = sheetRef.current?.panels.find((p) => p.id === panelId);
          if (
            !current ||
            current.workflowId !== workflowId ||
            isTerminalPanelStatus(current.status)
          ) {
            stopPanelLoop(panelId);
            return;
          }
          // `final`, not the status: a `succeeded` snapshot still being rated
          // (image withheld, `ratingPending`) keeps the panel running.
          const patch = final ? panelPatchForFinal(snap) : null;
          // An absent eta keeps the last line (the SDK's rule); a final
          // snapshot clears it.
          setPanelEta(panelId, final ? null : panelEta(snap) ?? undefined);
          if (patch) {
            stopPanelLoop(panelId);
            void setPanel(panelId, (p) => ({
              ...p,
              status: 'done',
              outputs: patch.outputs,
              locked: patch.locked,
              errorCode: undefined,
            }));
          } else if (final) {
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
    [failPanel, setPanel, setPanelEta, stopPanelLoop],
  );
  const startPanelLoopRef = useRef(startPanelLoop);
  startPanelLoopRef.current = startPanelLoop;

  // Repair results waiting to be written. Repairs that finish together are
  // applied in ONE updater (one save); the save chain orders the rest.
  const repairPatchesRef = useRef(
    new Map<string, { workflowId: string; outputs: string[]; locked: PanelLock | undefined }>(),
  );
  const repairFlushRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const repairOpenRef = useRef<{ sheetId: string; ids: Set<string> } | null>(null);

  const flushRepairPatches = useCallback(() => {
    repairFlushRef.current = null;
    const patches = repairPatchesRef.current;
    if (patches.size === 0) return;
    repairPatchesRef.current = new Map();
    void updateSheetRef.current((s) => ({
      ...s,
      panels: s.panels.map((p) => {
        const patch = patches.get(p.id);
        // Never overwrite a panel that has outputs or moved on meanwhile.
        if (!patch || p.status !== 'done' || p.workflowId !== patch.workflowId || p.outputs.length > 0) {
          return p;
        }
        return { ...p, outputs: patch.outputs, locked: patch.locked };
      }),
    }));
  }, []);

  /**
   * Repair a DONE panel saved without an image (see `repairablePanels`): poll
   * its workflow with the same bounded loop and save what the host now returns.
   * The attempt itself is recorded on open, before polling (see the resume
   * effect), so an error, an unreachable host or a closed tab still counts.
   * Only a settled snapshot writes urls; a failure / unreachable host / a panel
   * that changed meanwhile leaves the panel exactly as it was.
   */
  const startRepairLoop = useCallback(
    (panelId: string, workflowId: string) => {
      stopPanelLoop(panelId);
      const cancelLoop = startPollLoop(pollRef.current, workflowId, {
        onSnapshot: (snap: BlockWorkflowSnapshot, final: boolean) => {
          const current = sheetRef.current?.panels.find((p) => p.id === panelId);
          if (
            !current ||
            current.workflowId !== workflowId ||
            current.status !== 'done' ||
            current.outputs.length > 0
          ) {
            stopPanelLoop(panelId);
            return;
          }
          if (!final) return;
          stopPanelLoop(panelId);
          const patch = panelPatchForFinal(snap);
          if (!patch) return;
          if (patch.outputs.length === 0 && patch.locked === current.locked) return;
          repairPatchesRef.current.set(panelId, { workflowId, ...patch });
          if (repairFlushRef.current === null) {
            repairFlushRef.current = setTimeout(flushRepairPatches, 0);
          }
        },
        onUnreachable: () => {
          stopPanelLoop(panelId);
        },
      });
      pollLoopsRef.current.set(panelId, cancelLoop);
    },
    [flushRepairPatches, stopPanelLoop],
  );
  const startRepairLoopRef = useRef(startRepairLoop);
  startRepairLoopRef.current = startRepairLoop;

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
    // Repair done panels saved with no image — bounded per panel by its
    // `repair` record, which is written (one save for all of them) BEFORE
    // polling, so every attempt counts however it ends.
    // `repairOpenRef` remembers which panels THIS open already counted, so an
    // effect re-run within the same open (StrictMode's dev double-invoke)
    // restarts their loops without counting a second attempt.
    if (repairOpenRef.current?.sheetId !== sheetId) {
      repairOpenRef.current = { sheetId, ids: new Set() };
    }
    const counted = repairOpenRef.current.ids;
    const repairs = repairablePanels(cur.panels).filter((p) => !counted.has(p.id));
    for (const p of repairs) counted.add(p.id);
    if (repairs.length > 0) {
      const lastAt = new Date().toISOString();
      const ids = new Set(repairs.map((p) => p.id));
      void updateSheetRef.current((s) => ({
        ...s,
        panels: s.panels.map((p) =>
          ids.has(p.id)
            ? { ...p, repair: { attempts: (p.repair?.attempts ?? 0) + 1, lastAt } }
            : p,
        ),
      }));
    }
    for (const panel of cur.panels) {
      if (
        counted.has(panel.id) &&
        panel.status === 'done' &&
        !!panel.workflowId &&
        panel.outputs.length === 0
      ) {
        startRepairLoopRef.current(panel.id, panel.workflowId);
      }
    }
    return () => {
      stopAllPanelLoops();
      // A result that arrived but was not written yet is still written.
      if (repairFlushRef.current !== null) {
        clearTimeout(repairFlushRef.current);
        flushRepairPatches();
      }
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
        locked: undefined,
        repair: undefined,
        errorCode: undefined,
        // A new image replaces the published one: Share must publish it again.
        published: undefined,
        publishedImageId: undefined,
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
        await setPanel(panelId, (p) => ({
          ...p,
          status: 'failed',
          errorCode: 'estimate-failed',
        }));
        // App-owned copy from the classified server reason (never the raw text).
        const copy = estimateFailureCopy(classifyEstimateRejection(err), stack.name);
        setError(`${copy.title}. ${copy.body}`);
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
    let firstRejection: unknown = undefined;
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
          locked: undefined,
          repair: undefined,
          errorCode: undefined,
          published: undefined,
          publishedImageId: undefined,
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
        } catch (err) {
          if (firstRejection === undefined) firstRejection = err ?? null;
          await failPanel(panel.id, 'estimate-failed');
        }
      }
    } finally {
      setBatchBusy(false);
    }
    if (items.length === 0) {
      if (firstRejection !== undefined) {
        const copy = estimateFailureCopy(classifyEstimateRejection(firstRejection), stack.name);
        setError(`Couldn’t price the queued panels. ${copy.title}: ${copy.body}`);
      } else {
        setError('Couldn’t price the queued panels — each one shows its own error on its card.');
      }
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
          // Settled, not merely terminal: an instant `succeeded` still being
          // rated falls through to the poll loop below.
          if (isSettledSnapshot(snap)) {
            const patch = panelPatchForFinal(snap);
            if (patch) {
              await setPanel(panelId, () => ({
                ...next,
                status: 'done',
                outputs: patch.outputs,
                locked: patch.locked,
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
        const ids = await publish({ workflowId: panel.workflowId, imageIndexes: [0], title: panel.label });
        // Persistent marker (survives reload) so Publish never looks unclicked.
        // The image ID lets Share sheet reuse this publish.
        const imageId = ids[0];
        await setPanel(panel.id, (p) => ({
          ...p,
          published: true,
          ...(typeof imageId === 'number' ? { publishedImageId: imageId } : {}),
        }));
      } catch {
        setError('Publish failed — the host refused (or you dismissed the confirm).');
      } finally {
        setPublishing(null);
      }
    },
    [publish],
  );

  // --- unlock / use as reference --------------------------------------------------
  // Both name an output by its POSITION in the workflow's `outputs`, so each
  // reads the workflow first rather than trusting a stored index.

  const unlockPanel = useCallback(
    async (panel: SheetPanel) => {
      if (!panel.workflowId) return;
      const workflowId = panel.workflowId;
      setUnlocking(panel.id);
      setPanelNotice(null);
      const applySnapshot = async (snap: BlockWorkflowSnapshot) => {
        const patch = panelPatchForFinal(snap);
        if (!patch) return false;
        await setPanel(panel.id, (p) =>
          p.workflowId === workflowId ? { ...p, outputs: patch.outputs, locked: patch.locked } : p,
        );
        return patch.outputs.length > 0;
      };
      try {
        const snap = await pollRef.current(workflowId);
        const position = outputPosition(snap, 'restricted');
        if (position === null) {
          // Nothing is restricted any more: show what the host returns now.
          await applySnapshot(snap);
          return;
        }
        const action = unlockAction(await unlockOutput(workflowId, position));
        if (action.kind === 'apply') {
          await applySnapshot(action.snapshot);
        } else if (action.kind === 'repoll') {
          await applySnapshot(await pollRef.current(workflowId));
        } else if (action.kind === 'notice') {
          setPanelNotice({ panelId: panel.id, text: action.text });
        }
      } catch {
        setPanelNotice({ panelId: panel.id, text: 'Couldn’t reach Civitai to unlock it. Try again.' });
      } finally {
        setUnlocking(null);
      }
    },
    [setPanel, unlockOutput],
  );

  const setPanelAsReference = useCallback(
    async (panel: SheetPanel) => {
      const cur = sheetRef.current;
      const character = cur ? library.characters.find((c) => c.id === cur.characterId) : undefined;
      if (!panel.workflowId || !character) return;
      setReferencing(panel.id);
      setPanelNotice(null);
      try {
        const snap = await pollRef.current(panel.workflowId);
        const imageIndex = outputPosition(snap, 'available');
        if (imageIndex === null) {
          setPanelNotice({ panelId: panel.id, text: 'This panel has no image to use yet.' });
          return;
        }
        const src = await persist({ workflowId: panel.workflowId, imageIndex });
        const saveErr = await library.saveCharacter({
          ...character,
          referenceImage: { url: src.url, width: src.width, height: src.height },
          updatedAt: new Date().toISOString(),
        });
        if (saveErr) {
          setError(storeErrorMessage(saveErr));
          return;
        }
        setPanelNotice({
          panelId: panel.id,
          text: src.ready
            ? `Now ${character.name}’s reference portrait.`
            : `Now ${character.name}’s reference portrait. It is still being checked, so a sheet that uses it may need a minute before it can run.`,
        });
      } catch {
        setPanelNotice({ panelId: panel.id, text: 'Couldn’t save this panel as the reference. Try again.' });
      } finally {
        setReferencing(null);
      }
    },
    [library, persist],
  );

  // --- share sheet -------------------------------------------------------------------
  // Publishes each finished panel not published yet (the host's confirm, one
  // per panel), then writes the sheet's shared record of image IDs. The link is
  // copied by a SEPARATE click (Copy link): the copy needs a fresh click, and
  // the publish confirms in between would expire this one.

  const publishGranted = (token?.scopes ?? []).includes(STORAGE_PUBLISH_SCOPE);

  const shareSheet = useCallback(async () => {
    const cur = sheetRef.current;
    if (!cur || !docs) return;
    setShareNotice(null);
    if (anon) {
      requestSignIn();
      setShareNotice('Sign in to share a sheet.');
      return;
    }
    if (!publishGranted) {
      requestConsent({ scopes: [STORAGE_PUBLISH_SCOPE] });
      setShareNotice('Approve sharing in the Civitai dialog, then press Share sheet again.');
      return;
    }
    const owner = library.characters.find((c) => c.id === cur.characterId);
    setSharing(true);
    try {
      const entries: { label: string; imageId: number }[] = [];
      for (const p of cur.panels) {
        if (p.status !== 'done' || !p.workflowId || p.outputs.length === 0) continue;
        let imageId = p.publishedImageId;
        if (imageId === undefined) {
          const snap = await pollRef.current(p.workflowId);
          const position = outputPosition(snap, 'available');
          if (position === null) continue;
          const ids = await publish({ workflowId: p.workflowId, imageIndexes: [position], title: p.label });
          const first = ids[0];
          if (typeof first !== 'number') continue;
          imageId = first;
          await setPanel(p.id, (x) => ({ ...x, published: true, publishedImageId: first }));
        }
        entries.push({ label: p.label, imageId });
      }
      if (entries.length === 0) {
        setShareNotice('Nothing to share yet. Finish at least one panel first.');
        return;
      }
      const doc = buildSharedSheetDoc({
        characterName: owner?.name ?? 'Character',
        sheetName: cur.name,
        panels: entries,
      });
      const key = await saveSharedSheet(docs, doc, cur.shareKey);
      if (key !== cur.shareKey) await updateSheet((s) => ({ ...s, shareKey: key }));
      setShareNotice(
        `Shared ${entries.length} panel${entries.length === 1 ? '' : 's'}. Press Copy link to send it.`,
      );
    } catch {
      setShareNotice(
        'Couldn’t share the sheet. If you closed a publish confirm, press Share sheet again; panels already published are kept.',
      );
    } finally {
      setSharing(false);
    }
  }, [anon, docs, library.characters, publish, publishGranted, requestConsent, requestSignIn, setPanel, updateSheet]);

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
      setLastPostUrl(null);
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
        setLastPostUrl(result.url);
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

  // --- rename / delete -------------------------------------------------------------

  const commitRename = useCallback(async () => {
    const name = nameDraft.trim();
    setRenaming(false);
    if (!name) return;
    await updateSheet((s) => ({ ...s, name }));
  }, [nameDraft, updateSheet]);

  const deleteSheet = useCallback(async () => {
    const err = await library.deleteSheet(sheetId);
    if (err) {
      setError(storeErrorMessage(err));
      setConfirmDelete(false);
      return;
    }
    onBack();
  }, [library, onBack, sheetId]);

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
  // The batch-level insufficient-balance group (ONE banner, not one alert
  // per panel).
  const unaffordablePanels = sheet.panels.filter(
    (p) => p.status === 'failed' && p.errorCode === 'unaffordable',
  );
  const sharedFailureIds =
    unaffordablePanels.length >= 2
      ? new Set(unaffordablePanels.map((p) => p.id))
      : new Set<string>();

  return (
    <Stack gap="md">
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
            <Group gap="sm" align="center" justify="space-between" wrap={false}>
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
              <div className="css-overlay-wrap" ref={menuRef}>
                <button
                  type="button"
                  className="css-icon-btn"
                  data-testid="se-sheet-menu"
                  aria-label={`Actions for ${sheet.name}`}
                  aria-haspopup="menu"
                  aria-expanded={menuOpen}
                  onClick={() => setMenuOpen((v) => !v)}
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                    <circle cx="12" cy="5" r="1.8" />
                    <circle cx="12" cy="12" r="1.8" />
                    <circle cx="12" cy="19" r="1.8" />
                  </svg>
                </button>
                {menuOpen && (
                  <div className="css-menu" role="menu">
                    <button
                      type="button"
                      className="css-menu-item"
                      role="menuitem"
                      style={{ color: 'var(--civitai-color-error, #f87171)' }}
                      data-testid="se-sheet-delete"
                      onClick={() => {
                        setMenuOpen(false);
                        setConfirmDelete(true);
                      }}
                    >
                      Delete sheet
                    </button>
                  </div>
                )}
              </div>
            </Group>
          )}
          <div style={{ fontSize: 14, opacity: 0.8 }}>
            {character?.name ?? 'Unknown character'} · {stack?.name ?? 'Unknown stack'} ·{' '}
            {doneCount}/{sheet.panels.length} panels done
          </div>
          <Group gap="sm" align="center">
            <Button
              data-testid="se-new-sheet"
              onClick={() => onNewSheet(sheet.characterId)}
            >
              New sheet
            </Button>
            <Button
              variant="light"
              data-testid="se-regenerate-sheet"
              onClick={() => onRegenerateSheet(sheet.characterId, sheet.id)}
            >
              Regenerate sheet
            </Button>
            <Button
              variant="light"
              loading={sharing}
              disabled={sharing || doneCount === 0}
              data-testid="se-share-sheet"
              onClick={() => void shareSheet()}
            >
              {sheet.shareKey ? 'Update shared sheet' : 'Share sheet'}
            </Button>
            {sheet.shareKey && (
              <Button
                variant="subtle"
                data-testid="se-copy-link"
                // Straight from the click, nothing awaited first: the host's
                // clipboard write needs this click.
                onClick={() => {
                  shareLink({ subPath: sharedSheetRoute(sheet.shareKey!) }).catch(() => undefined);
                }}
              >
                Copy link
              </Button>
            )}
          </Group>
          {shareNotice && (
            <span style={{ fontSize: 13 }} data-testid="se-share-notice">
              {shareNotice}
            </span>
          )}
          {shareResult?.copied && (
            <span style={{ fontSize: 13 }} data-testid="se-link-copied">
              Link copied.
            </span>
          )}
          {shareResult && !shareResult.copied && shareResult.method === 'none' && (
            <TextInput
              readOnly
              aria-label="Share link"
              data-testid="se-share-url"
              value={shareResult.url}
              onFocus={(e) => e.currentTarget.select()}
            />
          )}
          {shareError && (
            <span role="alert" style={{ fontSize: 13 }}>
              Couldn’t copy the link: {shareError.message}
            </span>
          )}
          {sheet.postUrl && (
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
          )}
        </Stack>
      </Card>

      {confirmDelete && (
        <Alert color="error" data-testid="se-delete-confirm">
          <Group justify="space-between" align="center" wrap>
            <span style={{ fontSize: 13 }}>
              This deletes the sheet and its panel records — generated images
              stay in your Civitai creations.
            </span>
            <Group gap="sm">
              <Button
                size="sm"
                color="error"
                data-testid="se-sheet-delete-confirm"
                onClick={() => void deleteSheet()}
              >
                Confirm delete
              </Button>
              <Button
                size="sm"
                variant="subtle"
                onClick={() => setConfirmDelete(false)}
              >
                Cancel
              </Button>
            </Group>
          </Group>
        </Alert>
      )}

      {error && <Alert color="error">{error}</Alert>}
      {postNotice && (
        <Alert color="info" data-testid="se-post-notice">
          {postNotice}
          {lastPostUrl && (
            <>
              {' '}
              <a
                href={lastPostUrl}
                target="_blank"
                rel="noreferrer"
                data-testid="se-post-view-link"
              >
                View post ↗
              </a>
            </>
          )}
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
                    <Stack gap={6} align="center" style={{ width: '80%' }}>
                      <span style={{ fontSize: 13, color: 'var(--civitai-color-text-dimmed)' }}>
                        Generating…{elapsed ? ` ${elapsed}` : ''}
                        {panel.cost != null ? ` · ≈${formatCost(panel.cost)} Buzz` : ''}
                      </span>
                      {etaByPanel[panel.id] && (
                        <>
                          <span
                            data-testid="se-panel-eta"
                            style={{ fontSize: 12, color: 'var(--civitai-color-text-dimmed)' }}
                          >
                            {etaText(etaByPanel[panel.id]!)}
                          </span>
                          {etaByPanel[panel.id]!.progress !== null && (
                            <div
                              role="progressbar"
                              aria-label={`${panel.label} progress`}
                              aria-valuemin={0}
                              aria-valuemax={100}
                              aria-valuenow={Math.round(etaByPanel[panel.id]!.progress! * 100)}
                              style={{
                                width: '100%',
                                height: 4,
                                borderRadius: 2,
                                background: 'var(--civitai-color-surface-3, rgba(127,127,127,0.25))',
                              }}
                            >
                              <div
                                style={{
                                  width: `${Math.round(etaByPanel[panel.id]!.progress! * 100)}%`,
                                  height: '100%',
                                  borderRadius: 2,
                                  background: 'var(--civitai-color-primary, #228be6)',
                                }}
                              />
                            </div>
                          )}
                        </>
                      )}
                    </Stack>
                  </div>
                ) : panel.status === 'done' && panel.locked ? (
                  <div
                    data-testid="se-panel-locked"
                    data-lock={panel.locked}
                    role="note"
                    aria-label={`${panel.label}: ${LOCK_COPY[panel.locked].title}`}
                    style={{
                      aspectRatio: '1 / 1',
                      borderRadius: 6,
                      background: 'var(--civitai-color-surface-2)',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 6,
                      alignItems: 'center',
                      justifyContent: 'center',
                      textAlign: 'center',
                      padding: 12,
                      color: 'var(--civitai-color-text-dimmed)',
                      fontSize: 13,
                    }}
                  >
                    <strong>{LOCK_COPY[panel.locked].title}</strong>
                    <span>{LOCK_COPY[panel.locked].body}</span>
                    {isUnlockableLock(panel.locked) && panel.workflowId && (
                      <Button
                        size="sm"
                        variant="light"
                        loading={unlocking === panel.id}
                        disabled={unlocking !== null}
                        onClick={() => void unlockPanel(panel)}
                        data-testid="se-panel-unlock"
                      >
                        {unlockLabel(panel.locked)}
                      </Button>
                    )}
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

                {panelNotice?.panelId === panel.id && (
                  <Alert color="info" data-testid="se-panel-notice">
                    <span style={{ fontSize: 13 }}>{panelNotice.text}</span>
                  </Alert>
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
                        variant="light"
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
                          {panel.outputs.length > 0 && character && (
                            <Group gap="xs" align="center" wrap>
                              <Button
                                size="sm"
                                variant="subtle"
                                loading={referencing === panel.id}
                                disabled={!panel.workflowId || referencing !== null}
                                onClick={() => void setPanelAsReference(panel)}
                                data-testid="se-panel-use-reference"
                              >
                                Use as reference
                              </Button>
                              <span style={{ fontSize: 12, opacity: 0.65 }}>
                                Make this panel {character.name}’s reference portrait. It stays private.
                              </span>
                            </Group>
                          )}
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
