// Shared Sheet — what a share link (`share/<key>`) opens, for any viewer
// (HQ app_blocks_sdk_j1gc). It reads the sheet's record from the shared
// `shared_sheets` collection and resolves every panel image ID through
// `useGatedImages()`, so the HOST clamps each image to THIS viewer's content
// level. 🔴 Image URLs come only from that gated reply, never from the record
// (see sheet/shared-sheet.ts).

import { useEffect, useState } from 'react';

import { useGatedImages, type BlockGatedImage } from '@civitai/blocks-react';
import { Alert, Button, Card, Group, Loader, Stack } from '@civitai/blocks-react/ui';

import { useDocumentStorage } from '../sheet/doc-storage.js';
import { loadSharedSheet, type SharedSheetDoc } from '../sheet/shared-sheet.js';

interface SharedSheetViewProps {
  shareKey: string;
  /** Back to this app's gallery. */
  onGallery: () => void;
}

type LoadState =
  | { kind: 'loading' }
  | { kind: 'missing' }
  | { kind: 'error' }
  | { kind: 'ready'; doc: SharedSheetDoc; images: Map<number, BlockGatedImage> };

export function SharedSheetView({ shareKey, onGallery }: SharedSheetViewProps) {
  const docs = useDocumentStorage();
  const { getImages } = useGatedImages();
  const [state, setState] = useState<LoadState>({ kind: 'loading' });

  useEffect(() => {
    if (!docs) return;
    let live = true;
    setState({ kind: 'loading' });
    (async () => {
      try {
        const doc = await loadSharedSheet(docs, shareKey);
        if (!live) return;
        if (!doc) {
          setState({ kind: 'missing' });
          return;
        }
        const ids = doc.panels.map((p) => p.imageId);
        const gated = ids.length > 0 ? await getImages(ids) : [];
        if (!live) return;
        setState({ kind: 'ready', doc, images: new Map(gated.map((g) => [g.imageId, g])) });
      } catch {
        if (live) setState({ kind: 'error' });
      }
    })();
    return () => {
      live = false;
    };
    // getImages is a fresh function each render; the record and key decide the load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docs, shareKey]);

  const back = (
    <Button variant="subtle" onClick={onGallery} style={{ alignSelf: 'flex-start' }} data-testid="ss-gallery">
      ← Gallery
    </Button>
  );

  if (state.kind === 'loading') {
    return (
      <Card>
        <Group gap="sm" align="center">
          <Loader size="sm" />
          <span style={{ fontSize: 14 }}>Loading the shared sheet…</span>
        </Group>
      </Card>
    );
  }
  if (state.kind === 'missing' || state.kind === 'error') {
    return (
      <Stack gap="md">
        {back}
        <Alert color={state.kind === 'error' ? 'error' : 'info'} data-testid="ss-unavailable">
          {state.kind === 'error'
            ? 'Couldn’t load this shared sheet. Try again in a moment.'
            : 'This shared sheet isn’t available any more.'}
        </Alert>
      </Stack>
    );
  }

  const { doc, images } = state;
  return (
    <Stack gap="md">
      {back}
      <Card>
        <Stack gap={4}>
          <h2 style={{ margin: 0, fontSize: 20 }} data-testid="ss-sheet-name">
            {doc.sheetName}
          </h2>
          <div style={{ fontSize: 14, opacity: 0.8 }}>
            {doc.characterName} · shared sheet · {doc.panels.length} panel
            {doc.panels.length === 1 ? '' : 's'}
          </div>
        </Stack>
      </Card>
      <div className="css-panel-grid">
        {doc.panels.map((p, i) => {
          const g = images.get(p.imageId);
          return (
            <Card key={`${p.imageId}-${i}`} padding="sm">
              <Stack gap="sm">
                <strong style={{ fontSize: 14 }}>{p.label}</strong>
                {g && g.status === 'visible' ? (
                  <img
                    src={g.url}
                    alt={p.label}
                    {...(g.width && g.height ? { width: g.width, height: g.height } : {})}
                    style={{ width: '100%', height: 'auto', borderRadius: 6, display: 'block' }}
                  />
                ) : (
                  <div
                    data-testid="ss-panel-hidden"
                    role="note"
                    style={{
                      aspectRatio: '1 / 1',
                      borderRadius: 6,
                      background: 'var(--civitai-color-surface-2)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      textAlign: 'center',
                      padding: 12,
                      color: 'var(--civitai-color-text-dimmed)',
                      fontSize: 13,
                    }}
                  >
                    {g ? 'This image can’t be shown to you here.' : 'This image is no longer available.'}
                  </div>
                )}
              </Stack>
            </Card>
          );
        })}
      </div>
    </Stack>
  );
}
