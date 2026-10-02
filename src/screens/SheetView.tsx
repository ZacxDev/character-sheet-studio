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
  useBuzzWorkflow,
  useConsentUnavailable,
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
  hasBudgetedScope,
  isTerminalStatus,
} from '../money/generation.js';
import { startPollLoop } from '../money/pollLoop.js';
import { buildSheetPanelBody } from '../sheet/body.js';
import {
  deriveSheetStatus,
  idempotencyKeyFor,
  panelErrorCopy,
  pricedKindToErrorCode,
  resumablePanels,
  type PanelErrorCode,
} from '../sheet/batch.js';
import type { SheetJob, SheetPanel } from '../sheet/types.js';
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
  const { requestSignIn } = useRequestSignIn();
  const { requestConsent } = useRequestConsent();
  const { refusal } = useConsentUnavailable();
  const { saveImage } = useSaveImage();
  const { publish } = usePublishGenerationOutputs();

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
  const [publishing, setPublishing] = useState<string | null>(null);

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
  // Attach once per sheet open. A terminal snapshot STOPS its loop; the
  // cleanup cancels whatever is still live on unmount.

  const pollRef = useRef(poll);
  pollRef.current = poll;

  useEffect(() => {
    const cur = sheetRef.current;
    if (!cur) return;
    const cancels: Array<() => void> = [];
    for (const panel of resumablePanels(cur.panels)) {
      const workflowId = panel.workflowId as string;
      const cancelLoop = startPollLoop(pollRef.current, workflowId, {
        onSnapshot: (snap: BlockWorkflowSnapshot) => {
          if (snap.status === 'succeeded') {
            void setPanel(panel.id, (p) => ({
              ...p,
              status: 'done',
              outputs: snap.imageUrls ?? [],
              errorCode: undefined,
            }));
          } else if (isTerminalStatus(snap.status)) {
            void failPanel(
              panel.id,
              pricedKindToErrorCode(classifyPricedFailure(snap.error)),
            );
          } else {
            void setPanel(panel.id, (p) => ({ ...p, status: 'running' }));
          }
        },
        onUnreachable: () => {
          // Transport is down, not the workflow — keep the workflowId so a
          // later visit resumes it.
          void failPanel(panel.id, 'poll-unreachable');
        },
      });
      cancels.push(cancelLoop);
    }
    return () => {
      for (const c of cancels) c();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sheetId]);

  // --- regenerate / retry ----------------------------------------------------

  const requestConsentFor = useCallback(
    (panelId: string, mode: 'retry' | 'regenerate') => {
      consentIntentRef.current = { panelId, mode };
      setConsentWait(true);
      requestConsent({ scopes: [BUDGETED_SCOPE] });
    },
    [requestConsent],
  );

  /** Submit one panel (retry or regenerate). estimate → submit → poll. */
  const runPanelSubmit = useCallback(
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
      try {
        // Estimate is free and keeps the price honest for the new attempt.
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
        } catch (err) {
          const code = (err as { code?: unknown } | null)?.code;
          await setPanel(panelId, (p) => ({
            ...p,
            status: 'failed',
            errorCode: 'estimate-failed',
          }));
          setError(`Couldn’t price this panel. ${estimateErrorCopy(code)}`);
          return;
        }

        try {
          const snap: BlockWorkflowSnapshot = await submit(body, {
            idempotencyKey: idempotencyKeyFor(cur.id, panel.id, next.submitNonce),
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
          await setPanel(panelId, () => ({ ...next, workflowId: snap.workflowId }));
          const cancelLoop = startPollLoop(pollRef.current, snap.workflowId, {
            onSnapshot: (s2: BlockWorkflowSnapshot) => {
              if (s2.status === 'succeeded') {
                void setPanel(panelId, (p) => ({
                  ...p,
                  status: 'done',
                  outputs: s2.imageUrls ?? [],
                  errorCode: undefined,
                }));
              } else if (isTerminalStatus(s2.status)) {
                void failPanel(
                  panelId,
                  pricedKindToErrorCode(classifyPricedFailure(s2.error)),
                );
              } else {
                void setPanel(panelId, (p) => ({ ...p, status: 'running' }));
              }
            },
            onUnreachable: () => {
              void failPanel(panelId, 'poll-unreachable');
            },
          });
          pollCancelsRef.current.push(cancelLoop);
        } catch (err) {
          const rej = classifySubmitRejection(err);
          if (rej.kind === 'workflow-failed' && rej.pollWorkflowId) {
            // Money may be committed; the poll loop learns the actual fate.
            await setPanel(panelId, () => ({
              ...next,
              workflowId: rej.pollWorkflowId as string,
            }));
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
    [estimate, failPanel, library, poll, setPanel, submit],
  );
  const runPanelSubmitRef = useRef(runPanelSubmit);
  runPanelSubmitRef.current = runPanelSubmit;
  const pollCancelsRef = useRef<Array<() => void>>([]);
  useEffect(() => {
    const cancels = pollCancelsRef.current;
    return () => {
      for (const c of cancels) c();
      cancels.length = 0;
    };
  }, []);

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
      void runPanelSubmitRef.current(panelId, mode);
    },
    [anon, granted, requestConsentFor, requestSignIn],
  );

  // Auto-resume the waiting intent after a consent grant.
  useEffect(() => {
    const intent = consentIntentRef.current;
    if (granted && intent) {
      consentIntentRef.current = null;
      setConsentWait(false);
      void runPanelSubmitRef.current(intent.panelId, intent.mode);
    }
  }, [granted]);

  // A consent refusal is final for this environment.
  useEffect(() => {
    if (refusal && consentWait) {
      consentIntentRef.current = null;
      setConsentWait(false);
      setError(
        'Spending approval isn’t available in this environment, so panels can’t be regenerated here.',
      );
    }
  }, [refusal, consentWait]);

  // --- cancel ------------------------------------------------------------------

  const cancelPanel = useCallback(
    async (panel: SheetPanel) => {
      if (!panel.workflowId) return;
      setBusyPanel(panel.id);
      try {
        await cancel(panel.workflowId);
      } catch {
        // Best-effort: the orchestrator may already be done. Either way the
        // panel leaves the live set.
      } finally {
        // Bump the nonce: a later retry must not idempotently replay the
        // canceled workflow.
        await setPanel(panel.id, (p) => ({
          ...p,
          status: 'queued',
          workflowId: undefined,
          errorCode: undefined,
          submitNonce: p.submitNonce + 1,
        }));
        setBusyPanel(null);
      }
    },
    [cancel, setPanel],
  );

  // --- export / publish ----------------------------------------------------------

  const exportPanel = useCallback(
    async (panel: SheetPanel) => {
      const url = panel.outputs[0];
      if (!url) return;
      setExporting(panel.id);
      try {
        await saveImage({ url, filename: `${panel.label.replace(/\s+/g, '-').toLowerCase()}.png` });
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
      } catch {
        setError('Publish failed — the host refused (or you dismissed the confirm).');
      } finally {
        setPublishing(null);
      }
    },
    [publish],
  );

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
            {doneCount}/{sheet.panels.length} panels done · seed {sheet.seed}
          </div>
          <div>
            <Badge color={sheet.status === 'complete' ? 'success' : sheet.status === 'failed' ? 'error' : 'info'}>
              {sheet.status}
            </Badge>
          </div>
        </Stack>
      </Card>

      {error && <Alert color="error">{error}</Alert>}
      {consentWait && (
        <Alert color="info">
          <Loader size="sm" /> Waiting for your approval in the Civitai dialog…
        </Alert>
      )}

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
          gap: 12,
        }}
      >
        {sheet.panels.map((panel) => {
          const busy = busyPanel === panel.id;
          const errCopy = panel.errorCode
            ? panelErrorCopy(panel.errorCode as PanelErrorCode)
            : null;
          return (
            <Card key={panel.id} padding="sm">
              <Stack gap="sm">
                <Group justify="space-between" align="center">
                  <strong style={{ fontSize: 14 }}>{panel.label}</strong>
                  <Badge color={STATUS_COLOR[panel.status]} variant="light">
                    {busy ? 'Working…' : STATUS_LABEL[panel.status]}
                  </Badge>
                </Group>

                {panel.outputs[0] ? (
                  <img
                    src={panel.outputs[0]}
                    alt={panel.label}
                    style={{ width: '100%', borderRadius: 6, display: 'block' }}
                  />
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
                    {panel.status === 'running' ? <Loader size="sm" /> : 'No image yet'}
                  </div>
                )}

                {errCopy && (
                  <Alert color="error" title={errCopy.title}>
                    <span style={{ fontSize: 13 }}>{errCopy.body}</span>
                  </Alert>
                )}

                <Group gap="xs" wrap>
                  {panel.status === 'done' && (
                    <>
                      <Button
                        size="sm"
                        variant="subtle"
                        loading={exporting === panel.id}
                        onClick={() => void exportPanel(panel)}
                      >
                        Export
                      </Button>
                      <Button
                        size="sm"
                        variant="subtle"
                        loading={publishing === panel.id}
                        disabled={!panel.workflowId}
                        onClick={() => void publishPanel(panel)}
                      >
                        Publish
                      </Button>
                      <Button
                        size="sm"
                        variant="subtle"
                        disabled={busy}
                        onClick={() => startPanelAction(panel.id, 'regenerate')}
                      >
                        New variation
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
                        Retry
                      </Button>
                      <Button
                        size="sm"
                        variant="subtle"
                        disabled={busy}
                        onClick={() => startPanelAction(panel.id, 'regenerate')}
                      >
                        New variation
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
                  {panel.status === 'queued' && !panel.workflowId && (
                    <Button
                      size="sm"
                      disabled={busy}
                      onClick={() => startPanelAction(panel.id, 'retry')}
                    >
                      Submit
                    </Button>
                  )}
                </Group>
              </Stack>
            </Card>
          );
        })}
      </div>
    </Stack>
  );
}
