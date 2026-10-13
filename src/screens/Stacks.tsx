// Stacks pages: reusable checkpoint + LoRA combinations, with separate
// create/edit pages.
//
// A stack is picked through the HOST's native pickers (the block never browses
// a catalog). Every pick is DISCOVERY ONLY — the server re-validates (public?
// covered? SFW? LoRA-only? base-model compatible? entitled?) and re-prices at
// estimate AND submit, so nothing about a client choice is trusted.
//
// LoRA metadata (display name, trained words, recommended strength) is captured
// at pick time from the host-resolved `BlockResourceInfo`. Saved stacks also
// rehydrate through `useGenerationResources().fetch(...)` when an entry is
// missing its name — the no-repicker refresh route.

import { useEffect, useRef, useState } from 'react';

import {
  useGenerationResources,
  useResourcePicker,
} from '@civitai/blocks-react';
import {
  Alert,
  Badge,
  Button,
  Card,
  Group,
  Slider,
  Stack,
  TextInput,
  Textarea,
} from '@civitai/blocks-react/ui';
import type { BlockResourceInfo } from '@civitai/app-sdk/blocks';

import type { ModelStack, StackCheckpoint, StackLora } from '../sheet/types.js';
import {
  MAX_LORAS_PER_STACK,
  clampLoraStrength,
  newModelStack,
} from '../sheet/types.js';
import {
  DEFAULT_CHECKPOINT,
  checkpointDisplayLabel,
  pickedCheckpointLabel,
  type PickedResource,
} from '../models.js';
import type { SheetLibrary } from '../sheet/useSheetLibrary.js';
import { storeErrorMessage } from './common.js';

type EditorState = { mode: 'create' } | { mode: 'edit'; id: string } | null;

export interface StacksProps {
  library: SheetLibrary;
  /** Editor selected by the current page route, when the shell is routing. */
  initialEditor?: EditorState;
  /** The viewer asked to open the create/edit page. */
  onEditorOpened?: (editor: Exclude<EditorState, null>) => void;
  /** The editor page was closed without creating a stack. */
  onEditorClosed?: () => void;
  /** A new stack was saved (create mode) — the return trip home. */
  onCreated?: (stackId: string) => void;
  /** An existing stack was saved from its edit page. */
  onEdited?: () => void;
  /** The create editor was closed without saving. */
  onCreateCancelled?: () => void;
}

function defaultCheckpoint(): StackCheckpoint {
  return {
    modelId: DEFAULT_CHECKPOINT.modelId,
    modelVersionId: DEFAULT_CHECKPOINT.versionId,
    baseModel: DEFAULT_CHECKPOINT.baseModel,
    name: DEFAULT_CHECKPOINT.label,
  };
}

function checkpointFromPick(picked: PickedResource): StackCheckpoint {
  return {
    modelId: picked.modelId,
    modelVersionId: picked.versionId,
    baseModel: picked.baseModel,
    name: pickedCheckpointLabel(picked.versionId, picked.baseModel, picked),
  };
}

function loraLabel(info: BlockResourceInfo): string {
  const model = info.modelName?.trim();
  const version = info.versionName?.trim();
  if (model && version) return `${model} — ${version}`;
  return model || version || `LoRA #${info.versionId}`;
}

function loraFromPick(info: BlockResourceInfo): StackLora {
  return {
    modelVersionId: info.versionId,
    strength: clampLoraStrength(info.strength ?? 1),
    triggerWords: Array.isArray(info.trainedWords) ? info.trainedWords : [],
    name: loraLabel(info),
    baseModel: info.baseModel,
  };
}

export function Stacks({
  library,
  initialEditor,
  onEditorOpened,
  onEditorClosed,
  onCreated,
  onEdited,
  onCreateCancelled,
}: StacksProps) {
  const [editor, setEditor] = useState<EditorState>(initialEditor ?? null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const openEditor = (next: Exclude<EditorState, null>) => {
    setEditor(next);
    onEditorOpened?.(next);
  };

  // Sheet count per stack — what a delete would orphan.
  const sheetsByStack = new Map<string, number>();
  for (const s of library.sheets) {
    sheetsByStack.set(s.stackId, (sheetsByStack.get(s.stackId) ?? 0) + 1);
  }

  const onDelete = async (id: string) => {
    if (confirmDeleteId !== id) {
      setConfirmDeleteId(id);
      return;
    }
    setConfirmDeleteId(null);
    setDeleteError(null);
    // Existing sheets keep their stack id and images even if the stack is
    // deleted; they render with the stack labeled unknown.
    const err = await library.deleteStack(id);
    if (err) setDeleteError(storeErrorMessage(err));
  };

  // Create/edit are their own pages, so the stack list is not rendered
  // underneath an open editor.
  if (editor) {
    const editing =
      editor.mode === 'edit'
        ? library.stacks.find((s) => s.id === editor.id)
        : undefined;
    if (editor.mode === 'edit' && library.ready && !editing) {
      return (
        <Card>
          <Stack gap="sm">
            <p style={{ margin: 0, opacity: 0.75 }}>
              That stack no longer exists.
            </p>
            <div>
              <Button
                size="sm"
                onClick={() => {
                  setEditor(null);
                  onEditorClosed?.();
                }}
              >
                Back to stacks
              </Button>
            </div>
          </Stack>
        </Card>
      );
    }

    return (
      <Stack gap="md">
        {deleteError && <Alert color="error">{deleteError}</Alert>}
        <StackEditor
          key={editor.mode === 'edit' ? editor.id : 'create'}
          initial={editing}
          onClose={() => {
            if (editor.mode === 'create') onCreateCancelled?.();
            setEditor(null);
            onEditorClosed?.();
          }}
          onSaved={(saved) => {
            const wasCreate = editor.mode === 'create';
            setEditor(null);
            if (wasCreate) onCreated?.(saved.id);
            else onEdited?.();
          }}
          saveStack={library.saveStack}
        />
      </Stack>
    );
  }

  return (
    <Stack gap="md">
      <Group justify="flex-end" align="center">
        <Button size="sm" onClick={() => openEditor({ mode: 'create' })}>
          New stack
        </Button>
      </Group>

      {deleteError && <Alert color="error">{deleteError}</Alert>}

      {library.stacks.length === 0 && (
        <Card>
          <p style={{ margin: 0, opacity: 0.75 }}>
            No stacks yet. A stack is a checkpoint plus up to five LoRAs with
            weights — the reusable "engine" your character sheets generate with.
          </p>
        </Card>
      )}

      <div className="css-grid-cards">
        {library.stacks.map((s) => (
          <Card key={s.id}>
            <Group justify="space-between" align="flex-start" wrap>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 600 }}>{s.name}</div>
                <div style={{ fontSize: 13, opacity: 0.75 }}>
                  {checkpointDisplayLabel(s.checkpoint)}
                </div>
                <Group gap="xs" wrap style={{ marginTop: 6 }}>
                  <Badge size="sm" variant="light">
                    {s.loras.length} LoRA{s.loras.length === 1 ? '' : 's'}
                  </Badge>
                  {s.loras.slice(0, 3).map((l) => (
                    <Badge key={l.modelVersionId} size="sm" variant="outline">
                      {l.name ?? `#${l.modelVersionId}`} · {l.strength}
                    </Badge>
                  ))}
                </Group>
              </div>
              <Group gap="xs" wrap>
                <Button size="sm" variant="subtle" onClick={() => openEditor({ mode: 'edit', id: s.id })}>
                  Edit
                </Button>
                <Button
                  size="sm"
                  variant="subtle"
                  color="red"
                  onClick={() => void onDelete(s.id)}
                >
                  {confirmDeleteId === s.id ? 'Confirm delete?' : 'Delete'}
                </Button>
              </Group>
            </Group>
            {confirmDeleteId === s.id && (sheetsByStack.get(s.id) ?? 0) > 0 && (
              <p style={{ margin: '8px 0 0', fontSize: 13, opacity: 0.75 }}>
                Deleting this stack won’t delete its {sheetsByStack.get(s.id)}{' '}
                sheet{(sheetsByStack.get(s.id) ?? 0) === 1 ? '' : 's'} — they keep
                their images, labeled “Unknown stack”.
              </p>
            )}
          </Card>
        ))}
      </div>
    </Stack>
  );
}

// ---------------------------------------------------------------------------

export interface StackEditorProps {
  initial?: ModelStack;
  /** Create-mode starting values (a preset picked above the editor). */
  preset?: { name: string; notes: string };
  onClose: () => void;
  onSaved: (saved: ModelStack) => void;
  saveStack: SheetLibrary['saveStack'];
}

export function StackEditor({ initial, preset, onClose, onSaved, saveStack }: StackEditorProps) {
  const [name, setName] = useState(initial?.name ?? preset?.name ?? '');
  const [notes, setNotes] = useState(initial?.notes ?? preset?.notes ?? '');
  const [checkpoint, setCheckpoint] = useState<StackCheckpoint>(
    initial?.checkpoint ?? defaultCheckpoint(),
  );
  const [loras, setLoras] = useState<StackLora[]>(initial?.loras ?? []);
  const [pickerBusy, setPickerBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);
  // Transient feedback for a picker round-trip that changed nothing (e.g. a
  // duplicate LoRA pick) — a silent no-op here reads as a broken button.
  const [loraNotice, setLoraNotice] = useState<string | null>(null);

  const { open: openResourcePicker } = useResourcePicker();
  const { fetch: fetchResources } = useGenerationResources();
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Best-effort rehydration: if a saved entry is missing its display name
  // (older save, partial write), refresh it without reopening the pickers.
  // Strengths are NEVER touched — those are the user's.
  useEffect(() => {
    const missing = loras
      .filter((l) => !l.name || !l.baseModel)
      .map((l) => l.modelVersionId);
    const needCheckpoint = !checkpoint.name;
    if (missing.length === 0 && !needCheckpoint) return;
    let cancelled = false;
    void (async () => {
      try {
        const infos = await fetchResources([
          ...missing,
          ...(needCheckpoint ? [checkpoint.modelVersionId] : []),
        ]);
        if (cancelled || !mountedRef.current) return;
        const byId = new Map(infos.map((i) => [i.versionId, i]));
        if (missing.length > 0) {
          setLoras((cur) =>
            cur.map((l) => {
              const info = byId.get(l.modelVersionId);
              if (!info) return l;
              return {
                ...l,
                ...(l.name ? {} : { name: loraLabel(info) }),
                ...(l.baseModel ? {} : { baseModel: info.baseModel }),
              };
            }),
          );
        }
        if (needCheckpoint) {
          const info = byId.get(checkpoint.modelVersionId);
          if (info) {
            setCheckpoint((cur) =>
              cur.name
                ? cur
                : { ...cur, name: pickedCheckpointLabel(info.versionId, info.baseModel, info) },
            );
          }
        }
      } catch {
        // Rehydration is cosmetic — a failed refresh keeps the saved ids.
      }
    })();
    return () => {
      cancelled = true;
    };
    // Run once per editor mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // LoRAs whose family doesn't match the checkpoint (possible after a
  // checkpoint swap — the picker only constrains NEW picks). The server may
  // silently ignore these, so warn before the user pays to find out.
  const mismatchedLoras = loras.filter(
    (l) => l.baseModel && l.baseModel !== checkpoint.baseModel,
  );

  const nameError = touched && name.trim() === '' ? 'Give the stack a name.' : undefined;

  const onChangeCheckpoint = async () => {
    setPickerBusy(true);
    try {
      // Unconstrained pick — no baseModelGroup, so the picker shows ALL
      // checkpoints. (The checkpoint-only hook REQUIRES an ecosystem hint;
      // the generic resource hook blesses omitting it.)
      const selected = await openResourcePicker({ resourceType: 'Checkpoint' });
      if (selected) setCheckpoint(checkpointFromPick(selected));
    } finally {
      setPickerBusy(false);
    }
  };

  const onAddLora = async () => {
    if (loras.length >= MAX_LORAS_PER_STACK) return;
    setPickerBusy(true);
    try {
      const picked: BlockResourceInfo | null = await openResourcePicker({
        resourceType: 'LORA',
        baseModelGroup: checkpoint.baseModel,
      });
      if (!picked) return;
      // Same version already stacked: say so instead of silently deduping.
      if (loras.some((l) => l.modelVersionId === picked.versionId)) {
        setLoraNotice(`“${loraLabel(picked)}” is already in this stack.`);
        return;
      }
      setLoraNotice(null);
      setLoras((cur) =>
        cur.length >= MAX_LORAS_PER_STACK ? cur : [...cur, loraFromPick(picked)],
      );
    } finally {
      setPickerBusy(false);
    }
  };

  const onSave = async () => {
    setTouched(true);
    if (name.trim() === '') return;
    setSaving(true);
    setError(null);
    const now = new Date().toISOString();
    const stack: ModelStack = initial
      ? {
          ...initial,
          name: name.trim(),
          notes: notes.trim(),
          checkpoint,
          loras,
          updatedAt: now,
        }
      : newModelStack({
          name: name.trim(),
          notes: notes.trim(),
          checkpoint,
          loras,
        });
    const err = await saveStack(stack);
    setSaving(false);
    if (err) {
      setError(storeErrorMessage(err));
      return;
    }
    onSaved(stack);
  };

  return (
    <Card>
      <Stack gap="sm">
        <Group justify="space-between" align="center">
          <h3 style={{ margin: 0 }}>{initial ? 'Edit stack' : 'New stack'}</h3>
          <Button size="sm" variant="subtle" onClick={onClose}>
            Cancel
          </Button>
        </Group>

        {error && <Alert color="error">{error}</Alert>}

        <TextInput
          label="Name"
          placeholder="Pony + detail LoRAs"
          value={name}
          onChange={(e) => setName(e.currentTarget.value)}
          error={nameError}
          data-testid="stack-name"
        />
        <Textarea
          label="Notes"
          placeholder="What this stack is good for…"
          value={notes}
          onChange={(e) => setNotes(e.currentTarget.value)}
          rows={2}
        />

        <div>
          <div style={{ fontSize: 14, fontWeight: 500, marginBottom: 6 }}>Checkpoint</div>
          <Group gap="sm" align="center">
            <span style={{ fontSize: 14 }}>{checkpointDisplayLabel(checkpoint)}</span>
            <Button size="sm" variant="light" loading={pickerBusy} onClick={() => void onChangeCheckpoint()} data-testid="stack-checkpoint-change">
              Change
            </Button>
          </Group>
        </div>

        <div>
          <Group justify="space-between" align="center" style={{ marginBottom: 6 }}>
            <div style={{ fontSize: 14, fontWeight: 500 }}>
              LoRAs ({loras.length}/{MAX_LORAS_PER_STACK})
            </div>
            <Button
              size="sm"
              variant="light"
              loading={pickerBusy}
              disabled={loras.length >= MAX_LORAS_PER_STACK}
              onClick={() => void onAddLora()}
            >
              Add LoRA
            </Button>
          </Group>
          {loraNotice && (
            <div
              role="status"
              data-testid="stack-lora-notice"
              style={{ fontSize: 13, marginBottom: 6, color: 'var(--civitai-color-text-dimmed)' }}
            >
              {loraNotice}
            </div>
          )}
          {mismatchedLoras.length > 0 && (
            <Alert color="warning" data-testid="stack-lora-mismatch">
              {mismatchedLoras.length} LoRA{mismatchedLoras.length === 1 ? '' : 's'}{' '}
              target{ mismatchedLoras.length === 1 ? 's' : ''}{' '}
              {[...new Set(mismatchedLoras.map((l) => l.baseModel))].join(', ')} but
              this checkpoint is {checkpoint.baseModel} — mismatched LoRAs are
              usually ignored at generation.
            </Alert>
          )}
          <Stack gap="xs">
            {loras.map((l) => (
              <Card key={l.modelVersionId} padding="sm">
                <Group justify="space-between" align="center">
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ fontSize: 14, fontWeight: 500 }}>{l.name ?? `LoRA #${l.modelVersionId}`}</div>
                    {(l.baseModel || l.triggerWords.length > 0) && (
                      <div style={{ fontSize: 12, opacity: 0.65 }}>
                        {[l.baseModel, l.triggerWords.join(', ')]
                          .filter(Boolean)
                          .join(' · ')}
                      </div>
                    )}
                    <Slider
                      label={`Weight: ${l.strength}`}
                      value={l.strength}
                      min={-1}
                      max={2}
                      step={0.05}
                      onChange={(v) =>
                        setLoras((cur) =>
                          cur.map((x) =>
                            x.modelVersionId === l.modelVersionId
                              ? { ...x, strength: clampLoraStrength(Math.round(v * 100) / 100) }
                              : x,
                          ),
                        )
                      }
                    />
                    <div style={{ fontSize: 12, opacity: 0.65, marginTop: 2 }}>
                      Typical is 0.6–1.0 — higher leans harder into the LoRA’s
                      style, lower just hints at it.
                    </div>
                  </div>
                  <Button
                    size="sm"
                    variant="subtle"
                    color="red"
                    onClick={() =>
                      setLoras((cur) => cur.filter((x) => x.modelVersionId !== l.modelVersionId))
                    }
                  >
                    Remove
                  </Button>
                </Group>
              </Card>
            ))}
            {loras.length === 0 && (
              <div style={{ fontSize: 13, opacity: 0.65 }}>
                No LoRAs — the checkpoint generates on its own.
              </div>
            )}
          </Stack>
        </div>

        <Group justify="flex-end">
          <Button onClick={() => void onSave()} loading={saving} data-testid="stack-save">
            Save stack
          </Button>
        </Group>
      </Stack>
    </Card>
  );
}
