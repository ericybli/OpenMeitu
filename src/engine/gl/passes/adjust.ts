import type { AdjustParams } from '../../types';
import { GLSL_COLOR, GLSL_HEADER } from '../glsl';
import type { Pass } from '../pass';

/** log2 gain applied to red (+) and blue (-) at temperature = 1. */
const TEMPERATURE_STOPS = 0.35;
/** log2 gain removed from green at tint = 1 (magenta). */
const TINT_STOPS = 0.25;
/** Contrast slider -> curve bend; |bend| <= 1 keeps the curve monotonic. */
const CONTRAST_BEND = 0.7;
/** Lowest knee of the highlight roll-off (linear light). */
const ROLL_OFF_MIN_KNEE = 0.5;
/** Channel overshoot below this is left to the final clamp (< 0.3 LSB). */
const ROLL_OFF_EPSILON = 1e-3;
const LUMA_WEIGHTS = [0.2126, 0.7152, 0.0722] as const;

const FRAGMENT = `${GLSL_HEADER}
${GLSL_COLOR}
uniform sampler2D u_image;
uniform vec3 u_gain;          // white-balance gains * 2^EV, linear light
uniform float u_rollOffKnee;  // linear value where the highlight roll-off starts
uniform float u_rollOff;      // roll-off curvature; 0 disables it
uniform float u_contrast;     // curve bend, 0 = identity
uniform float u_highlights;
uniform float u_shadows;
uniform float u_saturation;
uniform float u_vibrance;

const float MID_GREY = 0.4613;      // 18% grey, sRGB encoded
const float HIGHLIGHT_START = 0.4;  // perceptual luminance where highlights begin
const float SHADOW_END = 0.6;       // perceptual luminance where shadows end
const float HIGHLIGHT_BOOST = 0.9;
const float HIGHLIGHT_RECOVER = 1.2;
const float WHITE_RECOVER = 0.25;
const float SHADOW_LIFT = 1.6;
const float SHADOW_DEEPEN = 0.9;
const float SATURATION_GAIN = 1.0;
const float VIBRANCE_GAIN = 1.5;
const float SKIN_PROTECTION = 0.7;
// Unit chroma direction (colour minus its luminance, linear light) of typical skin tones.
const vec3 SKIN_CHROMA = vec3(0.765, -0.165, -0.623);

float maxComponent(vec3 v) { return max(v.r, max(v.g, v.b)); }

// Identity below the knee; above it a rational shoulder maps [knee, peak gain]
// onto [knee, 1] with slope 1 at the knee, so boosted channels never clip hard.
vec3 rollOff(vec3 t) {
  if (u_rollOff <= 0.0) return t;
  vec3 u = max(t - u_rollOffKnee, 0.0) / (1.0 - u_rollOffKnee);
  vec3 rolled = u_rollOffKnee + (1.0 - u_rollOffKnee) * u / (1.0 + u_rollOff * u);
  return mix(t, rolled, step(u_rollOffKnee, t));
}

// Piecewise-quadratic S-curve around mid-grey: endpoints fixed, C1 at the pivot.
float contrastCurve(float x) {
  if (x < MID_GREY) {
    float t = x / MID_GREY;
    return x + u_contrast * MID_GREY * (t * t - t);
  }
  float t = (1.0 - x) / (1.0 - MID_GREY);
  return x + u_contrast * (1.0 - MID_GREY) * (t - t * t);
}

// Hue-stable curve application (as in the DNG RGB tone curve): the largest and
// smallest channels follow the curve and the middle one keeps its relative
// position between them, so per-channel contrast cannot shift hue.
vec3 applyContrast(vec3 c) {
  float hi = maxComponent(c);
  float lo = min(c.r, min(c.g, c.b));
  float curvedHi = contrastCurve(hi);
  float curvedLo = contrastCurve(lo);
  return curvedLo + (curvedHi - curvedLo) * ((c - lo) / max(hi - lo, 1e-6));
}

// Smooth bumps that vanish (with zero slope) at the band edge; the gains are
// chosen so every curve stays monotonic over the whole slider range.
float highlightsCurve(float l) {
  float u = clamp((l - HIGHLIGHT_START) / (1.0 - HIGHLIGHT_START), 0.0, 1.0);
  float bump = u * u * (1.0 - u);
  float shape = u_highlights > 0.0
    ? HIGHLIGHT_BOOST * bump
    : HIGHLIGHT_RECOVER * bump + WHITE_RECOVER * u * u * u;
  return l + (1.0 - HIGHLIGHT_START) * u_highlights * shape;
}

float shadowsCurve(float l) {
  float v = clamp(1.0 - l / SHADOW_END, 0.0, 1.0);
  float bump = v * v * (1.0 - v);
  return l + SHADOW_END * u_shadows * (u_shadows > 0.0 ? SHADOW_LIFT : SHADOW_DEEPEN) * bump;
}

// Tone curves act on perceptual luminance; the result scales linear RGB, so
// hue and chroma ratios are kept. Overshoot is desaturated toward the target
// luminance instead of being clipped per channel.
vec3 highlightsShadows(vec3 lin) {
  float y = luma(lin);
  float l = linearToSrgb(vec3(y)).r;
  float target = srgbToLinear(vec3(shadowsCurve(highlightsCurve(l)))).r;
  vec3 c = lin * (target / max(y, 1e-6));
  float peak = maxComponent(c);
  if (peak <= 1.0) return c;
  return target + (c - target) * ((1.0 - target) / max(peak - target, 1e-6));
}

// Saturation and vibrance scale chroma by a factor that depends on the colour's
// relative saturation r (1 = on the sRGB gamut boundary for its hue and
// luminance). Boost curves map r = 1 to 1, so colours never leave the gamut.
vec3 adjustChroma(vec3 lin) {
  float y = luma(lin);
  vec3 chroma = lin - y;
  float r = clamp(max(maxComponent(chroma / max(1.0 - y, 1e-6)), maxComponent(-chroma / max(y, 1e-6))), 0.0, 1.0);

  float gain;
  if (u_saturation >= 0.0) {
    float a = 1.0 + SATURATION_GAIN * u_saturation;
    gain = a * inversesqrt(1.0 + (a * a - 1.0) * r * r);
  } else {
    gain = 1.0 + u_saturation;
  }

  float chromaLength = length(chroma);
  float skin = chromaLength > 1e-5 ? smoothstep(0.90, 0.98, dot(chroma, SKIN_CHROMA) / chromaLength) : 0.0;
  float av = 1.0 + VIBRANCE_GAIN * abs(u_vibrance) * (1.0 - SKIN_PROTECTION * skin);
  float r1 = r * gain;
  gain *= u_vibrance >= 0.0 ? av / (1.0 + (av - 1.0) * r1) : 1.0 / (av - (av - 1.0) * r1);

  return y + chroma * gain;
}

void main() {
  // An exact texel read: texture() at pixel centres can be off by a fraction of a level that depends
  // on the image size, which would make a crop differ from the same part of the whole photo.
  vec4 src = texelFetch(u_image, ivec2(gl_FragCoord.xy), 0);
  vec3 lin = rollOff(srgbToLinear(src.rgb) * u_gain);
  if (u_contrast != 0.0) lin = srgbToLinear(applyContrast(linearToSrgb(lin)));
  if (u_highlights != 0.0 || u_shadows != 0.0) lin = highlightsShadows(lin);
  if (u_saturation != 0.0 || u_vibrance != 0.0) lin = adjustChroma(lin);
  outColor = vec4(clamp(linearToSrgb(lin), 0.0, 1.0), src.a);
}
`;

/** Luminance-preserving white-balance gains in linear light. */
function whiteBalanceGains(temperature: number, tint: number): [number, number, number] {
  if (temperature === 0 && tint === 0) return [1, 1, 1];
  const r = 2 ** (TEMPERATURE_STOPS * temperature);
  const g = 2 ** (-TINT_STOPS * tint);
  const b = 2 ** (-TEMPERATURE_STOPS * temperature);
  const y = LUMA_WEIGHTS[0] * r + LUMA_WEIGHTS[1] * g + LUMA_WEIGHTS[2] * b;
  return [r / y, g / y, b / y];
}

/**
 * Shoulder for channel gains above 1: the knee sits as far below 1 as the
 * peak gain overshoots it (never below ROLL_OFF_MIN_KNEE), and the curvature
 * is solved so an input of 1 lands exactly on 1.
 */
function rollOffParams(peakGain: number): { knee: number; curvature: number } {
  if (peakGain <= 1 + ROLL_OFF_EPSILON) return { knee: 1, curvature: 0 };
  const knee = Math.max(ROLL_OFF_MIN_KNEE, 2 - peakGain);
  const domain = (peakGain - knee) / (1 - knee);
  return { knee, curvature: (domain - 1) / domain };
}

function adjustUniforms(p: AdjustParams) {
  const exposureGain = 2 ** p.exposure;
  const gain = whiteBalanceGains(p.temperature, p.tint).map((g) => g * exposureGain);
  const rollOff = rollOffParams(Math.max(...gain));
  return {
    u_gain: gain,
    u_rollOffKnee: rollOff.knee,
    u_rollOff: rollOff.curvature,
    u_contrast: CONTRAST_BEND * p.contrast,
    u_highlights: p.highlights,
    u_shadows: p.shadows,
    u_saturation: p.saturation,
    u_vibrance: p.vibrance,
  };
}

/**
 * Global tone and colour: white balance and exposure in linear light, an
 * S-curve contrast in perceptual space, hue-preserving highlight/shadow
 * curves, then gamut-aware saturation and skin-protecting vibrance.
 */
export const adjustPass: Pass<'adjust'> = {
  kind: 'adjust',
  run(env, input, output, layer) {
    env.gpu.draw(env.gpu.program('pass.adjust', FRAGMENT), output, {
      u_image: input,
      ...adjustUniforms(layer.params),
    });
  },
};
