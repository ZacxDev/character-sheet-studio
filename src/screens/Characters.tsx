// Characters screen: the cast list + the character editor.
//
// A character is the reusable identity a sheet is built from — description,
// traits, trigger words, negative prompt, an optional reference portrait
// (uploaded as a PRIVATE img2img source via the host), and a seed policy.
// Everything persists through the sheet library (app storage, best-effort).

import { useState } from 'react';

import { useImageUpload } from '@civitai/blocks-react';
import {
  Alert,
  Badge,
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
}

type EditorState = { mode: 'create' } | { mode: 'edit'; id: string } | null;

function seedPolicyLabel(p: SeedPolicy): string {
  return p === 'locked' ? 'Locked (reproducible)' : 'Varied (random per panel)';
}

export function Characters({ library, onBuildSheet }: CharactersProps) {
  const [editor, setEditor] = useState<EditorState>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const editing: Character | undefined =
    editor?.mode === 'edit'
      ? library.characters.find((c) => c.id === editor.id)
      : undefined;

  const onDelete = async (id: string) => {
    if (confirmDeleteId !== id) {
      setConfirmDeleteId(id);
      return;
    }
    setConfirmDeleteId(null);
    setDeleteError(null);
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
          onClose={() => setEditor(null)}
          onSaved={() => setEditor(null)}
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

      <Stack gap="sm">
        {library.characters.map((c) => (
          <Card key={c.id}>
            <Group justify="space-between" align="flex-start">
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
                  <Group gap="xs" style={{ marginTop: 6 }}>
                    {c.traits.slice(0, 3).map((t) => (
                      <Badge key={t} size="sm" variant="light">
                        {t}
                      </Badge>
                    ))}
                    {c.triggerWords.length > 0 && (
                      <Badge size="sm" variant="outline">
                        {c.triggerWords.length} trigger word{c.triggerWords.length === 1 ? '' : 's'}
                      </Badge>
                    )}
                    <Badge size="sm" variant="outline">
                      {seedPolicyLabel(c.seedPolicy)}
                    </Badge>
                  </Group>
                </div>
              </div>
              <Group gap="xs">
                <Button size="sm" variant="light" onClick={() => onBuildSheet(c.id)}>
                  Build sheet
                </Button>
                <Button size="sm" variant="subtle" onClick={() => setEditor({ mode: 'edit', id: c.id })}>
                  Edit
                </Button>
                <Button
                  size="sm"
                  variant="subtle"
                  color="red"
                  onClick={() => void onDelete(c.id)}
                >
                  {confirmDeleteId === c.id ? 'Confirm delete?' : 'Delete'}
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
  initial?: Character;
  stacks: ModelStack[];
  onClose: () => void;
  onSaved: () => void;
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
    onSaved();
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
