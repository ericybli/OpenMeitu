import { useT } from '../../app/hooks';
import type { MessageKey } from '../i18n';
import { PanelSection } from '../components/PanelSection';
import { ParamSlider, type ParamDef } from '../components/ParamSlider';

const GROUPS: readonly { title: MessageKey; params: readonly ParamDef[] }[] = [
  {
    title: 'section.sharpen',
    params: [
      { kind: 'sharpen', param: 'amount', label: 'param.sharpen.amount' },
      { kind: 'sharpen', param: 'radius', label: 'param.sharpen.radius' },
    ],
  },
  {
    title: 'section.vignette',
    params: [
      { kind: 'vignette', param: 'amount', label: 'param.vignette.amount' },
      { kind: 'vignette', param: 'midpoint', label: 'param.vignette.midpoint' },
      { kind: 'vignette', param: 'feather', label: 'param.vignette.feather' },
    ],
  },
  {
    title: 'section.grain',
    params: [
      { kind: 'grain', param: 'amount', label: 'param.grain.amount' },
      { kind: 'grain', param: 'size', label: 'param.grain.size' },
    ],
  },
];

export function EffectsPanel() {
  const t = useT();
  return (
    <>
      {GROUPS.map((group) => (
        <PanelSection key={group.title} title={t(group.title)}>
          {group.params.map((def) => (
            <ParamSlider key={`${def.kind}.${def.param}`} def={def} />
          ))}
        </PanelSection>
      ))}
    </>
  );
}
