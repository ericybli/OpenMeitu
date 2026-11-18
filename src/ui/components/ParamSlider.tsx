import { useEditor, useStore, useT } from '../../app/hooks';
import { findLayer } from '../../app/store';
import type { EditDocument } from '../../engine/document';
import { DEFAULT_PARAMS, PARAM_SPECS, type LayerKind, type NumericParamSpec } from '../../engine/types';
import type { MessageKey } from '../i18n';
import { formatPercent, formatSigned, formatStops, Slider, type TrackTone } from './Slider';

export interface ParamDef {
  kind: LayerKind;
  param: string;
  label: MessageKey;
  format?: 'stops';
  tone?: TrackTone;
}

function paramSpec(kind: LayerKind, param: string): NumericParamSpec {
  const spec = (PARAM_SPECS[kind] as Readonly<Record<string, NumericParamSpec | undefined>>)[param];
  if (!spec) throw new Error(`Unknown parameter ${kind}.${param}`);
  return spec;
}

function paramValue(doc: EditDocument, kind: LayerKind, param: string): number {
  const params = (findLayer(doc, kind)?.params ?? DEFAULT_PARAMS[kind]) as unknown as Readonly<Record<string, unknown>>;
  const value = params[param];
  return typeof value === 'number' ? value : 0;
}

/** A slider bound to one numeric layer parameter in the store. */
export function ParamSlider({ def, disabled = false }: { def: ParamDef; disabled?: boolean }) {
  const store = useStore();
  const t = useT();
  const value = useEditor((s) => paramValue(s.doc, def.kind, def.param));
  const spec = paramSpec(def.kind, def.param);
  const defaultValue = (DEFAULT_PARAMS[def.kind] as unknown as Readonly<Record<string, number>>)[def.param] ?? 0;
  const format = def.format === 'stops' ? formatStops : spec.min < 0 ? formatSigned : formatPercent;

  return (
    <Slider
      label={t(def.label)}
      value={value}
      min={spec.min}
      max={spec.max}
      step={spec.step}
      defaultValue={defaultValue}
      format={format}
      resetHint={t('slider.resetTitle')}
      tone={def.tone}
      disabled={disabled}
      testId={`slider-${def.kind}-${def.param}`}
      onChange={(v) => store.setParam(def.kind, def.param, v, true)}
      onGestureEnd={() => store.endGesture()}
      onReset={() => store.setParam(def.kind, def.param, defaultValue)}
    />
  );
}
