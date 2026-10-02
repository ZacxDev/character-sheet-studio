// Workflow-body construction for sheet panels — the SINGLE place a panel's
// submit/estimate body is built.
//
// The Builder (estimate + batch submit) and the View (regenerate / retry) all
// build through here, so a panel rebuilt later — resume after a tab close, a
// regenerate weeks later — submits a byte-identical body for the same sheet
// config. The sheet persists `account` + `useReference`, so the View can
// reconstruct the exact body without the Builder's form state.
//
// No React, no DOM — unit-tested in node (see body.test.ts).

import type { BlockSourceImage } from '@civitai/app-sdk/blocks';

import type {
  Character,
  ModelStack,
  SheetPanel,
  SheetSettings,
} from './types.js';
import { composePanelPrompt } from './prompt.js';
import { buildWorkflowBody, type AccountChoice } from '../money/generation.js';
import type { CheckpointOption, LoraOption } from '../models.js';

export interface PanelBodyOptions {
  account: AccountChoice;
  useReference: boolean;
}

export function buildSheetPanelBody(
  panel: SheetPanel,
  character: Character,
  stack: ModelStack,
  settings: SheetSettings,
  opts: PanelBodyOptions,
) {
  const { prompt, negativePrompt } = composePanelPrompt(character, stack, panel, settings);
  const checkpoint: CheckpointOption = {
    versionId: stack.checkpoint.modelVersionId,
    modelId: stack.checkpoint.modelId,
    label: stack.checkpoint.name ?? `Model #${stack.checkpoint.modelVersionId}`,
    baseModel: stack.checkpoint.baseModel,
  };
  const loras: LoraOption[] = stack.loras.map((l) => ({
    versionId: l.modelVersionId,
    modelId: 0,
    label: l.name ?? `LoRA #${l.modelVersionId}`,
    baseModel: stack.checkpoint.baseModel,
    weight: l.strength,
  }));
  const sourceImages: BlockSourceImage[] | undefined =
    opts.useReference && character.referenceImage
      ? [character.referenceImage]
      : undefined;
  return buildWorkflowBody(
    prompt,
    checkpoint,
    loras,
    opts.account,
    negativePrompt,
    sourceImages,
    panel.seed,
  );
}
