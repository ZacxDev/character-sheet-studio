// Character page: everything about one character in one place — their
// details, and every sheet built from them, each with its own image
// carousel. A sheet here can be re-run on ANY character: pick who in the
// row's character select and hit Run, and the Builder opens seeded with
// that sheet's stack + panels for the chosen character.

import { useState } from 'react';

import { Button, Card, Group, Select, Stack } from '@civitai/blocks-react/ui';

import type { SheetJob } from '../sheet/types.js';
import type { SheetLibrary } from '../sheet/useSheetLibrary.js';

export interface CharacterViewProps {
  library: SheetLibrary;
  characterId: string;
  onBack: () => void;
  onEdit: () => void;
  onNewSheet: () => void;
  onOpenSheet: (sheetId: string) => void;
  /** Open the Builder seeded with this sheet's stack + panels, for this character. */
  onRunSheet: (characterId: string, sheetId: string) => void;
}

function seedPolicyText(policy: string): string {
  return policy === 'locked'
    ? 'Locked seed — every panel reuses the same seed, so sheets reproduce consistently.'
    : 'Varied seed — each panel rolls a fresh seed.';
}

function SheetRow({
  sheet,
  characters,
  defaultCharacterId,
  onOpenSheet,
  onRunSheet,
}: {
  sheet: SheetJob;
  characters: { id: string; name: string }[];
  defaultCharacterId: string;
  onOpenSheet: (sheetId: string) => void;
  onRunSheet: (characterId: string, sheetId: string) => void;
}) {
  const [runFor, setRunFor] = useState(defaultCharacterId);
  const outputs = sheet.panels.flatMap((p) =>
    p.outputs[0] ? [{ url: p.outputs[0], label: p.label }] : [],
  );
  const doneCount = sheet.panels.filter((p) => p.outputs.length > 0).length;

  return (
    <Card data-testid="char-view-sheet">
      <Stack gap="sm">
        <Group justify="space-between" align="center" wrap={false}>
          <div style={{ minWidth: 0 }}>
            <div className="css-char-name">{sheet.name}</div>
            <div style={{ fontSize: 13, opacity: 0.7 }}>
              {new Date(sheet.createdAt).toLocaleDateString()} · {doneCount}/
              {sheet.panels.length} panels generated
            </div>
          </div>
          <Button size="sm" variant="light" onClick={() => onOpenSheet(sheet.id)}>
            Open
          </Button>
        </Group>

        {outputs.length > 0 && (
          <div className="css-char-thumbs">
            {outputs.map((o, i) => (
              <img
                key={`${o.url}-${i}`}
                src={o.url}
                alt={o.label}
                title={o.label}
                data-testid="char-view-thumb"
              />
            ))}
          </div>
        )}

        <Group gap="sm" align="flex-end">
          <div style={{ flex: 1, minWidth: 160 }}>
            <Select
              label="Run this sheet for"
              value={runFor}
              onChange={(v) => setRunFor(v)}
              data-testid="char-view-run-for"
            >
              {characters.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </div>
          <Button
            size="sm"
            data-testid="char-view-run"
            onClick={() => onRunSheet(runFor, sheet.id)}
          >
            Run sheet
          </Button>
        </Group>
      </Stack>
    </Card>
  );
}

export function CharacterView({
  library,
  characterId,
  onBack,
  onEdit,
  onNewSheet,
  onOpenSheet,
  onRunSheet,
}: CharacterViewProps) {
  const character = library.characters.find((c) => c.id === characterId);
  const sheets = library.sheets
    .filter((s) => s.characterId === characterId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  if (library.ready && !character) {
    return (
      <Card>
        <Stack gap="sm">
          <p style={{ margin: 0, opacity: 0.75 }}>That character no longer exists.</p>
          <div>
            <Button size="sm" onClick={onBack}>
              Back to characters
            </Button>
          </div>
        </Stack>
      </Card>
    );
  }

  if (!character) {
    return (
      <Card>
        <p style={{ margin: 0, opacity: 0.75 }}>Loading character…</p>
      </Card>
    );
  }

  return (
    <Stack gap="md">
      <div>
        <Button size="sm" variant="subtle" onClick={onBack}>
          ← Characters
        </Button>
      </div>

      <Card>
        <Stack gap="sm">
          <Group justify="space-between" align="flex-start" wrap={false}>
            <div style={{ display: 'flex', gap: 14, minWidth: 0 }}>
              {character.referenceImage && (
                <img
                  src={character.referenceImage.url}
                  alt=""
                  width={72}
                  height={72}
                  style={{ borderRadius: 10, objectFit: 'cover', flexShrink: 0 }}
                />
              )}
              <div style={{ minWidth: 0 }}>
                <h2 style={{ margin: 0, fontSize: 22 }}>{character.name}</h2>
                {character.description && (
                  <p style={{ margin: '4px 0 0', opacity: 0.8, overflowWrap: 'anywhere' }}>
                    {character.description}
                  </p>
                )}
              </div>
            </div>
            <Button size="sm" variant="light" onClick={onEdit}>
              Edit
            </Button>
          </Group>

          {character.traits.length > 0 && (
            <p style={{ margin: 0, fontSize: 14 }}>
              <strong>Traits:</strong> {character.traits.join(', ')}
            </p>
          )}
          {character.triggerWords.length > 0 && (
            <p style={{ margin: 0, fontSize: 14 }}>
              <strong>Trigger words:</strong> {character.triggerWords.join(', ')}
            </p>
          )}
          <p style={{ margin: 0, fontSize: 13, opacity: 0.75 }}>
            {seedPolicyText(character.seedPolicy)}
          </p>

          <div>
            <Button data-testid="char-view-new-sheet" onClick={onNewSheet}>
              New sheet
            </Button>
          </div>
        </Stack>
      </Card>

      {sheets.length === 0 ? (
        <Card>
          <p style={{ margin: 0, opacity: 0.75 }}>
            No sheets yet for {character.name} — build the first one.
          </p>
        </Card>
      ) : (
        sheets.map((sheet) => (
          <SheetRow
            key={sheet.id}
            sheet={sheet}
            characters={library.characters.map((c) => ({ id: c.id, name: c.name }))}
            defaultCharacterId={character.id}
            onOpenSheet={onOpenSheet}
            onRunSheet={onRunSheet}
          />
        ))
      )}
    </Stack>
  );
}
