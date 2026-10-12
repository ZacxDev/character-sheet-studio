// Character page: one character, their sheets, and quick ways to make more.
// The header keeps just the identity (portrait + name) and the actions —
// the descriptive details live in a collapsed "View details" section. Each
// sheet is a card: click it to open the sheet; "Re-run sheet" reopens the
// Builder seeded with that sheet's stack + panels for THIS character.

import { useState } from 'react';

import { Button, Card, Group, Stack } from '@civitai/blocks-react/ui';

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

function SheetRow({
  sheet,
  characterId,
  onOpenSheet,
  onRunSheet,
}: {
  sheet: SheetJob;
  characterId: string;
  onOpenSheet: (sheetId: string) => void;
  onRunSheet: (characterId: string, sheetId: string) => void;
}) {
  const outputs = sheet.panels.flatMap((p) =>
    p.outputs[0] ? [{ url: p.outputs[0], label: p.label }] : [],
  );
  const doneCount = sheet.panels.filter((p) => p.outputs.length > 0).length;

  return (
    <Card
      className="css-char-card"
      data-testid="char-view-sheet"
      onClick={() => onOpenSheet(sheet.id)}
    >
      <Stack gap="sm">
        <div style={{ minWidth: 0 }}>
          <div className="css-char-name">{sheet.name}</div>
          <div style={{ fontSize: 13, opacity: 0.7 }}>
            {new Date(sheet.createdAt).toLocaleDateString()} · {doneCount}/
            {sheet.panels.length} panels generated
          </div>
        </div>

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

        <Group justify="flex-end">
          <Button
            size="sm"
            variant="light"
            data-testid="char-view-run"
            onClick={(e) => {
              e.stopPropagation();
              onRunSheet(characterId, sheet.id);
            }}
          >
            Re-run sheet
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
  const [detailsOpen, setDetailsOpen] = useState(false);
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

  const hasDetails = Boolean(character.description) || character.traits.length > 0;

  return (
    <Stack gap="md">
      <Card>
        <Stack gap="sm">
          <Group justify="space-between" align="flex-start" wrap={false}>
            <div style={{ display: 'flex', gap: 14, minWidth: 0, alignItems: 'center' }}>
              {character.referenceImage && (
                <img
                  src={character.referenceImage.url}
                  alt=""
                  width={72}
                  height={72}
                  style={{ borderRadius: 10, objectFit: 'cover', flexShrink: 0 }}
                />
              )}
              <h2 style={{ margin: 0, fontSize: 22 }}>{character.name}</h2>
            </div>
            <Button size="sm" variant="light" onClick={onEdit}>
              Edit
            </Button>
          </Group>

          <Group gap="sm" align="center">
            <Button data-testid="char-view-new-sheet" onClick={onNewSheet}>
              New sheet
            </Button>
            {hasDetails && (
              <Button
                size="sm"
                variant="subtle"
                aria-expanded={detailsOpen}
                data-testid="char-view-details-toggle"
                onClick={() => setDetailsOpen((v) => !v)}
              >
                {detailsOpen ? 'Hide details' : 'View details'}
              </Button>
            )}
          </Group>

          {detailsOpen && hasDetails && (
            <Stack gap="xs" data-testid="char-view-details">
              {character.description && (
                <p style={{ margin: 0, opacity: 0.85, overflowWrap: 'anywhere' }}>
                  {character.description}
                </p>
              )}
              {character.traits.length > 0 && (
                <p style={{ margin: 0, fontSize: 14 }}>
                  <strong>Traits:</strong> {character.traits.join(', ')}
                </p>
              )}
            </Stack>
          )}
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
            characterId={character.id}
            onOpenSheet={onOpenSheet}
            onRunSheet={onRunSheet}
          />
        ))
      )}
    </Stack>
  );
}
