// Characters pages: the cast list, plus separate create/edit pages.
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
  Stack,
  TextInput,
  Textarea,
} from '@civitai/blocks-react/ui';

import type {
  Character,
  CharacterRefImage,
  SeedPolicy,
} from '../sheet/types.js';
import { newCharacter } from '../sheet/types.js';
import type { SheetLibrary } from '../sheet/useSheetLibrary.js';
import { parseListInput, storeErrorMessage } from './common.js';
import { randomCharacter, randomName } from './random-character.js';

type EditorState = { mode: 'create' } | { mode: 'edit'; id: string } | null;

export interface CharactersProps {
  library: SheetLibrary;
  /** Jump to the Sheet Builder with this character preselected. */
  onBuildSheet: (characterId: string) => void;
  /** Jump to the Sheets page filtered to this character's sheets. */
  onViewSheets: (characterId: string) => void;
  /** Editor selected by the current page route, when the shell is routing. */
  initialEditor?: EditorState;
  /** The viewer asked to open the create/edit page. */
  onEditorOpened?: (editor: Exclude<EditorState, null>) => void;
  /** The editor page was closed without creating a character. */
  onEditorClosed?: () => void;
  /** A new character was saved (create mode) — the return trip home. */
  onCreated?: (characterId: string) => void;
  /** An existing character was saved from its edit page. */
  onEdited?: () => void;
  /** The create editor was closed without saving. */
  onCreateCancelled?: () => void;
}

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

function DiceIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <rect x="3" y="3" width="18" height="18" rx="4" />
      <circle cx="8.5" cy="8.5" r="1.3" fill="currentColor" stroke="none" />
      <circle cx="15.5" cy="15.5" r="1.3" fill="currentColor" stroke="none" />
      <circle cx="15.5" cy="8.5" r="1.3" fill="currentColor" stroke="none" />
      <circle cx="8.5" cy="15.5" r="1.3" fill="currentColor" stroke="none" />
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
  initialEditor,
  onEditorOpened,
  onEditorClosed,
  onCreated,
  onEdited,
  onCreateCancelled,
}: CharactersProps) {
  const [editor, setEditor] = useState<EditorState>(initialEditor ?? null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const openEditor = (next: Exclude<EditorState, null>) => {
    setEditor(next);
    onEditorOpened?.(next);
  };

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

  // Generated panel images per character (newest sheet first, up to 8 —
  // the carousel shows them at a fixed size, so more is fine) — a strip
  // of thumbs makes a worked-on character look worked-on.
  const thumbsByCharacter = new Map<string, string[]>();
  const sortedSheets = [...library.sheets].sort((a, b) =>
    b.updatedAt.localeCompare(a.updatedAt),
  );
  for (const s of sortedSheets) {
    for (const p of s.panels) {
      const url = p.outputs[0];
      if (!url) continue;
      const list = thumbsByCharacter.get(s.characterId) ?? [];
      if (list.length < 8) list.push(url);
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

  // Create/edit are their own pages: when one is open, the cast list is not
  // rendered underneath it. That keeps each route to one job and lets the
  // host's Back action return to the list page.
  if (editor) {
    if (editor.mode === 'edit' && library.ready && !editing) {
      return (
        <Card>
          <Stack gap="sm">
            <p style={{ margin: 0, opacity: 0.75 }}>
              That character no longer exists.
            </p>
            <div>
              <Button
                size="sm"
                onClick={() => {
                  setEditor(null);
                  onEditorClosed?.();
                }}
              >
                Back to characters
              </Button>
            </div>
          </Stack>
        </Card>
      );
    }

    return (
      <Stack gap="md">
        {deleteError && <Alert color="error">{deleteError}</Alert>}
        <CharacterEditor
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
          saveCharacter={library.saveCharacter}
        />
      </Stack>
    );
  }

  return (
    <Stack gap="md">
      <Group justify="space-between" align="center">
        <h2 style={{ margin: 0, fontSize: 20 }}>Characters</h2>
        <Button size="sm" onClick={() => openEditor({ mode: 'create' })}>
          New character
        </Button>
      </Group>

      {deleteError && <Alert color="error">{deleteError}</Alert>}

      {library.characters.length === 0 && (
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
                    onEdit={() => openEditor({ mode: 'edit', id: c.id })}
                    onDelete={() => askDelete(c.id)}
                  />
                </Group>
              </Group>

              {thumbs.length > 0 && (
                <div className="css-char-thumbs">
                  {thumbs.map((url, i) => (
                    <img
                      key={`${url}-${i}`}
                      src={url}
                      alt=""
                      data-testid="char-card-thumb"
                    />
                  ))}
                </div>
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
  onClose: () => void;
  onSaved: (saved: Character) => void;
  saveCharacter: SheetLibrary['saveCharacter'];
}

const CHARACTER_STEPS = [
  'Name',
  'Prompts',
  'Traits',
  'Trigger words',
  'Reference portrait',
  'Seed policy',
] as const;

function FieldHelp({ children }: { children: string }) {
  return (
    <div style={{ fontSize: 12, lineHeight: 1.45, opacity: 0.68 }}>{children}</div>
  );
}

function CharacterEditor({ initial, onClose, onSaved, saveCharacter }: EditorProps) {
  const [name, setName] = useState(initial?.name ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [traits, setTraits] = useState((initial?.traits ?? []).join(', '));
  const [triggerWords, setTriggerWords] = useState((initial?.triggerWords ?? []).join(', '));
  const [negativePrompt, setNegativePrompt] = useState(initial?.negativePrompt ?? '');
  const [seedPolicy, setSeedPolicy] = useState<SeedPolicy>(initial?.seedPolicy ?? 'locked');
  const [refImage, setRefImage] = useState<CharacterRefImage | undefined>(initial?.referenceImage);
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);
  const [confirmRandomize, setConfirmRandomize] = useState(false);
  const [step, setStep] = useState(0);

  const isCreate = !initial;

  /** Fields a randomize would overwrite — everything except the name. */
  const formDirty =
    description.trim() !== '' ||
    traits.trim() !== '' ||
    triggerWords.trim() !== '' ||
    negativePrompt.trim() !== '';

  const applyRandomize = () => {
    const rc = randomCharacter();
    setName(rc.name);
    setDescription(rc.description);
    setTraits(rc.traits.join(', '));
    setTriggerWords(rc.triggerWord);
    setConfirmRandomize(false);
  };

  const onRandomize = () => {
    // Overwriting typed work is a decision, not a side effect: when any
    // non-name field already has input, ask first; otherwise just roll.
    if (formDirty && !confirmRandomize) {
      setConfirmRandomize(true);
      return;
    }
    applyRandomize();
  };

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
    if (name.trim() === '') {
      // The name lives on step one; take the viewer back to the field that
      // needs attention instead of leaving the error stranded on the last step.
      setStep(0);
      return;
    }
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
          updatedAt: now,
        }
      : newCharacter({
          name: name.trim(),
          description: description.trim(),
          traits: parseListInput(traits),
          triggerWords: parseListInput(triggerWords),
          negativePrompt: negativePrompt.trim(),
          seedPolicy,
        });
    // Characters no longer carry a preselected stack: the stack is chosen in
    // the Sheet Builder for each run, so any legacy link is dropped on save.
    delete char.defaultStackId;
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

  const lastStep = CHARACTER_STEPS.length - 1;
  const goBack = () => setStep((s) => Math.max(0, s - 1));
  const goNext = () => {
    if (step === 0 && name.trim() === '') {
      setTouched(true);
      return;
    }
    setStep((s) => Math.min(lastStep, s + 1));
  };

  return (
    <Card>
      <Stack gap="sm">
        <Group justify="space-between" align="center">
          <h3 style={{ margin: 0 }}>{initial ? 'Edit character' : 'New character'}</h3>
          <Group gap="sm">
            <Button
              size="sm"
              variant="light"
              onClick={onRandomize}
              data-testid="char-randomize"
            >
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <DiceIcon /> Randomize
              </span>
            </Button>
            <Button size="sm" variant="subtle" onClick={onClose}>
              Cancel
            </Button>
          </Group>
        </Group>

        {confirmRandomize && (
          <Alert color="warning">
            <Group justify="space-between" align="center" wrap>
              <span>
                Replace the description, traits, and trigger words you’ve
                typed with a random character?
              </span>
              <Group gap="sm">
                <Button
                  size="sm"
                  onClick={applyRandomize}
                  data-testid="char-randomize-confirm"
                >
                  Replace fields
                </Button>
                <Button
                  size="sm"
                  variant="subtle"
                  onClick={() => setConfirmRandomize(false)}
                >
                  Keep mine
                </Button>
              </Group>
            </Group>
          </Alert>
        )}

        {error && <Alert color="error">{error}</Alert>}

        <div
          style={{ fontSize: 13, fontWeight: 600, opacity: 0.72 }}
          data-testid="char-step-indicator"
        >
          Step {step + 1} of {CHARACTER_STEPS.length} · {CHARACTER_STEPS[step]}
        </div>

        {step === 0 && (
          <Stack gap="xs">
            <Group gap="xs" align="flex-end" wrap={false}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <TextInput
                  label="Name"
                  placeholder="Nyx"
                  value={name}
                  onChange={(e) => setName(e.currentTarget.value)}
                  error={nameError}
                  data-testid="char-name"
                />
              </div>
              {isCreate && (
                <button
                  type="button"
                  className="css-icon-btn"
                  style={{ width: 34, height: 34 }}
                  aria-label="Random name"
                  data-testid="char-name-dice"
                  onClick={() => setName(randomName())}
                >
                  <DiceIcon />
                </button>
              )}
            </Group>
            <FieldHelp>
              The name shown on character cards and sheets. A short, distinct
              name is easiest to scan.
            </FieldHelp>
          </Stack>
        )}

        {step === 1 && (
          <Stack gap="sm">
            <Stack gap="xs">
              <Textarea
                label="Positive prompt"
                placeholder="a cyberpunk fox mercenary, lean build, …"
                value={description}
                onChange={(e) => setDescription(e.currentTarget.value)}
                rows={3}
                data-testid="char-positive-prompt"
              />
              <FieldHelp>
                Describe the character and the look you want. This text starts
                every panel prompt for this character.
              </FieldHelp>
            </Stack>
            <Stack gap="xs">
              <Textarea
                label="Negative prompt (optional)"
                placeholder="blurry, watermark, deformed"
                value={negativePrompt}
                onChange={(e) => setNegativePrompt(e.currentTarget.value)}
                rows={2}
                data-testid="char-negative-prompt"
              />
              <FieldHelp>
                Optional — list anything to keep out of the images. Leave this
                blank if you do not need one; it is not required.
              </FieldHelp>
            </Stack>
          </Stack>
        )}

        {step === 2 && (
          <Stack gap="xs">
            <TextInput
              label="Traits (comma-separated)"
              placeholder="silver-streaked fur, glowing amber eyes"
              value={traits}
              onChange={(e) => setTraits(e.currentTarget.value)}
              data-testid="char-traits"
            />
            <FieldHelp>
              Fixed details that should stay consistent, separated by commas —
              species, hair, eyes, markings, or signature clothing.
            </FieldHelp>
          </Stack>
        )}

        {step === 3 && (
          <Stack gap="xs">
            <TextInput
              label="Trigger words (comma-separated)"
              placeholder="nyx_fox"
              value={triggerWords}
              onChange={(e) => setTriggerWords(e.currentTarget.value)}
              data-testid="char-trigger-words"
            />
            <FieldHelp>
              Words that switch on this character’s look, usually from their
              LoRA. They are added to every prompt for this character.
            </FieldHelp>
          </Stack>
        )}

        {step === 4 && (
          <Stack gap="xs">
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
                    <Button
                      size="sm"
                      variant="subtle"
                      color="red"
                      onClick={() => setRefImage(undefined)}
                    >
                      Remove
                    </Button>
                  </>
                ) : (
                  <Button
                    size="sm"
                    variant="light"
                    loading={uploading}
                    onClick={() => void onUpload()}
                  >
                    Upload portrait
                  </Button>
                )}
              </Group>
            </div>
            <FieldHelp>
              Used as an img2img source when you enable it on a sheet. It is
              kept private and never published.
            </FieldHelp>
          </Stack>
        )}

        {step === 5 && (
          <Stack gap="xs">
            <div>
              <div style={{ fontSize: 14, fontWeight: 500, marginBottom: 6 }}>
                Seed policy
              </div>
              <Button
                variant="light"
                role="switch"
                aria-checked={seedPolicy === 'locked'}
                aria-label="Seed policy"
                data-testid="char-seed-toggle"
                onClick={() =>
                  setSeedPolicy((p) => (p === 'locked' ? 'varied' : 'locked'))
                }
              >
                <span
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}
                >
                  {seedPolicy === 'locked' ? <LockIcon /> : <ShuffleIcon />}
                  {seedPolicyLabel(seedPolicy)}
                </span>
              </Button>
            </div>
            <FieldHelp>{SEED_POLICY_EXPLAINER[seedPolicy]}</FieldHelp>
          </Stack>
        )}

        <Group justify="space-between" align="center">
          {step > 0 ? (
            <Button
              variant="subtle"
              onClick={goBack}
              data-testid="char-step-back"
            >
              Back
            </Button>
          ) : (
            <span />
          )}
          {step < lastStep ? (
            <Button onClick={goNext} data-testid="char-step-next">
              Next
            </Button>
          ) : (
            <Button
              onClick={() => void onSave()}
              loading={saving}
              data-testid="char-save"
            >
              Save character
            </Button>
          )}
        </Group>
      </Stack>
    </Card>
  );
}
