import type { LayerKind } from '../../types';
import type { Pass } from '../pass';
import { adjustPass } from './adjust';
import { faceReshapePass } from './faceReshape';
import { filterPass } from './filter';
import { grainPass } from './grain';
import { sharpenPass } from './sharpen';
import { skinSmoothPass } from './skinSmooth';
import { skinWhitenPass } from './skinWhiten';
import { teethWhitenPass } from './teethWhiten';
import { transformPass } from './transform';
import { vignettePass } from './vignette';

/** One pass implementation per layer kind. */
export const PASSES: { readonly [K in LayerKind]: Pass<K> } = {
  skinSmooth: skinSmoothPass,
  skinWhiten: skinWhitenPass,
  teethWhiten: teethWhitenPass,
  faceReshape: faceReshapePass,
  adjust: adjustPass,
  filter: filterPass,
  sharpen: sharpenPass,
  vignette: vignettePass,
  grain: grainPass,
  transform: transformPass,
};
