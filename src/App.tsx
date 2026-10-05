// Character Sheet Studio — app shell.
//
// Four tabs: Characters → Stacks → Sheet Builder → Sheets. The library hook
// sits at the top so every screen shares one hydrated store. Anonymous viewers
// can browse everything; each screen gates its own spend behind sign-in +
// consent.

import { useRef, useState } from 'react';

import { useBlockContext, useBlockResize, useRequestSignIn } from '@civitai/blocks-react';
import {
  Alert,
  Badge,
  Button,
  Card,
  Group,
  SegmentedControl,
  Stack,
  injectBlocksStyles,
} from '@civitai/blocks-react/ui';

import { useSheetLibrary } from './sheet/useSheetLibrary.js';
import { SHEET_STATUS_LABEL } from './sheet/types.js';
import { Characters } from './screens/Characters.js';
import { Stacks } from './screens/Stacks.js';
import { SheetBuilder } from './screens/SheetBuilder.js';
import { SheetView } from './screens/SheetView.js';

// Inject the W6 component pack's stylesheet at module init (before first paint)
// to avoid the documented one-frame FOUC. Idempotent.
injectBlocksStyles();

type Tab = 'characters' | 'stacks' | 'builder' | 'sheets';

const TABS: Array<{ value: Tab; label: string }> = [
  { value: 'characters', label: 'Characters' },
  { value: 'stacks', label: 'Stacks' },
  { value: 'builder', label: 'Sheet Builder' },
  { value: 'sheets', label: 'Sheets' },
];

export function App() {
  const { ready, viewer, theme } = useBlockContext();
  const { requestSignIn } = useRequestSignIn();
  const library = useSheetLibrary();

  const rootRef = useRef<HTMLDivElement>(null);
  useBlockResize(rootRef);

  // TEMPORARY screenshot rig — reverted after screenshots are captured.
  const [tab, setTab] = useState<Tab>(() => {
    const t = new URLSearchParams(window.location.search).get('tab');
    return t === 'stacks' || t === 'builder' || t === 'sheets' ? t : 'characters';
  });
  const [openSheetId, setOpenSheetId] = useState<string | null>(null);
  // When set, the Sheets tab lists only this character's sheets.
  const [sheetsCharFilter, setSheetsCharFilter] = useState<string | null>(null);
  const [preselectedCharacterId, setPreselectedCharacterId] = useState<string | undefined>(
    undefined,
  );
  // Return-trip state: when the Builder sends the viewer off to create a
  // character/stack, saving there lands them back in the Builder with the
  // new entry selected, instead of stranded on a list screen.
  const [charAutoCreate, setCharAutoCreate] = useState(false);
  const [stackAutoCreate, setStackAutoCreate] = useState(false);
  const [returnToBuilder, setReturnToBuilder] = useState<'character' | 'stack' | null>(null);
  const [builderStackId, setBuilderStackId] = useState<string | undefined>(undefined);

  const anon = ready && !viewer;

  const goToBuilder = (characterId?: string) => {
    setPreselectedCharacterId(characterId);
    setOpenSheetId(null);
    setTab('builder');
  };

  const viewSheetsFor = (characterId: string) => {
    setSheetsCharFilter(characterId);
    setOpenSheetId(null);
    setTab('sheets');
  };

  const openSheet = (sheetId: string) => {
    setOpenSheetId(sheetId);
    setTab('sheets');
  };

  return (
    <div ref={rootRef} className="css-root css-shell" data-theme={theme}>
      <Stack gap="md">
        <Group justify="space-between" align="center" wrap>
          <h1 style={{ margin: 0, fontSize: 22 }}>Character Sheet Studio</h1>
          <Group gap="sm" align="center" wrap style={{ minWidth: 0 }}>
            {anon && (
              <Button size="sm" variant="light" onClick={() => requestSignIn()} data-testid="se-sign-in">
                Sign in
              </Button>
            )}
            <div className="css-tabs-scroll">
            <SegmentedControl
              value={tab}
              onChange={(v) => {
                setTab(v as Tab);
                if (v !== 'sheets') setOpenSheetId(null);
                // Manual navigation resets the character drill-in — the
                // filter only exists as a target from a character card.
                setSheetsCharFilter(null);
              }}
              onClick={(e) => {
                // Clicking the ALREADY-active Sheets tab fires no onChange,
                // but the viewer means "back to the list" — exit the open
                // sheet / drill-in instead of doing nothing.
                if (tab !== 'sheets') return;
                const t = e.target as HTMLElement;
                const v =
                  t.closest?.('[data-value]')?.getAttribute('data-value') ??
                  t.closest?.('button, label')?.textContent?.trim().toLowerCase();
                if (v === 'sheets') {
                  setOpenSheetId(null);
                  setSheetsCharFilter(null);
                }
              }}
              data={TABS}
            />
            </div>
          </Group>
        </Group>

        {anon && (
          <Alert color="info">
            You’re browsing as a guest — sign in to generate. Anything you
            create as a guest lasts only for this session.
          </Alert>
        )}

        {tab === 'characters' && (
          <Characters
            library={library}
            onBuildSheet={goToBuilder}
            onViewSheets={viewSheetsFor}
            autoOpenCreate={charAutoCreate}
            onAutoOpenConsumed={() => setCharAutoCreate(false)}
            onCreated={(id) => {
              if (returnToBuilder !== 'character') return;
              setReturnToBuilder(null);
              goToBuilder(id);
            }}
            onCreateCancelled={() => {
              if (returnToBuilder === 'character') setReturnToBuilder(null);
            }}
          />
        )}
        {tab === 'stacks' && (
          <Stacks
            library={library}
            autoOpenCreate={stackAutoCreate}
            onAutoOpenConsumed={() => setStackAutoCreate(false)}
            onCreated={(id) => {
              if (returnToBuilder !== 'stack') return;
              setReturnToBuilder(null);
              setBuilderStackId(id);
              setTab('builder');
            }}
            onCreateCancelled={() => {
              if (returnToBuilder === 'stack') setReturnToBuilder(null);
            }}
          />
        )}
        {tab === 'builder' && (
          <SheetBuilder
            library={library}
            preselectedCharacterId={preselectedCharacterId ?? null}
            preselectedStackId={builderStackId ?? null}
            onOpenSheet={openSheet}
            onCreateStack={() => {
              setReturnToBuilder('stack');
              setStackAutoCreate(true);
              setTab('stacks');
            }}
            onCreateCharacter={() => {
              setReturnToBuilder('character');
              setCharAutoCreate(true);
              setTab('characters');
            }}
          />
        )}
        {tab === 'sheets' &&
          (openSheetId ? (
            <SheetView
              library={library}
              sheetId={openSheetId}
              onBack={() => setOpenSheetId(null)}
            />
          ) : (
            <SheetsList
              library={library}
              onOpen={openSheet}
              onBuild={(characterId) => goToBuilder(characterId)}
              filterCharacterId={sheetsCharFilter}
              onClearFilter={() => setSheetsCharFilter(null)}
            />
          ))}
      </Stack>
    </div>
  );
}

function SheetsList({
  library,
  onOpen,
  onBuild,
  filterCharacterId,
  onClearFilter,
}: {
  library: ReturnType<typeof useSheetLibrary>;
  onOpen: (id: string) => void;
  onBuild: (characterId?: string) => void;
  filterCharacterId: string | null;
  onClearFilter: () => void;
}) {
  if (!library.ready) {
    return (
      <Card>
        <p style={{ margin: 0, opacity: 0.75 }}>Loading…</p>
      </Card>
    );
  }
  const filterCharacter = filterCharacterId
    ? library.characters.find((c) => c.id === filterCharacterId)
    : undefined;
  const visible = filterCharacterId
    ? library.sheets.filter((s) => s.characterId === filterCharacterId)
    : library.sheets;

  const filterBanner = filterCharacterId ? (
    <Group justify="space-between" align="center">
      <span style={{ fontSize: 14 }}>
        Sheets for <strong>{filterCharacter?.name ?? 'Unknown character'}</strong>
      </span>
      <Button size="sm" variant="subtle" onClick={onClearFilter}>
        Show all
      </Button>
    </Group>
  ) : null;

  if (visible.length === 0) {
    return (
      <Stack gap="sm">
        {filterBanner}
        <Card>
          <Stack gap="sm">
            <p style={{ margin: 0, opacity: 0.75 }}>
              {filterCharacterId
                ? `No sheets for ${filterCharacter?.name ?? 'this character'} yet.`
                : 'No sheets yet. Build one from a character + stack and it’ll appear here — batches resume automatically if you leave mid-run.'}
            </p>
            <div>
              <Button onClick={() => onBuild(filterCharacterId ?? undefined)}>
                Build a sheet
              </Button>
            </div>
          </Stack>
        </Card>
      </Stack>
    );
  }
  const sorted = [...visible].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return (
    <Stack gap="sm">
      {filterBanner}
      <div className="css-grid-cards">
      {sorted.map((sheet) => {
        const done = sheet.panels.filter((p) => p.status === 'done').length;
        const character = library.characters.find((c) => c.id === sheet.characterId);
        const thumb = sheet.panels.find((p) => p.outputs[0])?.outputs[0];
        return (
          <Card key={sheet.id} padding="sm">
            <Group justify="space-between" align="center" wrap>
              <Group gap="sm" align="center" wrap={false} style={{ minWidth: 0 }}>
                {thumb ? (
                  <img
                    src={thumb}
                    alt=""
                    data-testid="sheet-card-thumb"
                    style={{
                      width: 64,
                      height: 64,
                      objectFit: 'cover',
                      borderRadius: 8,
                      flexShrink: 0,
                      display: 'block',
                    }}
                  />
                ) : (
                  <div
                    data-testid="sheet-card-thumb-placeholder"
                    style={{
                      width: 64,
                      height: 64,
                      borderRadius: 8,
                      background: 'var(--civitai-color-surface-2)',
                      flexShrink: 0,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      color: 'var(--civitai-color-text-dimmed)',
                      fontSize: 11,
                      textAlign: 'center',
                      padding: 4,
                    }}
                  >
                    No image
                  </div>
                )}
                <Stack gap={2}>
                  <strong style={{ fontSize: 15 }}>{sheet.name}</strong>
                  <span style={{ fontSize: 13, opacity: 0.7 }}>
                    {character?.name ?? 'Unknown character'} · {done}/{sheet.panels.length}{' '}
                    panels
                  </span>
                </Stack>
              </Group>
              <Group gap="sm" align="center" wrap>
                <Badge
                  color={
                    sheet.status === 'complete'
                      ? 'success'
                      : sheet.status === 'failed'
                        ? 'error'
                        : 'info'
                  }
                  variant="light"
                >
                  {SHEET_STATUS_LABEL[sheet.status]}
                </Badge>
                <Button size="sm" variant="subtle" onClick={() => onOpen(sheet.id)}>
                  Open
                </Button>
              </Group>
            </Group>
          </Card>
        );
      })}
      </div>
    </Stack>
  );
}
