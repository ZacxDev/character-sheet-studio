// Characters pages: the cast list, plus separate create/edit pages.
//
// A character is the reusable identity a sheet is built from — description,
// traits, trigger words, negative prompt, an optional reference portrait
// (uploaded as a PRIVATE img2img source via the host), and a seed policy.
// Everything persists through the sheet library (app storage, best-effort).

import { useCallback, useEffect, useRef, useState } from 'react';

import {
  useBlockContext,
  useBlockToken,
  useBuzzWorkflow,
  useConsentUnavailable,
  useImageUpload,
  useRequestConsent,
  useRequestSignIn,
} from '@civitai/blocks-react';
import {
  Alert,
  Button,
  Card,
  Group,
  Loader,
  Stack,
  TextInput,
  Textarea,
} from '@civitai/blocks-react/ui';
import type { WorkflowBody } from '@civitai/app-sdk/blocks';

import {
  BUDGETED_SCOPE,
  formatCost,
  hasBudgetedScope,
  isTerminalStatus,
} from '../money/generation.js';
import { startPollLoop } from '../money/pollLoop.js';
import { idempotencyKeyFor } from '../sheet/batch.js';
import {
  buildCharacterPromptEnhanceBody,
  buildNegativePromptEnhanceBody,
  enhanceOutcomeFromSnapshot,
  type EnhanceOutcome,
} from '../sheet/enhance.js';

import type {
  Character,
  CharacterRefImage,
  SeedPolicy,
} from '../sheet/types.js';
import { newCharacter } from '../sheet/types.js';
import type { SheetLibrary } from '../sheet/useSheetLibrary.js';
import { characterImageUrls, characterProfileUrl } from '../sheet/profile.js';
import { parseListInput, storeErrorMessage } from './common.js';
import {
  randomDescription,
  randomName,
  randomTraits,
  randomTriggerWord,
} from './random-character.js';

type EditorState = { mode: 'create' } | { mode: 'edit'; id: string } | null;

export interface CharactersProps {
  library: SheetLibrary;
  /** Jump to the Sheet Builder with this character preselected. */
  onBuildSheet: (characterId: string) => void;
  /** Jump to the Sheets page filtered to this character's sheets. */
  onViewSheets: (characterId: string) => void;
  /** Open the character's own page (details + their sheets). */
  onOpenCharacter?: (characterId: string) => void;
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

/** Per-field randomize: a dice icon button that re-rolls ONE form field. */
function DiceButton({
  label,
  testid,
  onRoll,
}: {
  label: string;
  testid: string;
  onRoll: () => void;
}) {
  return (
    <button
      type="button"
      className="css-icon-btn"
      style={{ width: 34, height: 34 }}
      aria-label={label}
      data-testid={testid}
      onClick={onRoll}
    >
      <DiceIcon />
    </button>
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
  onOpenCharacter,
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
  // Bumped to remount (reset) the inline empty-state create form on Cancel.
  const [inlineNonce, setInlineNonce] = useState(0);

  const openEditor = (next: Exclude<EditorState, null>) => {
    setEditor(next);
    onEditorOpened?.(next);
  };

  const editing: Character | undefined =
    editor?.mode === 'edit'
      ? library.characters.find((c) => c.id === editor.id)
      : undefined;

  // Sheet count per character — shown on the card; every card click opens
  // the character's own page regardless of count.
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
          profileChoices={
            editing ? characterImageUrls(library.sheets, editing.id) : []
          }
        />
      </Stack>
    );
  }

  const isEmpty = library.ready && library.characters.length === 0;

  return (
    <Stack gap="md">
      {!isEmpty && (
        <Group justify="flex-end" align="center">
          <Button size="sm" variant="light" onClick={() => openEditor({ mode: 'create' })}>
            New character
          </Button>
        </Group>
      )}

      {deleteError && <Alert color="error">{deleteError}</Alert>}

      {isEmpty ? (
        // Empty state: the create form itself, right on the page — no
        // "New character" click stands between a first-time viewer and
        // their first character. Cancel re-rolls a fresh form in place.
        <CharacterEditor
          key={`inline-create-${inlineNonce}`}
          initial={undefined}
          onClose={() => {
            setInlineNonce((n) => n + 1);
            onCreateCancelled?.();
          }}
          onSaved={(saved) => onCreated?.(saved.id)}
          saveCharacter={library.saveCharacter}
          profileChoices={[]}
        />
      ) : (
        <>
          {!library.ready && library.characters.length === 0 && (
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
          const openCharacter = () =>
            onOpenCharacter
              ? onOpenCharacter(c.id)
              : sheetCount > 0
                ? onViewSheets(c.id)
                : onBuildSheet(c.id);
          return (
            <Card
              key={c.id}
              className="css-char-card"
              data-testid="char-card"
              onClick={openCharacter}
            >
              <Group justify="space-between" align="flex-start" wrap={false}>
                <div style={{ display: 'flex', gap: 12, minWidth: 0, flex: 1 }}>
                  {(() => {
                    const profileUrl = characterProfileUrl(c, library.sheets);
                    return profileUrl ? (
                      <img
                        src={profileUrl}
                        alt=""
                        width={56}
                        height={56}
                        style={{ borderRadius: 8, objectFit: 'cover', flexShrink: 0 }}
                        data-testid="char-card-profile"
                      />
                    ) : (
                      <div
                        className="css-avatar-initial"
                        style={{ width: 56, height: 56, fontSize: 22 }}
                        aria-hidden="true"
                      >
                        {c.name.charAt(0).toUpperCase()}
                      </div>
                    );
                  })()}
                  <div style={{ minWidth: 0 }}>
                    <div className="css-char-name">{c.name}</div>
                    {c.description && (
                      <div className="css-char-desc">{c.description}</div>
                    )}
                  </div>
                </div>
                <CharacterMenu
                  name={c.name}
                  onEdit={() => openEditor({ mode: 'edit', id: c.id })}
                  onDelete={() => askDelete(c.id)}
                />
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

              <Group justify="flex-end" align="center" style={{ marginTop: 12 }}>
                <Button
                  size="sm"
                  data-testid="char-generate"
                  onClick={(e) => {
                    // The card click would open the same page — stop the
                    // bubble so the navigation fires exactly once.
                    e.stopPropagation();
                    openCharacter();
                  }}
                >
                  Generate
                </Button>
              </Group>

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
        </>
      )}
    </Stack>
  );
}

// ---------------------------------------------------------------------------

interface EditorProps {
  initial?: Character;
  onClose: () => void;
  onSaved: (saved: Character) => void;
  saveCharacter: SheetLibrary['saveCharacter'];
  /** The character's generated images — the profile picker's choices. */
  profileChoices: string[];
}

type EditorStepKey =
  | 'name'
  | 'prompts'
  | 'traits'
  | 'triggers'
  | 'portrait'
  | 'profile'
  | 'seed';

const STEP_LABELS: Record<EditorStepKey, string> = {
  name: 'Name',
  prompts: 'Prompts',
  traits: 'Traits',
  triggers: 'Trigger words',
  portrait: 'Reference portrait',
  profile: 'Profile image',
  seed: 'Seed policy',
};

function FieldHelp({ children }: { children: string }) {
  return (
    <div style={{ fontSize: 12, lineHeight: 1.45, opacity: 0.68 }}>{children}</div>
  );
}

function CharacterEditor({ initial, onClose, onSaved, saveCharacter, profileChoices }: EditorProps) {
  // Create opens with a rolled name already in the field — the name dice
  // re-rolls it, and every other randomizable field has its own dice.
  const [name, setName] = useState(initial?.name ?? randomName());
  const [description, setDescription] = useState(initial?.description ?? '');
  const [traits, setTraits] = useState((initial?.traits ?? []).join(', '));
  const [triggerWords, setTriggerWords] = useState((initial?.triggerWords ?? []).join(', '));
  const [negativePrompt, setNegativePrompt] = useState(initial?.negativePrompt ?? '');
  const [seedPolicy, setSeedPolicy] = useState<SeedPolicy>(initial?.seedPolicy ?? 'locked');
  const [refImage, setRefImage] = useState<CharacterRefImage | undefined>(initial?.referenceImage);
  const [profileUrl, setProfileUrl] = useState<string | undefined>(initial?.profileImageUrl);
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);
  const [step, setStep] = useState(0);

  const isCreate = !initial;

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

  // --- prompt enhancement (Prompts step) -------------------------------------
  // One Enhance button per prompt field, through the same chat-completion
  // step the Sheet Builder's panel enhancement uses, with the same money
  // rules: price first, one confirm, submit only on confirm. A successful
  // rewrite REPLACES the field's text outright — still editable, and
  // nothing persists until the character is saved. Each field prices and
  // runs separately; an empty field asks for text first.

  const { ready, viewer } = useBlockContext();
  const token = useBlockToken();
  const { estimate, submit, poll } = useBuzzWorkflow();
  const { requestSignIn } = useRequestSignIn();
  const { requestConsent } = useRequestConsent();
  const { refusal } = useConsentUnavailable();
  const granted = hasBudgetedScope(token?.scopes);
  const anon = ready && !viewer;

  type PromptField = 'positive' | 'negative';
  const [fxField, setFxField] = useState<PromptField | null>(null);
  const [fxPhase, setFxPhase] = useState<'idle' | 'estimating' | 'confirming' | 'running'>('idle');
  const [fxQuote, setFxQuote] = useState<number | null>(null);
  const [fxNotice, setFxNotice] = useState<string | null>(null);
  const [fxDone, setFxDone] = useState(false);
  const [fxConsentWait, setFxConsentWait] = useState(false);
  const fxIntentRef = useRef(false);
  const fxRunRef = useRef(0);
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

  const fxBody = useCallback(
    (field: PromptField): WorkflowBody =>
      field === 'positive'
        ? buildCharacterPromptEnhanceBody(description.trim())
        : buildNegativePromptEnhanceBody(negativePrompt.trim()),
    [description, negativePrompt],
  );

  const runFxWorkflow = useCallback(
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

  const estimateFx = useCallback(
    async (field: PromptField) => {
      setFxPhase('estimating');
      setFxNotice(null);
      setFxQuote(null);
      setFxDone(false);
      try {
        const snap = await estimate(fxBody(field));
        const cost = snap.cost?.total;
        if (snap.status === 'failed' || snap.error || typeof cost !== 'number') {
          setFxNotice('Couldn’t price the enhancement — your prompt is unchanged.');
          setFxPhase('idle');
          return;
        }
        setFxQuote(cost);
        setFxPhase('confirming');
      } catch {
        setFxNotice('Couldn’t price the enhancement — your prompt is unchanged.');
        setFxPhase('idle');
      }
    },
    [estimate, fxBody],
  );
  const estimateFxRef = useRef(estimateFx);
  estimateFxRef.current = estimateFx;

  const startFxEnhance = (field: PromptField) => {
    const text = field === 'positive' ? description : negativePrompt;
    setFxField(field);
    setFxNotice(null);
    setFxDone(false);
    if (text.trim() === '') {
      setFxNotice('Write the prompt first, then enhance it.');
      return;
    }
    if (anon) {
      requestSignIn();
      setFxNotice("You're browsing as a guest — sign in to enhance prompts.");
      return;
    }
    if (!granted) {
      fxIntentRef.current = true;
      setFxConsentWait(true);
      requestConsent({ scopes: [BUDGETED_SCOPE] });
      return;
    }
    void estimateFxRef.current(field);
  };

  // Auto-resume enhancement pricing after a consent grant.
  useEffect(() => {
    if (granted && fxIntentRef.current && fxField) {
      fxIntentRef.current = false;
      setFxConsentWait(false);
      void estimateFxRef.current(fxField);
    }
  }, [granted, fxField]);

  useEffect(() => {
    if (refusal && fxConsentWait) {
      fxIntentRef.current = false;
      setFxConsentWait(false);
      setFxNotice(
        'Spending approval isn’t available in this environment, so enhancement can’t run here.',
      );
    }
  }, [refusal, fxConsentWait]);

  const runFxSubmit = useCallback(async () => {
    if (fxQuote == null || !fxField) {
      setFxPhase('idle');
      setFxQuote(null);
      return;
    }
    const field = fxField;
    setFxPhase('running');
    fxRunRef.current += 1;
    const outcome = await runFxWorkflow(
      fxBody(field),
      idempotencyKeyFor('enhance', `character-editor:${field}`, fxRunRef.current),
    );
    setFxQuote(null);
    setFxPhase('idle');
    if (outcome.type === 'text') {
      if (field === 'positive') setDescription(outcome.text);
      else setNegativePrompt(outcome.text);
      setFxNotice(null);
      setFxDone(true);
    } else if (outcome.type === 'withheld') {
      setFxNotice(`The enhancement was withheld: ${outcome.reason} Your prompt is unchanged.`);
    } else {
      setFxNotice('The enhancement didn’t come back — your prompt is unchanged.');
    }
  }, [fxField, fxQuote, fxBody, runFxWorkflow]);

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
    // Same for the profile pick: unset means "first generated image".
    if (profileUrl) char.profileImageUrl = profileUrl;
    else delete char.profileImageUrl;
    const err = await saveCharacter(char);
    setSaving(false);
    if (err) {
      setError(storeErrorMessage(err));
      return;
    }
    onSaved(char);
  };

  // The Profile step only exists when the character has generated images
  // to pick from — creating (or a character with no generations yet) keeps
  // the original six steps.
  const stepKeys: EditorStepKey[] = [
    'name',
    'prompts',
    'traits',
    'triggers',
    'portrait',
    ...(profileChoices.length > 0 ? (['profile'] as const) : []),
    'seed',
  ];
  const stepKey = stepKeys[step] ?? 'name';
  const lastStep = stepKeys.length - 1;
  const goBack = () => setStep((s) => Math.max(0, s - 1));
  const goNext = () => {
    if (stepKey === 'name' && name.trim() === '') {
      setTouched(true);
      return;
    }
    setStep((s) => Math.min(lastStep, s + 1));
  };

  // The Enhance row + its price-confirm / consent / notice alerts, rendered
  // under each prompt field on the Prompts step.
  const renderFx = (field: PromptField) => (
    <Stack gap="xs">
      <Group justify="flex-end">
        <Button
          variant="light"
          color="grape"
          size="sm"
          onClick={() => startFxEnhance(field)}
          loading={
            fxField === field && (fxPhase === 'estimating' || fxPhase === 'running')
          }
          disabled={
            fxPhase === 'confirming' ||
            fxPhase === 'running' ||
            (fxPhase === 'estimating' && fxField !== field)
          }
          data-testid={field === 'positive' ? 'char-enhance-positive' : 'char-enhance-negative'}
        >
          {fxField === field && fxPhase === 'running'
            ? 'Enhancing…'
            : fxField === field && fxPhase === 'estimating'
              ? 'Pricing…'
              : 'Enhance ✦'}
        </Button>
      </Group>
      {fxField === field && fxConsentWait && (
        <Alert color="info" data-testid="char-enhance-consent">
          <Loader size="sm" /> Waiting for your approval in the Civitai dialog…
        </Alert>
      )}
      {fxField === field && fxPhase === 'confirming' && fxQuote != null && (
        <Alert color="info" data-testid="char-enhance-confirm">
          <Stack gap="xs">
            <span>Enhance this prompt · ≈{formatCost(fxQuote)} Buzz</span>
            <Group justify="flex-end">
              <Button
                variant="subtle"
                size="sm"
                onClick={() => {
                  setFxQuote(null);
                  setFxPhase('idle');
                }}
              >
                Cancel
              </Button>
              <Button
                color="grape"
                size="sm"
                onClick={() => void runFxSubmit()}
                data-testid="char-enhance-confirm-run"
              >
                Enhance · {formatCost(fxQuote)} Buzz
              </Button>
            </Group>
          </Stack>
        </Alert>
      )}
      {fxField === field && fxDone && (
        <Alert color="info" data-testid="char-enhance-applied">
          Enhanced ✦ — the field above now holds the rewrite.
        </Alert>
      )}
      {fxField === field && fxNotice && (
        <Alert color="info" data-testid="char-enhance-notice">
          {fxNotice}
        </Alert>
      )}
    </Stack>
  );

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

        <div
          style={{ fontSize: 13, fontWeight: 600, opacity: 0.72 }}
          data-testid="char-step-indicator"
        >
          Step {step + 1} of {stepKeys.length} · {STEP_LABELS[stepKey]}
        </div>

        {stepKey === 'name' && (
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
                <DiceButton
                  label="Random name"
                  testid="char-name-dice"
                  onRoll={() => setName(randomName())}
                />
              )}
            </Group>
            <FieldHelp>
              The name shown on character cards and sheets. A short, distinct
              name is easiest to scan.
            </FieldHelp>
          </Stack>
        )}

        {stepKey === 'prompts' && (
          <Stack gap="sm">
            <Stack gap="xs">
              <Group gap="xs" align="flex-end" wrap={false}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <Textarea
                    label="Positive prompt"
                    placeholder="a cyberpunk fox mercenary, lean build, …"
                    value={description}
                    onChange={(e) => {
                      setDescription(e.currentTarget.value);
                      if (fxField === 'positive') setFxDone(false);
                    }}
                    rows={3}
                    data-testid="char-positive-prompt"
                  />
                </div>
                {isCreate && (
                  <DiceButton
                    label="Random positive prompt"
                    testid="char-positive-dice"
                    onRoll={() => {
                      setDescription(randomDescription());
                      if (fxField === 'positive') setFxDone(false);
                    }}
                  />
                )}
              </Group>
              <FieldHelp>
                Describe the character and the look you want. This text starts
                every panel prompt for this character.
              </FieldHelp>
              {renderFx('positive')}
            </Stack>
            <Stack gap="xs">
              <Textarea
                label="Negative prompt (optional)"
                placeholder="blurry, watermark, deformed"
                value={negativePrompt}
                onChange={(e) => {
                  setNegativePrompt(e.currentTarget.value);
                  if (fxField === 'negative') setFxDone(false);
                }}
                rows={2}
                data-testid="char-negative-prompt"
              />
              <FieldHelp>
                Optional — list anything to keep out of the images. Leave this
                blank if you do not need one; it is not required.
              </FieldHelp>
              {renderFx('negative')}
            </Stack>
          </Stack>
        )}

        {stepKey === 'traits' && (
          <Stack gap="xs">
            <Group gap="xs" align="flex-end" wrap={false}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <TextInput
                  label="Traits (comma-separated)"
                  placeholder="silver-streaked fur, glowing amber eyes"
                  value={traits}
                  onChange={(e) => setTraits(e.currentTarget.value)}
                  data-testid="char-traits"
                />
              </div>
              {isCreate && (
                <DiceButton
                  label="Random traits"
                  testid="char-traits-dice"
                  onRoll={() => setTraits(randomTraits().join(', '))}
                />
              )}
            </Group>
            <FieldHelp>
              Fixed details that should stay consistent, separated by commas —
              species, hair, eyes, markings, or signature clothing.
            </FieldHelp>
          </Stack>
        )}

        {stepKey === 'triggers' && (
          <Stack gap="xs">
            <Group gap="xs" align="flex-end" wrap={false}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <TextInput
                  label="Trigger words (comma-separated)"
                  placeholder="nyx_fox"
                  value={triggerWords}
                  onChange={(e) => setTriggerWords(e.currentTarget.value)}
                  data-testid="char-trigger-words"
                />
              </div>
              {isCreate && (
                <DiceButton
                  label="Random trigger word"
                  testid="char-triggers-dice"
                  onRoll={() => setTriggerWords(randomTriggerWord())}
                />
              )}
            </Group>
            <FieldHelp>
              Words that switch on this character’s look, usually from their
              LoRA. They are added to every prompt for this character.
            </FieldHelp>
          </Stack>
        )}

        {stepKey === 'portrait' && (
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

        {stepKey === 'profile' && (
          <Stack gap="xs">
            <div>
              <div style={{ fontSize: 14, fontWeight: 500, marginBottom: 6 }}>
                Profile image
              </div>
              <div className="css-profile-grid">
                {profileChoices.map((url) => {
                  // The current profile: the explicit pick, or — with no
                  // pick — the first generated image (the default).
                  const current = profileUrl ?? profileChoices[0];
                  return (
                    <button
                      key={url}
                      type="button"
                      className="css-profile-option"
                      data-testid="char-profile-option"
                      data-url={url}
                      data-selected={current === url}
                      aria-pressed={current === url}
                      aria-label="Set as profile image"
                      onClick={() => setProfileUrl(url)}
                    >
                      <img src={url} alt="" />
                    </button>
                  );
                })}
              </div>
            </div>
            {profileUrl && (
              <div>
                <Button
                  size="sm"
                  variant="subtle"
                  data-testid="char-profile-reset"
                  onClick={() => setProfileUrl(undefined)}
                >
                  Reset to first generated image
                </Button>
              </div>
            )}
            <FieldHelp>
              Shown wherever this character appears. Display only — it never
              feeds generation. With no pick, the first generated image is
              used.
            </FieldHelp>
          </Stack>
        )}

        {stepKey === 'seed' && (
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
