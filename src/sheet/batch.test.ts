import { describe, expect, it } from 'vitest';

import type { SheetPanel } from './types.js';
import {
  IDEMPOTENCY_KEY_PATTERN,
  idempotencyKeyFor,
  nextPanelToSubmit,
  resolvePanelSeed,
  resumablePanels,
} from './batch.js';

const panel = (over: Partial<SheetPanel> = {}): SheetPanel => ({
  id: 'panel_1',
  kind: 'front',
  label: 'Front view',
  promptModifier: 'front view',
  seed: 1,
  status: 'queued',
  outputs: [],
  submitNonce: 0,
  ...over,
});

describe('idempotencyKeyFor', () => {
  it('is stable across calls (retry-safe) and differs per sheet, panel, nonce', () => {
    expect(idempotencyKeyFor('sheet_abc', 'panel_1')).toBe(
      idempotencyKeyFor('sheet_abc', 'panel_1'),
    );
    expect(idempotencyKeyFor('sheet_abc', 'panel_1', 2)).toBe(
      idempotencyKeyFor('sheet_abc', 'panel_1', 2),
    );
    expect(idempotencyKeyFor('s', 'p1')).not.toBe(idempotencyKeyFor('s', 'p2'));
    expect(idempotencyKeyFor('s', 'p1')).not.toBe(idempotencyKeyFor('s2', 'p1'));
    expect(idempotencyKeyFor('s', 'p1', 0)).not.toBe(idempotencyKeyFor('s', 'p1', 1));
  });

  it('satisfies the live host pattern for REAL ids (UUIDs — the naive join is 75 chars)', () => {
    // The production host 400s `blocks.submitWorkflow` when the key doesn't
    // match /^[A-Za-z0-9_-]{1,64}$/. Sheet/panel ids are crypto.randomUUID()
    // (36 chars each), so any literal join breaks the 64-char cap — the key
    // must be a bounded hash. (The earlier test used short fake ids and let
    // exactly this bug ship.)
    const sheetId = '550e8400-e29b-41d4-a716-446655440000';
    const panelId = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
    expect(`${sheetId}-${panelId}-0`).not.toMatch(IDEMPOTENCY_KEY_PATTERN);
    for (const nonce of [0, 1, 12]) {
      const key = idempotencyKeyFor(sheetId, panelId, nonce);
      expect(key).toMatch(IDEMPOTENCY_KEY_PATTERN);
      expect(key.length).toBeLessThanOrEqual(64);
    }
    // Distinct UUIDs → distinct keys (no accidental cross-panel collapse).
    expect(idempotencyKeyFor(sheetId, panelId)).not.toBe(
      idempotencyKeyFor(sheetId, '00000000-0000-4000-8000-000000000000'),
    );
  });
});

describe('resolvePanelSeed', () => {
  it('locked: base + index, deterministic', () => {
    expect(resolvePanelSeed(1000, 0, 'locked')).toBe(1000);
    expect(resolvePanelSeed(1000, 3, 'locked')).toBe(1003);
    expect(resolvePanelSeed(1000, 3, 'locked')).toBe(resolvePanelSeed(1000, 3, 'locked'));
  });
  it('locked: stays inside the 31-bit range', () => {
    expect(resolvePanelSeed(0x7fffffff - 1, 5, 'locked')).toBeLessThan(0x7fffffff);
  });
  it('varied: random 31-bit ints', () => {
    const a = resolvePanelSeed(1000, 0, 'varied');
    const b = resolvePanelSeed(1000, 0, 'varied');
    expect(a).toBeGreaterThanOrEqual(0);
    expect(a).toBeLessThan(0x7fffffff);
    expect(b).toBeGreaterThanOrEqual(0);
    // (astronomically unlikely to collide — not asserting inequality)
  });
});

describe('nextPanelToSubmit', () => {
  it('returns the first queued panel without a workflowId', () => {
    const panels = [
      panel({ id: 'p1', status: 'done', workflowId: 'wf_1' }),
      panel({ id: 'p2', status: 'queued', workflowId: 'wf_2' }),
      panel({ id: 'p3', status: 'queued' }),
    ];
    expect(nextPanelToSubmit(panels)?.id).toBe('p3');
  });
  it('returns null when nothing is left to submit', () => {
    expect(nextPanelToSubmit([panel({ status: 'done', workflowId: 'wf' })])).toBeNull();
    expect(nextPanelToSubmit([])).toBeNull();
  });
});

describe('resumablePanels', () => {
  it('returns submitted-but-unfinished panels', () => {
    const panels = [
      panel({ id: 'p1', status: 'running', workflowId: 'wf_1' }),
      panel({ id: 'p2', status: 'queued', workflowId: 'wf_2' }),
      panel({ id: 'p3', status: 'done', workflowId: 'wf_3' }),
      panel({ id: 'p4', status: 'failed', workflowId: 'wf_4' }),
      panel({ id: 'p5', status: 'queued' }),
    ];
    expect(resumablePanels(panels).map((p) => p.id)).toEqual(['p1', 'p2']);
  });
});
