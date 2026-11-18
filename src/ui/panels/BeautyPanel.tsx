import { useT } from '../../app/hooks';
import { FaceStatusBadge, useFaceToolsHint } from '../components/FaceStatus';
import { PanelSection } from '../components/PanelSection';
import { ParamSlider, type ParamDef } from '../components/ParamSlider';
import { AlertIcon } from '../icons';

const SKIN: readonly ParamDef[] = [
  { kind: 'skinSmooth', param: 'amount', label: 'param.skinSmooth.amount' },
  { kind: 'skinSmooth', param: 'detail', label: 'param.skinSmooth.detail' },
  { kind: 'skinWhiten', param: 'amount', label: 'param.skinWhiten.amount' },
];

/** Tools that only work with a detected face (teethWhiten, faceReshape). */
const FACE: readonly ParamDef[] = [
  { kind: 'teethWhiten', param: 'amount', label: 'param.teethWhiten.amount' },
  { kind: 'faceReshape', param: 'slim', label: 'param.faceReshape.slim' },
  { kind: 'faceReshape', param: 'eyes', label: 'param.faceReshape.eyes' },
  { kind: 'faceReshape', param: 'nose', label: 'param.faceReshape.nose' },
  { kind: 'faceReshape', param: 'chin', label: 'param.faceReshape.chin' },
];

export function BeautyPanel() {
  const t = useT();
  const hint = useFaceToolsHint();
  return (
    <>
      <div className="panel-status">
        <FaceStatusBadge />
      </div>
      <PanelSection title={t('section.skin')}>
        {SKIN.map((def) => (
          <ParamSlider key={`${def.kind}.${def.param}`} def={def} />
        ))}
      </PanelSection>
      <PanelSection title={t('section.face')}>
        {hint && (
          <p className="panel-note" data-testid="face-tools-hint">
            <AlertIcon size={16} />
            <span>{hint}</span>
          </p>
        )}
        {FACE.map((def) => (
          <ParamSlider key={`${def.kind}.${def.param}`} def={def} disabled={hint !== null} />
        ))}
      </PanelSection>
    </>
  );
}
