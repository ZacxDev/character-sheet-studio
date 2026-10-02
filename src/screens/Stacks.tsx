// Stacks screen: reusable checkpoint + LoRA combinations.
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
  pickedCheckpointLabel,
  type PickedResource,
} from '../models.js';
import type { SheetLibrary } from '../sheet/useSheetLibrary.js';
import { storeErrorMessage } from './common.js';

export interface StacksProps {
  library: SheetLibrary;
}

type EditorState = { mode: 'create' } | { mode: 'edit'; id: string } | null;

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
  };
}

export function Stacks({ library }: StacksProps) {
  const [editor, setEditor] = useState<EditorState>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const onDelete = async (id: string) => {
    if (confirmDeleteId !== id) {
      setConfirmDeleteId(id);
      return;
    }
    setConfirmDeleteId(null);
    setDeleteError(null);
    // A stack in use as a character's default keeps working — the builder
    // resolves the stack id at sheet-creation time and warns if it's gone.
    const err = await library.deleteStack(id);
    if (err) setDeleteError(storeErrorMessage(err));
  };

  return (
    <Stack gap="md">
      <Group justify="space-between" align="center">
        <h2 style={{ margin: 0, fontSize: 20 }}>Stacks</h2>
        <Button size="sm" onClick={() => setEditor({ mode: 'create' })}>
          New stack
        </Button>
      </Group>

      {deleteError && <Alert color="error">{deleteError}</Alert>}

      {editor && (
        <StackEditor
          key={editor.mode === 'edit' ? editor.id : 'create'}
          initial={
            editor.mode === 'edit'
              ? library.stacks.find((s) => s.id === editor.id)
              : undefined
          }
          onClose={() => setEditor(null)}
          onSaved={() => setEditor(null)}
          saveStack={library.saveStack}
        />
      )}

      {library.stacks.length === 0 && !editor && (
        <Card>
          <p style={{ margin: 0, opacity: 0.75 }}>
            No stacks yet. A stack is a checkpoint plus up to five LoRAs with
            weights — the reusable "engine" your character sheets generate with.
          </p>
        </Card>
      )}

      <Stack gap="sm">
        {library.stacks.map((s) => (
          <Card key={s.id}>
            <Group justify="space-between" align="flex-start">
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 600 }}>{s.name}</div>
                <div style={{ fontSize: 13, opacity: 0.75 }}>
                  {s.checkpoint.name ?? `Model #${s.checkpoint.modelVersionId}`} ·{' '}
                  {s.checkpoint.baseModel}
                </div>
                <Group gap="xs" style={{ marginTop: 6 }}>
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
              <Group gap="xs">
                <Button size="sm" variant="subtle" onClick={() => setEditor({ mode: 'edit', id: s.id })}>
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
          </Card>
        ))}
      </Stack>
    </Stack>
  );
}

// ---------------------------------------------------------------------------

interface EditorProps {
  initial?: ModelStack;
  onClose: () => void;
  onSaved: () => void;
  saveStack: SheetLibrary['saveStack'];
}

function StackEditor({ initial, onClose, onSaved, saveStack }: EditorProps) {
  const [name, setName] = useState(initial?.name ?? '');
  const [notes, setNotes] = useState(initial?.notes ?? '');
  const [checkpoint, setCheckpoint] = useState<StackCheckpoint>(
    initial?.checkpoint ?? defaultCheckpoint(),
  );
  const [loras, setLoras] = useState<StackLora[]>(initial?.loras ?? []);
  const [pickerBusy, setPickerBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);

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
    const missing = loras.filter((l) => !l.name).map((l) => l.modelVersionId);
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
              return info && !l.name ? { ...l, name: loraLabel(info) } : l;
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
      setLoras((cur) => {
        if (cur.some((l) => l.modelVersionId === picked.versionId)) return cur;
        if (cur.length >= MAX_LORAS_PER_STACK) return cur;
        return [...cur, loraFromPick(picked)];
      });
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
    onSaved();
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
            <span style={{ fontSize: 14 }}>
              {checkpoint.name ?? `Model #${checkpoint.modelVersionId}`} ({checkpoint.baseModel})
            </span>
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
          <Stack gap="xs">
            {loras.map((l) => (
              <Card key={l.modelVersionId} padding="sm">
                <Group justify="space-between" align="center">
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ fontSize: 14, fontWeight: 500 }}>{l.name ?? `LoRA #${l.modelVersionId}`}</div>
                    {l.triggerWords.length > 0 && (
                      <div style={{ fontSize: 12, opacity: 0.65 }}>
                        {l.triggerWords.join(', ')}
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
