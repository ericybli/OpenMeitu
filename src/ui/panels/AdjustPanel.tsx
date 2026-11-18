import { useT } from '../../app/hooks';
import { PanelSection } from '../components/PanelSection';
import { ParamSlider, type ParamDef } from '../components/ParamSlider';

const LIGHT: readonly ParamDef[] = [
  { kind: 'adjust', param: 'exposure', label: 'param.adjust.exposure', format: 'stops' },
  { kind: 'adjust', param: 'contrast', label: 'param.adjust.contrast' },
  { kind: 'adjust', param: 'highlights', label: 'param.adjust.highlights' },
  { kind: 'adjust', param: 'shadows', label: 'param.adjust.shadows' },
];

const COLOR: readonly ParamDef[] = [
  { kind: 'adjust', param: 'saturation', label: 'param.adjust.saturation' },
  { kind: 'adjust', param: 'vibrance', label: 'param.adjust.vibrance' },
  { kind: 'adjust', param: 'temperature', label: 'param.adjust.temperature', tone: 'temperature' },
  { kind: 'adjust', param: 'tint', label: 'param.adjust.tint', tone: 'tint' },
];

export function AdjustPanel() {
  const t = useT();
  return (
    <>
      <PanelSection title={t('section.light')}>
        {LIGHT.map((def) => (
          <ParamSlider key={def.param} def={def} />
        ))}
      </PanelSection>
      <PanelSection title={t('section.color')}>
        {COLOR.map((def) => (
          <ParamSlider key={def.param} def={def} />
        ))}
      </PanelSection>
    </>
  );
}
