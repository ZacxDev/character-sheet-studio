/**
 * TEMPORARY screenshot rig — deleted after screenshots are captured.
 * Seeded demo data for the mock host storage scenario.
 */
export const SCREENSHOT_SEED: Record<string, unknown> = {
  'v1:char:demo-char-1': {
    id: 'demo-char-1',
    name: 'Kaida',
    description: 'A cyberpunk street samurai with neon-blue undercut hair',
    traits: ['neon-blue undercut hair', 'cybernetic left arm', 'worn leather jacket'],
    triggerWords: ['kaida_cyber'],
    negativePrompt: 'blurry, low quality, deformed',
    defaultStackId: 'demo-stack-1',
    seedPolicy: 'locked',
    createdAt: '2026-10-01T17:00:00.000Z',
    updatedAt: '2026-10-01T17:00:00.000Z',
  },
  'v1:stack:demo-stack-1': {
    id: 'demo-stack-1',
    name: 'SDXL Anime + detail LoRAs',
    checkpoint: {
      modelId: 101055,
      modelVersionId: 128078,
      baseModel: 'SDXL 1.0',
      name: 'SDXL 1.0',
    },
    loras: [
      {
        modelVersionId: 12345,
        strength: 0.8,
        triggerWords: ['anime_detail'],
        name: 'Detail Tweaker LoRA',
      },
      {
        modelVersionId: 67890,
        strength: 0.6,
        triggerWords: ['kaida_cyber'],
        name: 'Kaida character LoRA',
      },
    ],
    notes: 'Go-to stack for Kaida sheets',
    createdAt: '2026-10-01T17:00:00.000Z',
    updatedAt: '2026-10-01T17:00:00.000Z',
  },
  'v1:sheet:demo-sheet-1': {
    id: 'demo-sheet-1',
    name: 'Kaida turnaround v1',
    characterId: 'demo-char-1',
    stackId: 'demo-stack-1',
    seed: 123456,
    account: 'auto',
    useReference: false,
    status: 'draft',
    panels: [
      { id: 'p-front', kind: 'front', label: 'Front view', promptModifier: 'front view, character turnaround, neutral pose', seed: 123456, status: 'queued', outputs: [], submitNonce: 0 },
      { id: 'p-side', kind: 'side', label: 'Side view', promptModifier: 'side view, character turnaround, neutral pose', seed: 123457, status: 'queued', outputs: [], submitNonce: 0 },
      { id: 'p-back', kind: 'back', label: 'Back view', promptModifier: 'back view, character turnaround, neutral pose', seed: 123458, status: 'queued', outputs: [], submitNonce: 0 },
      { id: 'p-tq', kind: 'three-quarter', label: 'Three-quarter', promptModifier: 'three-quarter view, character turnaround', seed: 123459, status: 'queued', outputs: [], submitNonce: 0 },
      { id: 'p-expr', kind: 'expression', label: 'Expressions', promptModifier: 'expression sheet, happy angry sad surprised', seed: 123460, status: 'queued', outputs: [], submitNonce: 0 },
      { id: 'p-scene', kind: 'scenario', label: 'Action pose', promptModifier: 'dynamic action pose, neon city rooftop at night', seed: 123461, status: 'queued', outputs: [], submitNonce: 0 },
    ],
    createdAt: '2026-10-01T17:00:00.000Z',
    updatedAt: '2026-10-01T17:00:00.000Z',
  },
};
