// Character Sheet Studio — app shell.
//
// Four tabs: Characters → Stacks → Sheet Builder → Sheets. The library hook
// sits at the top so every screen shares one hydrated store. Anonymous viewers
// can browse everything; each screen gates its own spend behind sign-in +
// consent.

import { useRef, useState } from 'react';

import { useBlockContext, useBlockResize } from '@civitai/blocks-react';
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
  const library = useSheetLibrary();

  const rootRef = useRef<HTMLDivElement>(null);
  useBlockResize(rootRef);

  // TEMPORARY screenshot rig — reverted after screenshots are captured.
  const [tab, setTab] = useState<Tab>(() => {
    const t = new URLSearchParams(window.location.search).get('tab');
    return t === 'stacks' || t === 'builder' || t === 'sheets' ? t : 'characters';
  });
  const [openSheetId, setOpenSheetId] = useState<string | null>(null);
  const [preselectedCharacterId, setPreselectedCharacterId] = useState<string | undefined>(
    undefined,
  );

  const anon = ready && !viewer;

  const goToBuilder = (characterId?: string) => {
    setPreselectedCharacterId(characterId);
    setOpenSheetId(null);
    setTab('builder');
  };

  const openSheet = (sheetId: string) => {
    setOpenSheetId(sheetId);
    setTab('sheets');
  };

  return (
    <div
      ref={rootRef}
      data-theme={theme}
      style={{ maxWidth: 960, margin: '0 auto', padding: 16 }}
    >
      <Stack gap="md">
        <Group justify="space-between" align="center">
          <h1 style={{ margin: 0, fontSize: 22 }}>Character Sheet Studio</h1>
          <SegmentedControl
            value={tab}
            onChange={(v) => {
              setTab(v as Tab);
              if (v !== 'sheets') setOpenSheetId(null);
            }}
            data={TABS}
          />
        </Group>

        {anon && (
          <Alert color="info">
            You’re browsing as a guest — sign in when you’re ready to generate. Your
            characters, stacks, and sheets are stored in this browser either way.
          </Alert>
        )}

        {tab === 'characters' && (
          <Characters library={library} onBuildSheet={goToBuilder} />
        )}
        {tab === 'stacks' && <Stacks library={library} />}
        {tab === 'builder' && (
          <SheetBuilder
            library={library}
            preselectedCharacterId={preselectedCharacterId ?? null}
            onOpenSheet={openSheet}
            onCreateStack={() => setTab('stacks')}
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
              onBuild={() => goToBuilder()}
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
}: {
  library: ReturnType<typeof useSheetLibrary>;
  onOpen: (id: string) => void;
  onBuild: () => void;
}) {
  if (!library.ready) {
    return (
      <Card>
        <p style={{ margin: 0, opacity: 0.75 }}>Loading…</p>
      </Card>
    );
  }
  if (library.sheets.length === 0) {
    return (
      <Card>
        <Stack gap="sm">
          <p style={{ margin: 0, opacity: 0.75 }}>
            No sheets yet. Build one from a character + stack and it’ll appear here —
            batches resume automatically if you leave mid-run.
          </p>
          <div>
            <Button onClick={onBuild}>Build a sheet</Button>
          </div>
        </Stack>
      </Card>
    );
  }
  const sorted = [...library.sheets].sort((a, b) =>
    b.updatedAt.localeCompare(a.updatedAt),
  );
  return (
    <Stack gap="sm">
      {sorted.map((sheet) => {
        const done = sheet.panels.filter((p) => p.status === 'done').length;
        const character = library.characters.find((c) => c.id === sheet.characterId);
        return (
          <Card key={sheet.id} padding="sm">
            <Group justify="space-between" align="center">
              <Stack gap={2}>
                <strong style={{ fontSize: 15 }}>{sheet.name}</strong>
                <span style={{ fontSize: 13, opacity: 0.7 }}>
                  {character?.name ?? 'Unknown character'} · {done}/{sheet.panels.length}{' '}
                  panels
                </span>
              </Stack>
              <Group gap="sm" align="center">
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
                  {sheet.status}
                </Badge>
                <Button size="sm" variant="subtle" onClick={() => onOpen(sheet.id)}>
                  Open
                </Button>
              </Group>
            </Group>
          </Card>
        );
      })}
    </Stack>
  );
}
