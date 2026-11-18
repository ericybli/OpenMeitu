import { useId, type CSSProperties } from 'react';

export type TrackTone = 'temperature' | 'tint';

export interface SliderProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  defaultValue: number;
  format: (value: number) => string;
  /** Tooltip, e.g. "Double-click to reset". */
  resetHint: string;
  onChange: (value: number) => void;
  /** End of a drag/keyboard gesture (pointerup, keyup, blur). */
  onGestureEnd?: () => void;
  onReset: () => void;
  disabled?: boolean;
  /** Colour the track (white-balance sliders) instead of drawing a fill. */
  tone?: TrackTone;
  compact?: boolean;
  testId?: string;
}

/**
 * Labelled range slider. Ranges that span zero fill from the centre; double-
 * click resets to the default; arrow/Page/Home/End keys work natively.
 */
export function Slider({
  label,
  value,
  min,
  max,
  step,
  defaultValue,
  format,
  resetHint,
  onChange,
  onGestureEnd,
  onReset,
  disabled = false,
  tone,
  compact = false,
  testId,
}: SliderProps) {
  const id = useId();
  const span = max - min || 1;
  const position = (value - min) / span;
  const origin = min < 0 && max > 0 ? (0 - min) / span : 0;
  const bipolar = origin > 0;
  const style = {
    '--fill-from': Math.min(origin, position),
    '--fill-to': Math.max(origin, position),
  } as CSSProperties;
  const changed = Math.abs(value - defaultValue) > step / 2;
  const text = format(value);

  return (
    <div
      className={[
        'slider',
        compact && 'slider--compact',
        bipolar && 'slider--bipolar',
        tone && `slider--${tone}`,
        disabled && 'is-disabled',
      ]
        .filter(Boolean)
        .join(' ')}
      title={disabled ? undefined : resetHint}
      onDoubleClick={disabled ? undefined : onReset}
    >
      <div className="slider__head">
        <label htmlFor={id} className="slider__label">
          {label}
        </label>
        <output htmlFor={id} className={changed ? 'slider__value is-changed' : 'slider__value'}>
          {text}
        </output>
      </div>
      <input
        id={id}
        className="slider__input"
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        style={style}
        aria-valuetext={text}
        data-testid={testId}
        onChange={(e) => onChange(Number(e.currentTarget.value))}
        onPointerUp={onGestureEnd}
        onPointerCancel={onGestureEnd}
        onKeyUp={onGestureEnd}
        onBlur={onGestureEnd}
      />
    </div>
  );
}

export function formatPercent(value: number): string {
  return String(Math.round(value * 100));
}

export function formatSigned(value: number): string {
  const n = Math.round(value * 100);
  if (n === 0) return '0';
  return `${n > 0 ? '+' : '−'}${Math.abs(n)}`;
}

export function formatStops(value: number): string {
  const n = Math.round(value * 100) / 100;
  if (n === 0) return '0.00';
  return `${n > 0 ? '+' : '−'}${Math.abs(n).toFixed(2)}`;
}
