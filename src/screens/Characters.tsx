// Characters screen: the cast list + the character editor.
//
// A character is the reusable identity a sheet is built from — description,
// traits, trigger words, negative prompt, an optional reference portrait
// (uploaded as a PRIVATE img2img source via the host), and a seed policy.
// Everything persists through the sheet library (app storage, best-effort).

import { useEffect, useRef, useState } from 'react';

import { useImageUpload } from '@civitai/blocks-react';
import {
  Alert,
  Button,
  Card,
  Group,
  Select,
  Stack,
  TextInput,
  Textarea,
} from '@civitai/blocks-react/ui';

import type {
  Character,
  CharacterRefImage,
  ModelStack,
  SeedPolicy,
} from '../sheet/types.js';
import { newCharacter } from '../sheet/types.js';
import type { SheetLibrary } from '../sheet/useSheetLibrary.js';
import { parseListInput, storeErrorMessage } from './common.js';

export interface CharactersProps {
  library: SheetLibrary;
  /** Jump to the Sheet Builder with this character preselected. */
  onBuildSheet: (characterId: string) => void;
  /** Jump to the Sheets tab filtered to this character's sheets. */
  onViewSheets: (characterId: string) => void;
  /** Open the create editor on arrival (the Builder sent the viewer here). */
  autoOpenCreate?: boolean;
  onAutoOpenConsumed?: () => void;
  /** A new character was saved (create mode) — the return trip home. */
  onCreated?: (characterId: string) => void;
  /** The create editor was closed without saving. */
  onCreateCancelled?: () => void;
}

type EditorState = { mode: 'create' } | { mode: 'edit'; id: string } | null;

function seedPolicyLabel(p: SeedPolicy): string {
  return p === 'locked' ? 'Locked (reproducible)' : 'Varied (random per panel)';
}

const SEED_POLICY_EXPLAINER: Record<SeedPolicy, string> = {
  locked:
    'Locked seed — every panel on a sheet reuses the same seed, so the character renders consistently and the sheet can be reproduced.',
  varied:
    'Varied seed — each panel rolls a fresh seed, so sheets explore more poses and looks.',
};

function LockIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <rect x="4" y="11" width="16" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </svg>
  );
}

function ShuffleIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M16 3h5v5" />
      <path d="M4 20 21 3" />
      <path d="M21 16v5h-5" />
      <path d="m15 15 6 6" />
      <path d="M4 4l5 5" />
    </svg>
  );
}

function DotsIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <circle cx="12" cy="5" r="1.8" />
      <circle cx="12" cy="12" r="1.8" />
      <circle cx="12" cy="19" r="1.8" />
    </svg>
  );
}

/** Closes on outside click / Escape while open. Shared by the card overlays. */
function useOverlayClose(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, close]);
  return ref;
}

/** Seed policy as an icon badge; the explanation lives in a popover. */
function SeedPolicyInfo({ policy }: { policy: SeedPolicy }) {
  const [open, setOpen] = useState(false);
  const ref = useOverlayClose(open, () => setOpen(false));
  return (
    <div className="css-overlay-wrap" ref={ref}>
      <button
        type="button"
        className="css-icon-btn"
        data-testid="char-seed-info"
        aria-label={`Seed policy: ${seedPolicyLabel(policy)}`}
        aria-expanded={open}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
      >
        {policy === 'locked' ? <LockIcon /> : <ShuffleIcon />}
      </button>
      {open && (
        <div className="css-popover" role="dialog" onClick={(e) => e.stopPropagation()}>
          <strong>{seedPolicyLabel(policy)}.</strong> {SEED_POLICY_EXPLAINER[policy]}
        </div>
      )}
    </div>
  );
}

/** The card's 3-dot menu: Edit / Delete live here, not as card buttons. */
function CharacterMenu({
  name,
  onEdit,
  onDelete,
}: {
  name: string;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useOverlayClose(open, () => setOpen(false));
  return (
    <div className="css-overlay-wrap" ref={ref}>
      <button
        type="button"
        className="css-icon-btn"
        data-testid="char-menu"
        aria-label={`Actions for ${name}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
      >
        <DotsIcon />
      </button>
      {open && (
        <div className="css-menu" role="menu" onClick={(e) => e.stopPropagation()}>
          <button
            type="button"
            className="css-menu-item"
            role="menuitem"
            data-testid="char-menu-edit"
            onClick={() => {
              setOpen(false);
              onEdit();
            }}
          >
            Edit
          </button>
          <button
            type="button"
            className="css-menu-item"
            role="menuitem"
            data-danger="true"
            data-testid="char-menu-delete"
            onClick={() => {
              setOpen(false);
              onDelete();
            }}
          >
            Delete
          </button>
        </div>
      )}
    </div>
  );
}

export function Characters({
  library,
  onBuildSheet,
  onViewSheets,
  autoOpenCreate,
  onAutoOpenConsumed,
  onCreated,
  onCreateCancelled,
}: CharactersProps) {
  const [editor, setEditor] = useState<EditorState>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  // Arriving from the Builder's "create a character" detour: open the
  // editor immediately so the trip feels like one step.
  useEffect(() => {
    if (autoOpenCreate) {
      setEditor({ mode: 'create' });
      onAutoOpenConsumed?.();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoOpenCreate]);

  const editing: Character | undefined =
    editor?.mode === 'edit'
      ? library.characters.find((c) => c.id === editor.id)
      : undefined;

  // Sheet count per character drives where a card click lands: no sheets
  // yet → the Builder with this character preselected; has sheets → the
  // Sheets tab filtered to this character.
  const sheetsByCharacter = new Map<string, number>();
  for (const s of library.sheets) {
    sheetsByCharacter.set(s.characterId, (sheetsByCharacter.get(s.characterId) ?? 0) + 1);
  }

  // Generated panel images per character (newest sheet first, up to 4) —
  // shown as a thumbnail strip so a worked-on character looks worked-on.
  const thumbsByCharacter = new Map<string, string[]>();
  const sortedSheets = [...library.sheets].sort((a, b) =>
    b.updatedAt.localeCompare(a.updatedAt),
  );
  for (const s of sortedSheets) {
    for (const p of s.panels) {
      const url = p.outputs[0];
      if (!url) continue;
      const list = thumbsByCharacter.get(s.characterId) ?? [];
      if (list.length < 4) list.push(url);
      thumbsByCharacter.set(s.characterId, list);
    }
  }

  const askDelete = (id: string) => {
    setDeleteError(null);
    setConfirmDeleteId(id);
  };

  const doDelete = async (id: string) => {
    setConfirmDeleteId(null);
    const err = await library.deleteCharacter(id);
    if (err) setDeleteError(storeErrorMessage(err));
  };

  return (
    <Stack gap="md">
      <Group justify="space-between" align="center">
        <h2 style={{ margin: 0, fontSize: 20 }}>Characters</h2>
        <Button size="sm" onClick={() => setEditor({ mode: 'create' })}>
          New character
        </Button>
      </Group>

      {deleteError && <Alert color="error">{deleteError}</Alert>}

      {editor && (
        <CharacterEditor
          key={editor.mode === 'edit' ? editor.id : 'create'}
          initial={editing}
          stacks={library.stacks}
          onClose={() => {
            if (editor.mode === 'create') onCreateCancelled?.();
            setEditor(null);
          }}
          onSaved={(saved) => {
            const wasCreate = editor.mode === 'create';
            setEditor(null);
            if (wasCreate) onCreated?.(saved.id);
          }}
          saveCharacter={library.saveCharacter}
        />
      )}

      {library.characters.length === 0 && !editor && (
        <Card>
          <p style={{ margin: 0, opacity: 0.75 }}>
            No characters yet. Create one — give it a description, some traits,
            and optionally a reference portrait — then build a sheet from it.
          </p>
        </Card>
      )}

      <div className="css-grid-cards">
        {library.characters.map((c) => {
          const sheetCount = sheetsByCharacter.get(c.id) ?? 0;
          const thumbs = thumbsByCharacter.get(c.id) ?? [];
          return (
            <Card
              key={c.id}
              className="css-char-card"
              data-testid="char-card"
              onClick={() =>
                sheetCount > 0 ? onViewSheets(c.id) : onBuildSheet(c.id)
              }
            >
              <Group justify="space-between" align="flex-start" wrap={false}>
                <div style={{ display: 'flex', gap: 12, minWidth: 0 }}>
                  {c.referenceImage && (
                    <img
                      src={c.referenceImage.url}
                      alt=""
                      width={56}
                      height={56}
                      style={{ borderRadius: 8, objectFit: 'cover', flexShrink: 0 }}
                    />
                  )}
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 600 }}>{c.name}</div>
                    {c.description && (
                      <div
                        style={{
                          opacity: 0.75,
                          fontSize: 13,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          display: '-webkit-box',
                          WebkitLineClamp: 2,
                          WebkitBoxOrient: 'vertical',
                        }}
                      >
                        {c.description}
                      </div>
                    )}
                  </div>
                </div>
                <Group gap="xs" wrap={false}>
                  <SeedPolicyInfo policy={c.seedPolicy} />
                  <CharacterMenu
                    name={c.name}
                    onEdit={() => setEditor({ mode: 'edit', id: c.id })}
                    onDelete={() => askDelete(c.id)}
                  />
                </Group>
              </Group>

              {thumbs.length > 0 && (
                <Group gap="xs" style={{ marginTop: 10 }}>
                  {thumbs.map((url, i) => (
                    <img
                      key={`${url}-${i}`}
                      src={url}
                      alt=""
                      data-testid="char-card-thumb"
                      width={52}
                      height={52}
                      style={{ borderRadius: 8, objectFit: 'cover', display: 'block' }}
                    />
                  ))}
                </Group>
              )}

              {confirmDeleteId === c.id && (
                <div onClick={(e) => e.stopPropagation()}>
                  <p style={{ margin: '10px 0 0', fontSize: 13, opacity: 0.75 }}>
                    {sheetCount > 0
                      ? `Deleting ${c.name} won’t delete their sheets — ${sheetCount} sheet${sheetCount === 1 ? '' : 's'} keep their images, labeled “Unknown character”.`
                      : `Delete ${c.name}? This can’t be undone.`}
                  </p>
                  <Group gap="sm" style={{ marginTop: 8 }}>
                    <Button
                      size="sm"
                      color="red"
                      onClick={() => void doDelete(c.id)}
                      data-testid="char-confirm-delete"
                    >
                      Confirm delete
                    </Button>
                    <Button
                      size="sm"
                      variant="subtle"
                      onClick={() => setConfirmDeleteId(null)}
                    >
                      Keep
                    </Button>
                  </Group>
                </div>
              )}
            </Card>
          );
        })}
      </div>
    </Stack>
  );
}

// ---------------------------------------------------------------------------

interface EditorProps {
  initial?: Character;
  stacks: ModelStack[];
  onClose: () => void;
  onSaved: (saved: Character) => void;
  saveCharacter: SheetLibrary['saveCharacter'];
}

function CharacterEditor({ initial, stacks, onClose, onSaved, saveCharacter }: EditorProps) {
  const [name, setName] = useState(initial?.name ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [traits, setTraits] = useState((initial?.traits ?? []).join(', '));
  const [triggerWords, setTriggerWords] = useState((initial?.triggerWords ?? []).join(', '));
  const [negativePrompt, setNegativePrompt] = useState(initial?.negativePrompt ?? '');
  const [seedPolicy, setSeedPolicy] = useState<SeedPolicy>(initial?.seedPolicy ?? 'locked');
  const [defaultStackId, setDefaultStackId] = useState(initial?.defaultStackId ?? '');
  const [refImage, setRefImage] = useState<CharacterRefImage | undefined>(initial?.referenceImage);
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);

  // PRIVATE img2img source: unscanned, never displayed publicly by the host —
  // the url feeds straight into a workflow body's sourceImages.
  const { open: openUpload } = useImageUpload({ purpose: 'generationSource' });

  const nameError = touched && name.trim() === '' ? 'Give the character a name.' : undefined;

  const onUpload = async () => {
    setUploading(true);
    try {
      const info = await openUpload();
      if (info) {
        setRefImage({ url: info.url, width: info.width, height: info.height });
      }
    } finally {
      setUploading(false);
    }
  };

  const onSave = async () => {
    setTouched(true);
    if (name.trim() === '') return;
    setSaving(true);
    setError(null);
    const now = new Date().toISOString();
    const char: Character = initial
      ? {
          ...initial,
          name: name.trim(),
          description: description.trim(),
          traits: parseListInput(traits),
          triggerWords: parseListInput(triggerWords),
          negativePrompt: negativePrompt.trim(),
          seedPolicy,
          defaultStackId: defaultStackId || undefined,
          updatedAt: now,
        }
      : newCharacter({
          name: name.trim(),
          description: description.trim(),
          traits: parseListInput(traits),
          triggerWords: parseListInput(triggerWords),
          negativePrompt: negativePrompt.trim(),
          seedPolicy,
          ...(defaultStackId ? { defaultStackId } : {}),
        });
    // A removed portrait must not linger as an explicit `undefined` key.
    if (refImage) char.referenceImage = refImage;
    else delete char.referenceImage;
    const err = await saveCharacter(char);
    setSaving(false);
    if (err) {
      setError(storeErrorMessage(err));
      return;
    }
    onSaved(char);
  };

  return (
    <Card>
      <Stack gap="sm">
        <Group justify="space-between" align="center">
          <h3 style={{ margin: 0 }}>{initial ? 'Edit character' : 'New character'}</h3>
          <Button size="sm" variant="subtle" onClick={onClose}>
            Cancel
          </Button>
        </Group>

        {error && <Alert color="error">{error}</Alert>}

        <TextInput
          label="Name"
          placeholder="Nyx"
          value={name}
          onChange={(e) => setName(e.currentTarget.value)}
          error={nameError}
          data-testid="char-name"
        />
        <Textarea
          label="Description"
          placeholder="a cyberpunk fox mercenary, lean build, …"
          value={description}
          onChange={(e) => setDescription(e.currentTarget.value)}
          rows={3}
        />
        <TextInput
          label="Traits (comma-separated)"
          placeholder="silver-streaked fur, glowing amber eyes"
          value={traits}
          onChange={(e) => setTraits(e.currentTarget.value)}
        />
        <TextInput
          label="Trigger words (comma-separated)"
          placeholder="nyx_fox"
          value={triggerWords}
          onChange={(e) => setTriggerWords(e.currentTarget.value)}
        />
        <div style={{ fontSize: 12, opacity: 0.65, marginTop: -6 }}>
          Words that switch on this character’s look (usually from their
          LoRA) — they’re added to every prompt for this character.
        </div>
        <Textarea
          label="Negative prompt"
          placeholder="blurry, watermark, deformed"
          value={negativePrompt}
          onChange={(e) => setNegativePrompt(e.currentTarget.value)}
          rows={2}
        />

        <Group gap="md" align="flex-end">
          <Select
            label="Seed policy"
            value={seedPolicy}
            onChange={(v) => setSeedPolicy(v as SeedPolicy)}
            options={[
              { value: 'locked', label: 'Locked (reproducible)' },
              { value: 'varied', label: 'Varied (random per panel)' },
            ]}
          />
          <Select
            label="Default stack"
            value={defaultStackId}
            onChange={(v) => setDefaultStackId(v ?? '')}
            options={[
              { value: '', label: 'None' },
              ...stacks.map((s) => ({ value: s.id, label: s.name })),
            ]}
          />
        </Group>

        <div>
          <div style={{ fontSize: 14, fontWeight: 500, marginBottom: 6 }}>
            Reference portrait (optional)
          </div>
          <Group gap="sm" align="center">
            {refImage ? (
              <>
                <img
                  src={refImage.url}
                  alt="Reference portrait"
                  width={72}
                  height={72}
                  style={{ borderRadius: 8, objectFit: 'cover' }}
                />
                <Button size="sm" variant="subtle" color="red" onClick={() => setRefImage(undefined)}>
                  Remove
                </Button>
              </>
            ) : (
              <Button size="sm" variant="light" loading={uploading} onClick={() => void onUpload()}>
                Upload portrait
              </Button>
            )}
          </Group>
          <div style={{ fontSize: 12, opacity: 0.65, marginTop: 4 }}>
            Used as an img2img source when you enable it on a sheet — kept
            private, never published.
          </div>
        </div>

        <Group justify="flex-end">
          <Button onClick={() => void onSave()} loading={saving} data-testid="char-save">
            Save character
          </Button>
        </Group>
      </Stack>
    </Card>
  );
}
