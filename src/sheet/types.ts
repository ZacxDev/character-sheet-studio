/**
 * Character Sheet Studio — data model + storage key scheme.
 *
 * Everything the app persists lives in the host-mediated `useAppStorage` KV
 * store (see `./store.ts`). The store is namespaced per (block instance,
 * viewer) and budgeted per (app, viewer); rows are small on purpose — ids,
 * prompts and Civitai-hosted urls, never image bytes.
 *
 * Key scheme (versioned, Prompt Lab / Style Explorer convention):
 *   v1:char:<uuid>     one Character
 *   v1:stack:<uuid>    one ModelStack (checkpoint + LoRA combination)
 *   v1:sheet:<uuid>    one SheetJob (a batch of panels + their workflow ids)
 *   v1:settings        SheetSettings singleton
 *
 * Keys are constructed here, never from user input, so they stay far under
 * the host's 200-character key cap. Malformed rows are dropped by the
 * `normalize*` functions — storage is best-effort, the in-memory state is the
 * source of truth.
 */

export const STORAGE_VERSION = 'v1';

export const SETTINGS_KEY = `${STORAGE_VERSION}:settings`;

export const CHARACTER_PREFIX = `${STORAGE_VERSION}:char:`;
export const STACK_PREFIX = `${STORAGE_VERSION}:stack:`;
export const SHEET_PREFIX = `${STORAGE_VERSION}:sheet:`;

export function characterKey(id: string): string {
  return `${CHARACTER_PREFIX}${id}`;
}

export function stackKey(id: string): string {
  return `${STACK_PREFIX}${id}`;
}

export function sheetKey(id: string): string {
  return `${SHEET_PREFIX}${id}`;
}

/** Stable id for new records. Prefers `crypto.randomUUID`, falls back safely. */
export function newId(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  return `id-${Date.now().toString(36)}-${Math.floor(Math.random() * 2 ** 32).toString(36)}`;
}

function isoNow(): string {
  return new Date().toISOString();
}

// --- small guards ------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function asString(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

function asNonEmptyString(v: unknown): string | null {
  const s = asString(v);
  return s !== null && s.trim().length > 0 ? s : null;
}

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string');
}

function asNumber(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function asInt(v: unknown): number | null {
  const n = asNumber(v);
  return n !== null && Number.isInteger(n) ? n : null;
}

// --- Character ---------------------------------------------------------------

/** Civitai-hosted reference portrait, from `useImageUpload({ purpose: 'generationSource' })`. */
export interface CharacterRefImage {
  url: string;
  width: number;
  height: number;
}

export type SeedPolicy = 'locked' | 'varied';

export interface Character {
  id: string;
  name: string;
  description: string;
  traits: string[];
  /** Trigger words (usually from the character LoRA's trained words). */
  triggerWords: string[];
  negativePrompt: string;
  referenceImage?: CharacterRefImage;
  defaultStackId?: string;
  seedPolicy: SeedPolicy;
  createdAt: string;
  updatedAt: string;
}

function normalizeRefImage(v: unknown): CharacterRefImage | undefined {
  if (!isRecord(v)) return undefined;
  const url = asNonEmptyString(v.url);
  const width = asInt(v.width);
  const height = asInt(v.height);
  if (url === null || width === null || height === null) return undefined;
  return { url, width, height };
}

/** Returns `null` for anything that is not a salvageable Character. */
export function normalizeCharacter(v: unknown): Character | null {
  if (!isRecord(v)) return null;
  const id = asNonEmptyString(v.id);
  const name = asNonEmptyString(v.name);
  if (id === null || name === null) return null;
  const seedPolicy = v.seedPolicy === 'varied' ? 'varied' : 'locked';
  const refImage = normalizeRefImage(v.referenceImage);
  const defaultStackId = asNonEmptyString(v.defaultStackId) ?? undefined;
  return {
    id,
    name,
    description: asString(v.description) ?? '',
    traits: asStringArray(v.traits),
    triggerWords: asStringArray(v.triggerWords),
    negativePrompt: asString(v.negativePrompt) ?? '',
    ...(refImage ? { referenceImage: refImage } : {}),
    ...(defaultStackId ? { defaultStackId } : {}),
    seedPolicy,
    createdAt: asString(v.createdAt) ?? isoNow(),
    updatedAt: asString(v.updatedAt) ?? isoNow(),
  };
}

export function newCharacter(init: {
  name: string;
  description?: string;
  traits?: string[];
  triggerWords?: string[];
  negativePrompt?: string;
  referenceImage?: CharacterRefImage;
  defaultStackId?: string;
  seedPolicy?: SeedPolicy;
}): Character {
  const now = isoNow();
  return {
    id: newId(),
    name: init.name,
    description: init.description ?? '',
    traits: init.traits ?? [],
    triggerWords: init.triggerWords ?? [],
    negativePrompt: init.negativePrompt ?? '',
    ...(init.referenceImage ? { referenceImage: init.referenceImage } : {}),
    ...(init.defaultStackId ? { defaultStackId: init.defaultStackId } : {}),
    seedPolicy: init.seedPolicy ?? 'locked',
    createdAt: now,
    updatedAt: now,
  };
}

// --- ModelStack ----------------------------------------------------------------
// A reusable checkpoint + LoRA combination. Version ids are rehydrated through
// `useGenerationResources().fetch(...)` (trigger words, recommended strengths,
// clipSkip) without re-opening the pickers.

export interface StackCheckpoint {
  modelId: number;
  modelVersionId: number;
  baseModel: string;
  name?: string;
}

export interface StackLora {
  modelVersionId: number;
  /** Server contract: [-1, 2]. Clamped by the normalizer. */
  strength: number;
  triggerWords: string[];
  name?: string;
}

export interface ModelStack {
  id: string;
  name: string;
  checkpoint: StackCheckpoint;
  /** Max 5 — the server rejects more. The normalizer drops extras. */
  loras: StackLora[];
  notes: string;
  createdAt: string;
  updatedAt: string;
}

export const MAX_LORAS_PER_STACK = 5;
export const MIN_LORA_STRENGTH = -1;
export const MAX_LORA_STRENGTH = 2;

export function clampLoraStrength(s: number): number {
  if (!Number.isFinite(s)) return 1;
  return Math.min(MAX_LORA_STRENGTH, Math.max(MIN_LORA_STRENGTH, s));
}

function normalizeStackLora(v: unknown): StackLora | null {
  if (!isRecord(v)) return null;
  const modelVersionId = asInt(v.modelVersionId);
  if (modelVersionId === null || modelVersionId <= 0) return null;
  const name = asNonEmptyString(v.name) ?? undefined;
  return {
    modelVersionId,
    strength: clampLoraStrength(asNumber(v.strength) ?? 1),
    triggerWords: asStringArray(v.triggerWords),
    ...(name ? { name } : {}),
  };
}

/** Returns `null` for anything that is not a salvageable ModelStack. */
export function normalizeModelStack(v: unknown): ModelStack | null {
  if (!isRecord(v)) return null;
  const id = asNonEmptyString(v.id);
  const name = asNonEmptyString(v.name);
  if (id === null || name === null) return null;
  if (!isRecord(v.checkpoint)) return null;
  const modelId = asInt(v.checkpoint.modelId);
  const modelVersionId = asInt(v.checkpoint.modelVersionId);
  const baseModel = asNonEmptyString(v.checkpoint.baseModel);
  if (modelId === null || modelVersionId === null || baseModel === null) return null;
  const loras: StackLora[] = [];
  if (Array.isArray(v.loras)) {
    for (const l of v.loras) {
      const n = normalizeStackLora(l);
      if (n) loras.push(n);
      if (loras.length >= MAX_LORAS_PER_STACK) break;
    }
  }
  const cpName = asNonEmptyString(v.checkpoint.name) ?? undefined;
  return {
    id,
    name,
    checkpoint: {
      modelId,
      modelVersionId,
      baseModel,
      ...(cpName ? { name: cpName } : {}),
    },
    loras,
    notes: asString(v.notes) ?? '',
    createdAt: asString(v.createdAt) ?? isoNow(),
    updatedAt: asString(v.updatedAt) ?? isoNow(),
  };
}

export function newModelStack(init: {
  name: string;
  checkpoint: StackCheckpoint;
  loras?: StackLora[];
  notes?: string;
}): ModelStack {
  const now = isoNow();
  return {
    id: newId(),
    name: init.name,
    checkpoint: init.checkpoint,
    loras: (init.loras ?? [])
      .slice(0, MAX_LORAS_PER_STACK)
      .map((l) => ({ ...l, strength: clampLoraStrength(l.strength) })),
    notes: init.notes ?? '',
    createdAt: now,
    updatedAt: now,
  };
}

// --- Sheet panels --------------------------------------------------------------

export const PANEL_KINDS = [
  'front',
  'side',
  'back',
  'three-quarter',
  'expression',
  'scenario',
] as const;

export type PanelKind = (typeof PANEL_KINDS)[number];

export function isPanelKind(v: unknown): v is PanelKind {
  return (
    typeof v === 'string' && (PANEL_KINDS as readonly string[]).includes(v)
  );
}

export const PANEL_LABELS: Record<PanelKind, string> = {
  front: 'Front view',
  side: 'Side view',
  back: 'Back view',
  'three-quarter': 'Three-quarter view',
  expression: 'Expression',
  scenario: 'Scenario',
};

export type PanelStatus = 'queued' | 'running' | 'done' | 'failed' | 'canceled';

export function isPanelStatus(v: unknown): v is PanelStatus {
  return (
    v === 'queued' ||
    v === 'running' ||
    v === 'done' ||
    v === 'failed' ||
    v === 'canceled'
  );
}

export function isTerminalPanelStatus(s: PanelStatus): boolean {
  return s === 'done' || s === 'failed' || s === 'canceled';
}

/**
 * The deterministic half of a panel prompt. The generation engine (a later
 * phase) prepends the character description + LoRA trigger words; this
 * modifier only describes the framing, so prompt composition stays a pure,
 * unit-testable function.
 */
export interface PanelSpec {
  kind: PanelKind;
  label: string;
  promptModifier: string;
}

const TURNAROUND_SPECS: PanelSpec[] = [
  {
    kind: 'front',
    label: 'Front view',
    promptModifier:
      'character reference sheet, front view, facing the viewer, neutral expression, full body, plain background',
  },
  {
    kind: 'side',
    label: 'Side view',
    promptModifier:
      'character reference sheet, side profile view, neutral expression, full body, plain background',
  },
  {
    kind: 'back',
    label: 'Back view',
    promptModifier:
      'character reference sheet, back view, facing away, neutral expression, full body, plain background',
  },
  {
    kind: 'three-quarter',
    label: 'Three-quarter view',
    promptModifier:
      'character reference sheet, three-quarter view, neutral expression, full body, plain background',
  },
];

/** The default sheet: turnaround + 2 expressions + 2 scenarios. */
export function defaultPanelSpecs(): PanelSpec[] {
  return [
    ...TURNAROUND_SPECS,
    {
      kind: 'expression',
      label: 'Expression 1',
      promptModifier:
        'character portrait, expressive face, happy expression, head and shoulders, plain background',
    },
    {
      kind: 'expression',
      label: 'Expression 2',
      promptModifier:
        'character portrait, expressive face, determined expression, head and shoulders, plain background',
    },
    {
      kind: 'scenario',
      label: 'Scenario 1',
      promptModifier:
        'character in a detailed environment, cinematic lighting, full scene',
    },
    {
      kind: 'scenario',
      label: 'Scenario 2',
      promptModifier:
        'character in action pose, dynamic composition, detailed environment',
    },
  ];
}

export interface SheetPanel extends PanelSpec {
  id: string;
  /** Per-panel seed: sheet seed + panel index offset (locked) or random (varied). */
  seed: number;
  /** Set once submitted — the resumability anchor. */
  workflowId?: string;
  status: PanelStatus;
  outputs: string[];
  /** App-owned failure code, never raw server prose. */
  errorCode?: string;
  /**
   * Incremented on every (re)submit. The idempotency key is
   * `sheetId-panelId-submitNonce` (dashes — the host rejects anything outside
   * /^[A-Za-z0-9_-]{1,64}$/): a retry after a lost response reuses the
   * key (same nonce → the host collapses it to one charge), while a
   * regenerate bumps the nonce so the orchestrator treats it as a new
   * logical submit.
   */
  submitNonce: number;
}

function normalizeSheetPanel(v: unknown): SheetPanel | null {
  if (!isRecord(v)) return null;
  const id = asNonEmptyString(v.id);
  if (id === null || !isPanelKind(v.kind)) return null;
  const seed = asInt(v.seed);
  if (seed === null) return null;
  const status = isPanelStatus(v.status) ? v.status : 'queued';
  const workflowId = asNonEmptyString(v.workflowId) ?? undefined;
  const errorCode = asNonEmptyString(v.errorCode) ?? undefined;
  return {
    id,
    kind: v.kind,
    label: asNonEmptyString(v.label) ?? PANEL_LABELS[v.kind],
    promptModifier: asString(v.promptModifier) ?? '',
    seed,
    ...(workflowId ? { workflowId } : {}),
    status,
    outputs: asStringArray(v.outputs),
    ...(errorCode ? { errorCode } : {}),
    submitNonce: asInt(v.submitNonce) ?? 0,
  };
}

// --- SheetJob ------------------------------------------------------------------

export type SheetStatus = 'draft' | 'running' | 'paused' | 'complete' | 'failed';

export function isSheetStatus(v: unknown): v is SheetStatus {
  return (
    v === 'draft' ||
    v === 'running' ||
    v === 'paused' ||
    v === 'complete' ||
    v === 'failed'
  );
}

export interface SheetJob {
  id: string;
  name: string;
  characterId: string;
  stackId: string;
  /** Base seed; panels derive seed + index when the character locks seeds. */
  seed: number;
  /** Preferred Buzz pool for the batch ('auto' = host default). */
  account: 'auto' | 'blue' | 'green' | 'yellow';
  /** Whether panels generate img2img from the character's reference portrait. */
  useReference: boolean;
  status: SheetStatus;
  panels: SheetPanel[];
  createdAt: string;
  updatedAt: string;
}

/** Returns `null` for anything that is not a salvageable SheetJob. */
export function normalizeSheetJob(v: unknown): SheetJob | null {
  if (!isRecord(v)) return null;
  const id = asNonEmptyString(v.id);
  const characterId = asNonEmptyString(v.characterId);
  const stackId = asNonEmptyString(v.stackId);
  const seed = asInt(v.seed);
  if (id === null || characterId === null || stackId === null || seed === null)
    return null;
  const panels: SheetPanel[] = [];
  if (Array.isArray(v.panels)) {
    for (const p of v.panels) {
      const n = normalizeSheetPanel(p);
      if (n) panels.push(n);
    }
  }
  if (panels.length === 0) return null;
  const account = v.account === 'blue' || v.account === 'green' || v.account === 'yellow' ? v.account : 'auto';
  return {
    id,
    name: asNonEmptyString(v.name) ?? 'Untitled sheet',
    characterId,
    stackId,
    seed,
    account,
    useReference: v.useReference === true,
    status: isSheetStatus(v.status) ? v.status : 'draft',
    panels,
    createdAt: asString(v.createdAt) ?? isoNow(),
    updatedAt: asString(v.updatedAt) ?? isoNow(),
  };
}

export function newSheetJob(init: {
  name: string;
  characterId: string;
  stackId: string;
  seed: number;
  specs?: PanelSpec[];
  account?: 'auto' | 'blue' | 'green' | 'yellow';
  useReference?: boolean;
}): SheetJob {
  const now = isoNow();
  const specs = init.specs ?? defaultPanelSpecs();
  return {
    id: newId(),
    name: init.name,
    characterId: init.characterId,
    stackId: init.stackId,
    seed: init.seed,
    account: init.account ?? 'auto',
    useReference: init.useReference ?? false,
    status: 'draft',
    panels: specs.map((s, i) => ({
      ...s,
      id: newId(),
      seed: init.seed + i,
      status: 'queued' as PanelStatus,
      outputs: [],
      submitNonce: 0,
    })),
    createdAt: now,
    updatedAt: now,
  };
}

export interface SheetProgress {
  done: number;
  total: number;
}

export function sheetProgress(sheet: SheetJob): SheetProgress {
  return {
    done: sheet.panels.filter((p) => p.status === 'done').length,
    total: sheet.panels.length,
  };
}

/**
 * A sheet is resumable when it has panels that never reached a terminal
 * state — those carry (or are waiting for) a workflowId the batch runner can
 * re-attach to via the workflow query route.
 */
export function isSheetResumable(sheet: SheetJob): boolean {
  return sheet.panels.some((p) => !isTerminalPanelStatus(p.status));
}

// --- Settings ------------------------------------------------------------------

export interface SheetSettings {
  imageWidth: number;
  imageHeight: number;
  /** Server contract: 1–4. */
  quantity: 1 | 2 | 3 | 4;
  defaultPanels: PanelKind[];
}

export const DEFAULT_SETTINGS: SheetSettings = {
  imageWidth: 1024,
  imageHeight: 1024,
  quantity: 1,
  defaultPanels: ['front', 'side', 'back', 'three-quarter'],
};

/** Always returns valid settings — storage holds a best-effort copy. */
export function normalizeSettings(v: unknown): SheetSettings {
  if (!isRecord(v)) return { ...DEFAULT_SETTINGS };
  const width = asInt(v.imageWidth);
  const height = asInt(v.imageHeight);
  const quantity = asInt(v.quantity);
  const panels = Array.isArray(v.defaultPanels)
    ? v.defaultPanels.filter(isPanelKind)
    : [];
  return {
    imageWidth:
      width !== null && width >= 64 && width <= 2048
        ? width
        : DEFAULT_SETTINGS.imageWidth,
    imageHeight:
      height !== null && height >= 64 && height <= 2048
        ? height
        : DEFAULT_SETTINGS.imageHeight,
    quantity:
      quantity === 1 || quantity === 2 || quantity === 3 || quantity === 4
        ? quantity
        : DEFAULT_SETTINGS.quantity,
    defaultPanels:
      panels.length > 0 ? panels : [...DEFAULT_SETTINGS.defaultPanels],
  };
}

// --- collection helpers --------------------------------------------------------

/** Replace-or-append by id, preserving order; new items go last. */
export function upsertById<T extends { id: string }>(list: T[], item: T): T[] {
  const idx = list.findIndex((x) => x.id === item.id);
  if (idx === -1) return [...list, item];
  const next = [...list];
  next[idx] = item;
  return next;
}

export function removeById<T extends { id: string }>(
  list: T[],
  id: string,
): T[] {
  return list.filter((x) => x.id !== id);
}
