// Character Sheet Studio — app shell.
//
// The host owns the page history, so the four sections and their detail
// screens are routes below the app root rather than local tab state:
// Characters, Stacks, Sheet Builder, Sheets, plus create/edit and sheet
// detail pages. That is what lets Android/browser Back move within the app
// instead of leaving it. The library hook sits at the top so every page
// shares one hydrated store. Anonymous viewers can browse everything; each
// screen gates its own spend behind sign-in + consent.

import { useEffect, useRef, useState } from 'react';

import { useBlockContext, useBlockResize, useRequestSignIn } from '@civitai/blocks-react';
import {
  Alert,
  Badge,
  Button,
  Card,
  Group,
  Stack,
  injectBlocksStyles,
} from '@civitai/blocks-react/ui';

import { useSheetLibrary } from './sheet/useSheetLibrary.js';
import { SHEET_STATUS_LABEL } from './sheet/types.js';
import { Characters } from './screens/Characters.js';
import { Stacks } from './screens/Stacks.js';
import { SheetBuilder } from './screens/SheetBuilder.js';
import { SheetView } from './screens/SheetView.js';
import {
  builderRoute,
  characterCreateRoute,
  characterEditRoute,
  parseAppRoute,
  sheetRoute,
  sheetsRoute,
  stackCreateRoute,
  stackEditRoute,
  useAppRoute,
  type AppRoute,
} from './platform/route.js';

// Inject the W6 component pack's stylesheet at module init (before first paint)
// to avoid the documented one-frame FOUC. Idempotent.
injectBlocksStyles();

type NavSection = 'characters' | 'stacks' | 'builder' | 'sheets';

const NAV_ITEMS: Array<{ section: NavSection; label: string; route: string }> = [
  { section: 'characters', label: 'Characters', route: 'characters' },
  { section: 'stacks', label: 'Stacks', route: 'stacks' },
  { section: 'builder', label: 'Sheet Builder', route: 'builder' },
  { section: 'sheets', label: 'Sheets', route: 'sheets' },
];

function navSectionForRoute(route: AppRoute): NavSection {
  switch (route.name) {
    case 'characters':
    case 'character-create':
    case 'character-edit':
      return 'characters';
    case 'stacks':
    case 'stack-create':
    case 'stack-edit':
      return 'stacks';
    case 'builder':
      return 'builder';
    case 'sheets':
    case 'sheet':
      return 'sheets';
  }
}

export function App() {
  const { ready, viewer, theme } = useBlockContext();
  const { requestSignIn } = useRequestSignIn();
  const library = useSheetLibrary();
  const { subPath, navigateTo } = useAppRoute();
  const route = parseAppRoute(subPath);
  const activeNav = navSectionForRoute(route);

  const rootRef = useRef<HTMLDivElement>(null);
  useBlockResize(rootRef);

  // On narrow screens the section nav becomes a horizontal strip. Keep the
  // current page's item in view when a route change selects an off-screen
  // section (for example, opening a sheet from a deep link).
  useEffect(() => {
    const centerActiveNav = () => {
      const nav = rootRef.current?.querySelector<HTMLElement>('.css-sidenav');
      const active = nav?.querySelector<HTMLElement>('[aria-current="page"]');
      if (!nav || !active) return;
      nav.scrollLeft = Math.max(
        0,
        active.offsetLeft - (nav.clientWidth - active.clientWidth) / 2,
      );
    };
    centerActiveNav();
    window.addEventListener('resize', centerActiveNav);
    return () => window.removeEventListener('resize', centerActiveNav);
  }, [activeNav, route.name]);

  // Return-trip state: when the Builder sends the viewer off to create a
  // character/stack, saving there lands them back in the Builder with the
  // new entry selected, instead of stranded on a list page.
  const [returnToBuilder, setReturnToBuilder] = useState<'character' | 'stack' | null>(null);
  const [builderCharacterId, setBuilderCharacterId] = useState<string | undefined>(undefined);
  const [builderStackId, setBuilderStackId] = useState<string | undefined>(undefined);

  const anon = ready && !viewer;

  const goToBuilder = (characterId?: string) => {
    setBuilderCharacterId(characterId);
    navigateTo(builderRoute(characterId));
  };

  const viewSheetsFor = (characterId: string) => {
    navigateTo(sheetsRoute(characterId));
  };

  const openSheet = (sheetId: string) => {
    navigateTo(sheetRoute(sheetId));
  };

  const characterEditor =
    route.name === 'character-create'
      ? { mode: 'create' as const }
      : route.name === 'character-edit'
        ? { mode: 'edit' as const, id: route.characterId }
        : null;

  const stackEditor =
    route.name === 'stack-create'
      ? { mode: 'create' as const }
      : route.name === 'stack-edit'
        ? { mode: 'edit' as const, id: route.stackId }
        : null;

  return (
    <div ref={rootRef} className="css-root css-shell" data-theme={theme}>
      <div className="css-layout">
        <nav className="css-sidenav" aria-label="App sections">
          {NAV_ITEMS.map((item) => (
            <button
              key={item.section}
              type="button"
              aria-current={activeNav === item.section ? 'page' : undefined}
              data-value={item.section}
              className="css-nav-item"
              onClick={() => navigateTo(item.route)}
            >
              {item.label}
            </button>
          ))}
          <div className="css-nav-spacer" />
          {anon && (
            <Button size="sm" variant="light" onClick={() => requestSignIn()} data-testid="se-sign-in">
              Sign in
            </Button>
          )}
        </nav>

        <main className="css-content">
          <Stack gap="md">
            {anon && (
              <Alert color="info">
                You’re browsing as a guest — sign in to generate. Anything you
                create as a guest lasts only for this session.
              </Alert>
            )}

            {(route.name === 'characters' ||
              route.name === 'character-create' ||
              route.name === 'character-edit') && (
              <Characters
                key={subPath || 'characters'}
                library={library}
                onBuildSheet={goToBuilder}
                onViewSheets={viewSheetsFor}
                initialEditor={characterEditor}
                onEditorOpened={(editor) =>
                  navigateTo(
                    editor.mode === 'create'
                      ? characterCreateRoute()
                      : characterEditRoute(editor.id),
                  )
                }
                onEditorClosed={() => navigateTo('characters')}
                onCreated={(id) => {
                  if (returnToBuilder !== 'character') {
                    navigateTo('characters');
                    return;
                  }
                  setReturnToBuilder(null);
                  goToBuilder(id);
                }}
                onEdited={() => navigateTo('characters')}
                onCreateCancelled={() => {
                  if (returnToBuilder === 'character') setReturnToBuilder(null);
                }}
              />
            )}

            {(route.name === 'stacks' ||
              route.name === 'stack-create' ||
              route.name === 'stack-edit') && (
              <Stacks
                key={subPath || 'stacks'}
                library={library}
                initialEditor={stackEditor}
                onEditorOpened={(editor) =>
                  navigateTo(
                    editor.mode === 'create'
                      ? stackCreateRoute()
                      : stackEditRoute(editor.id),
                  )
                }
                onEditorClosed={() => navigateTo('stacks')}
                onCreated={(id) => {
                  if (returnToBuilder !== 'stack') {
                    navigateTo('stacks');
                    return;
                  }
                  setReturnToBuilder(null);
                  setBuilderStackId(id);
                  navigateTo(builderRoute(builderCharacterId));
                }}
                onEdited={() => navigateTo('stacks')}
                onCreateCancelled={() => {
                  if (returnToBuilder === 'stack') setReturnToBuilder(null);
                }}
              />
            )}

            {route.name === 'builder' && (
              <SheetBuilder
                library={library}
                preselectedCharacterId={route.characterId ?? null}
                preselectedStackId={builderStackId ?? null}
                onOpenSheet={openSheet}
                onCreateStack={(characterId) => {
                  setReturnToBuilder('stack');
                  setBuilderCharacterId(characterId || undefined);
                  navigateTo(stackCreateRoute());
                }}
                onCreateCharacter={() => {
                  setReturnToBuilder('character');
                  navigateTo(characterCreateRoute());
                }}
              />
            )}

            {route.name === 'sheets' && (
              <SheetsList
                library={library}
                onOpen={openSheet}
                onBuild={(characterId) => goToBuilder(characterId)}
                filterCharacterId={route.characterId ?? null}
                onClearFilter={() => navigateTo(sheetsRoute())}
              />
            )}

            {route.name === 'sheet' && (
              <SheetView
                key={route.sheetId}
                library={library}
                sheetId={route.sheetId}
                onBack={() => navigateTo(sheetsRoute())}
              />
            )}
          </Stack>
        </main>
      </div>
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
