/**
 * CPU colour toolkit used to build looks (filters/looks.ts).
 *
 * Every function is pure. Colours are display-referred sRGB triples in 0..1
 * unless a name says `linear` (linear-light sRGB primaries) or `oklab`.
 * Intermediate results may leave 0..1; `buildLut` clamps the final output.
 *
 * References: IEC 61966-2-1 (sRGB transfer), ITU-R BT.709 (luminance
 * weights), Björn Ottosson, "A perceptual color space for image processing"
 * (2020, OKLab), Fritsch & Carlson, "Monotone Piecewise Cubic Interpolation"
 * (SIAM J. Numer. Anal., 1980).
 */

export type Rgb = readonly [number, number, number];
/** OKLab: L (perceived lightness, 0..1), a (green..red), b (blue..yellow). */
export type Oklab = readonly [number, number, number];
/** OKLCh: L, chroma C = hypot(a, b), hue h in degrees 0..360 (0 = pinkish red, ~90 = yellow, ~140 = green, ~265 = blue). */
export type Oklch = readonly [number, number, number];
/** Row-major 3x3 matrix: out[i] = row[i] · in. */
export type Matrix3 = readonly [Rgb, Rgb, Rgb];

const DEG = Math.PI / 180;

export function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/** Hermite smoothstep: 0 below edge0, 1 above edge1, 3t² − 2t³ between. */
export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

// ---------------------------------------------------------------------------
// Transfer functions and luminance

/** sRGB electro-optical transfer: v ≤ 0.04045 ? v/12.92 : ((v+0.055)/1.055)^2.4. */
export function srgbToLinear(v: number): number {
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

/** Inverse of srgbToLinear: v ≤ 0.0031308 ? 12.92·v : 1.055·v^(1/2.4) − 0.055. */
export function linearToSrgb(v: number): number {
  return v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
}

export function srgbToLinearRgb(c: Rgb): Rgb {
  return [srgbToLinear(c[0]), srgbToLinear(c[1]), srgbToLinear(c[2])];
}

export function linearToSrgbRgb(c: Rgb): Rgb {
  return [linearToSrgb(c[0]), linearToSrgb(c[1]), linearToSrgb(c[2])];
}

/** BT.709 / sRGB luminance weights, applied to linear-light values. */
export const LUMINANCE_WEIGHTS: Rgb = [0.2126, 0.7152, 0.0722];

/** Relative luminance Y (0..1, linear light) of an sRGB colour: Y = 0.2126 R + 0.7152 G + 0.0722 B on linearised channels. */
export function luminance(c: Rgb): number {
  const [r, g, b] = srgbToLinearRgb(c);
  return LUMINANCE_WEIGHTS[0] * r + LUMINANCE_WEIGHTS[1] * g + LUMINANCE_WEIGHTS[2] * b;
}

// ---------------------------------------------------------------------------
// HSL (hexcone model on sRGB-encoded values)

/** sRGB → [h, s, l], all 0..1 (h = 0 red, 1/3 green, 2/3 blue). Greys have h = s = 0. */
export function rgbToHsl(c: Rgb): Rgb {
  const [r, g, b] = c;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d < 1e-9) return [0, 0, l];
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [h / 6, s, l];
}

/** [h, s, l] (0..1, h wraps) → sRGB. */
export function hslToRgb(hsl: Rgb): Rgb {
  const [h, s, l] = hsl;
  if (s <= 0) return [l, l, l];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [hueToChannel(p, q, h + 1 / 3), hueToChannel(p, q, h), hueToChannel(p, q, h - 1 / 3)];
}

function hueToChannel(p: number, q: number, t: number): number {
  t -= Math.floor(t);
  if (t < 1 / 6) return p + (q - p) * 6 * t;
  if (t < 1 / 2) return q;
  if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
  return p;
}

// ---------------------------------------------------------------------------
// OKLab / OKLCh (Ottosson 2020). Linear sRGB → LMS (M1), cube root, → Lab (M2).

export function linearSrgbToOklab(c: Rgb): Oklab {
  const [r, g, b] = c;
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

export function oklabToLinearSrgb(lab: Oklab): Rgb {
  const [L, a, b] = lab;
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

export function rgbToOklab(c: Rgb): Oklab {
  return linearSrgbToOklab(srgbToLinearRgb(c));
}

/** OKLab → sRGB without gamut mapping (components may leave 0..1). */
export function oklabToRgb(lab: Oklab): Rgb {
  return linearToSrgbRgb(oklabToLinearSrgb(lab));
}

export function oklabToOklch(lab: Oklab): Oklch {
  const [L, a, b] = lab;
  const h = Math.atan2(b, a) / DEG;
  return [L, Math.hypot(a, b), h < 0 ? h + 360 : h];
}

export function oklchToOklab(lch: Oklch): Oklab {
  const [L, C, h] = lch;
  return [L, C * Math.cos(h * DEG), C * Math.sin(h * DEG)];
}

/**
 * Slack for the OKLab round trip, whose published 10-digit matrices are
 * accurate to ~3e-7 in linear light, so colours on the cube surface (clipped
 * channels) still count as in gamut. Far below one 8-bit step.
 */
const GAMUT_EPSILON = 1e-6;

function inUnitCube(c: Rgb): boolean {
  return (
    c[0] >= -GAMUT_EPSILON &&
    c[0] <= 1 + GAMUT_EPSILON &&
    c[1] >= -GAMUT_EPSILON &&
    c[1] <= 1 + GAMUT_EPSILON &&
    c[2] >= -GAMUT_EPSILON &&
    c[2] <= 1 + GAMUT_EPSILON
  );
}

/**
 * OKLab → sRGB inside the 0..1 gamut. Lightness is clamped to 0..1, then
 * chroma is reduced (bisection on the a/b scale) at constant L and hue until
 * the colour fits. Unlike per-channel clipping this never shifts hue, so a
 * pushed skin tone cannot turn yellow or magenta at the gamut boundary.
 */
export function oklabToRgbInGamut(lab: Oklab): Rgb {
  const L = clamp01(lab[0]);
  const [, a, b] = lab;
  let lin = oklabToLinearSrgb([L, a, b]);
  if (!inUnitCube(lin)) {
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2;
      if (inUnitCube(oklabToLinearSrgb([L, a * mid, b * mid]))) lo = mid;
      else hi = mid;
    }
    lin = oklabToLinearSrgb([L, a * lo, b * lo]);
  }
  return encodeClamped(lin);
}

/**
 * The colour on the OKLab segment from `from` to `to` that is nearest `to`
 * while inside the sRGB gamut: from + t·(to − from) with the largest t in 0..1
 * (bisection). Operations that shift colours use it to apply only as much of
 * their effect as the gamut allows, so colours on the gamut surface (clipped
 * highlights, saturated primaries) keep their colour instead of being
 * chroma-reduced into a paler one, and pure black and white stay neutral.
 * `from` outside the gamut is first mapped with oklabToRgbInGamut.
 */
export function oklabTowardsInGamut(from: Oklab, to: Oklab): Rgb {
  const target = oklabToLinearSrgb(to);
  if (inUnitCube(target)) return encodeClamped(target);
  const start = inUnitCube(oklabToLinearSrgb(from)) ? from : rgbToOklab(oklabToRgbInGamut(from));
  const at = (t: number): Rgb => [
    start[0] + (to[0] - start[0]) * t,
    start[1] + (to[1] - start[1]) * t,
    start[2] + (to[2] - start[2]) * t,
  ];
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    if (inUnitCube(oklabToLinearSrgb(at(mid)))) lo = mid;
    else hi = mid;
  }
  return encodeClamped(oklabToLinearSrgb(at(lo)));
}

/**
 * Largest chroma inside the sRGB gamut along the ray from (L, 0, 0) through
 * `lab` (same lightness and hue), by bisection; `chroma` = hypot(a, b) > 0 and
 * `outside` is a chroma known to lie outside the gamut on that ray.
 */
function gamutChroma(lab: Oklab, chroma: number, outside: number): number {
  const [L, a, b] = lab;
  const da = a / chroma;
  const db = b / chroma;
  const inside = (c: number): boolean => inUnitCube(oklabToLinearSrgb([L, da * c, db * c]));
  let lo = inside(chroma) ? chroma : 0;
  let hi = outside;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    if (inside(mid)) lo = mid;
    else hi = mid;
  }
  return lo;
}

function encodeClamped(lin: Rgb): Rgb {
  return linearToSrgbRgb([clamp01(lin[0]), clamp01(lin[1]), clamp01(lin[2])]);
}

// ---------------------------------------------------------------------------
// Curves

export type Curve = (x: number) => number;
export type CurvePoint = readonly [x: number, y: number];

/**
 * Monotone cubic Hermite spline through `points` (Fritsch–Carlson 1980).
 *
 * Tangents start as the mean of neighbouring secants (0 at local extrema or
 * flat runs; one-sided at the ends). For each interval with secant d, if
 * α = m_k/d and β = m_{k+1}/d satisfy α² + β² > 9 both tangents are scaled by
 * 3/√(α² + β²). This keeps every interval monotone, so monotone control points
 * give a monotone curve without the overshoot of natural cubic splines.
 * Outside the control range the curve holds its end values.
 */
export function monotoneCurve(points: readonly CurvePoint[]): Curve {
  const n = points.length;
  if (n < 2) throw new Error('A curve needs at least two control points');
  const xs = new Float64Array(n);
  const ys = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const [x, y] = points[i]!;
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error(`Curve point ${i} is not finite`);
    if (i > 0 && x <= xs[i - 1]!) throw new Error('Curve control points must have strictly increasing x');
    xs[i] = x;
    ys[i] = y;
  }

  const secants = new Float64Array(n - 1);
  for (let k = 0; k < n - 1; k++) secants[k] = (ys[k + 1]! - ys[k]!) / (xs[k + 1]! - xs[k]!);

  const tangents = new Float64Array(n);
  tangents[0] = secants[0]!;
  tangents[n - 1] = secants[n - 2]!;
  for (let k = 1; k < n - 1; k++) {
    const d0 = secants[k - 1]!;
    const d1 = secants[k]!;
    tangents[k] = d0 * d1 <= 0 ? 0 : (d0 + d1) / 2;
  }
  for (let k = 0; k < n - 1; k++) {
    const d = secants[k]!;
    if (d === 0) {
      tangents[k] = 0;
      tangents[k + 1] = 0;
      continue;
    }
    const alpha = tangents[k]! / d;
    const beta = tangents[k + 1]! / d;
    const sumSq = alpha * alpha + beta * beta;
    if (sumSq > 9) {
      const tau = 3 / Math.sqrt(sumSq);
      tangents[k] = tau * alpha * d;
      tangents[k + 1] = tau * beta * d;
    }
  }

  const x0 = xs[0]!;
  const xn = xs[n - 1]!;
  return (x) => {
    if (x <= x0) return ys[0]!;
    if (x >= xn) return ys[n - 1]!;
    let lo = 0;
    let hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (xs[mid]! <= x) lo = mid;
      else hi = mid;
    }
    const h = xs[lo + 1]! - xs[lo]!;
    const t = (x - xs[lo]!) / h;
    const t2 = t * t;
    const t3 = t2 * t;
    return (
      (2 * t3 - 3 * t2 + 1) * ys[lo]! +
      (t3 - 2 * t2 + t) * h * tangents[lo]! +
      (-2 * t3 + 3 * t2) * ys[lo + 1]! +
      (t3 - t2) * h * tangents[lo + 1]!
    );
  };
}

export interface ChannelCurves {
  /** Applied to all three channels first (tone). */
  master?: Curve;
  /** Then applied per channel (colour). */
  r?: Curve;
  g?: Curve;
  b?: Curve;
}

/** Per-channel curves on sRGB-encoded values: out_c = curve_c(master(in_c)). */
export function applyCurves(c: Rgb, curves: ChannelCurves): Rgb {
  const { master, r, g, b } = curves;
  let [cr, cg, cb] = c;
  if (master) {
    cr = master(cr);
    cg = master(cg);
    cb = master(cb);
  }
  return [r ? r(cr) : cr, g ? g(cg) : cg, b ? b(cb) : cb];
}

// ---------------------------------------------------------------------------
// Tone and colour operations

/**
 * Per-channel S-curve around mid-grey (0.5 encoded): f(x) = x + k·(s(x) − x)
 * with s(x) = 3x² − 2x³ and k = amount clamped to −1..1. f'(x) = 1 + k·(6x(1−x) − 1)
 * stays ≥ 0 for |k| ≤ 1, so the curve is monotone and keeps 0, 0.5 and 1 fixed.
 * Mid-tone slope is 1 + k/2. Outside 0..1 it continues linearly with the end
 * slope 1 − k, so out-of-range intermediates never reverse.
 */
export function contrast(c: Rgb, amount: number): Rgb {
  const k = Math.max(-1, Math.min(1, amount));
  const f = (x: number): number => {
    if (x < 0) return (1 - k) * x;
    if (x > 1) return 1 + (1 - k) * (x - 1);
    return x + k * (x * x * (3 - 2 * x) - x);
  };
  return [f(c[0]), f(c[1]), f(c[2])];
}

/**
 * Lifts black to `amount` while keeping white: f(x) = x + a·(1 − x)², a = amount
 * clamped to 0..0.45. f'(x) = 1 − 2a(1 − x) > 0 on 0..1, so tones never reverse.
 * Outside 0..1 it continues linearly (slope 1 − 2a below 0, 1 above 1).
 */
export function fade(c: Rgb, amount: number): Rgb {
  const a = Math.max(0, Math.min(0.45, amount));
  const f = (x: number): number => {
    if (x < 0) return a + (1 - 2 * a) * x;
    if (x > 1) return x;
    return x + a * (1 - x) * (1 - x);
  };
  return [f(c[0]), f(c[1]), f(c[2])];
}

/** Relative chroma (fraction of the gamut boundary) up to which chroma boosts apply exactly. */
const BOOST_KNEE = 0.75;

/**
 * Scales OKLab chroma by k ≥ 0 at constant lightness and hue.
 *
 * Reductions (k ≤ 1) are exact. Boosts act on the relative chroma
 * u = C / C_max, where C_max is the gamut boundary along the same ray, and roll
 * off above the knee u_k = 0.75 instead of clipping at the boundary:
 *   x = k·u;  u' = x                                            for x ≤ u_k
 *             u' = u_k + d / (1 + d·(1/(1 − u_k) − 1/(k − u_k)))  for x > u_k, d = x − u_k
 * u' is C¹ at the knee, increasing in u, and maps u = 1 to 1, so a boost never
 * lowers chroma, never leaves the gamut, and colours near the boundary (bright
 * yellows and cyans whose gamut narrows sharply with lightness) do not band.
 */
export function scaleChroma(c: Rgb, k: number): Rgb {
  return scaleOklabChroma(rgbToOklab(c), k);
}

function scaleOklabChroma(lab: Oklab, k: number): Rgb {
  const [L, a, b] = lab;
  const scale = Math.max(0, k);
  if (scale <= 1) return oklabToRgbInGamut([L, a * scale, b * scale]);
  const chroma = Math.hypot(a, b);
  if (chroma < 1e-9) return oklabToRgbInGamut(lab);
  // If chroma·k/u_k still fits, then k·u ≤ u_k and the boost is exact; no need to find C_max.
  const reach = scale / BOOST_KNEE;
  if (inUnitCube(oklabToLinearSrgb([L, a * reach, b * reach]))) return oklabToRgbInGamut([L, a * scale, b * scale]);
  const maxChroma = gamutChroma(lab, chroma, chroma * reach);
  const u = Math.min(1, chroma / maxChroma);
  let target = scale * u;
  if (target > BOOST_KNEE) {
    const d = target - BOOST_KNEE;
    target = BOOST_KNEE + d / (1 + d * (1 / (1 - BOOST_KNEE) - 1 / (scale - BOOST_KNEE)));
  }
  const s = (target * maxChroma) / chroma;
  return oklabToRgbInGamut([L, a * s, b * s]);
}

/**
 * Uniform saturation in OKLCh: C' = C·(1 + amount) at constant L and hue via
 * scaleChroma (boosts roll off near the gamut boundary). amount = −1 gives a
 * grey of the same perceived lightness.
 */
export function saturation(c: Rgb, amount: number): Rgb {
  return scaleChroma(c, 1 + amount);
}

/** OKLab chroma at which vibrance stops boosting (about that of the sRGB primaries). */
const VIBRANCE_CHROMA_LIMIT = 0.3;

/**
 * Saturation weighted towards muted colours and away from skin:
 * C' = C·(1 + amount·w), w = (1 − C/0.3)²·(1 − 0.7·skin), where `skin` is
 * skinToneWeight, applied with scaleChroma. Already-vivid colours and faces
 * change little.
 */
export function vibrance(c: Rgb, amount: number): Rgb {
  const lab = rgbToOklab(c);
  const muted = 1 - clamp01(Math.hypot(lab[1], lab[2]) / VIBRANCE_CHROMA_LIMIT);
  return scaleOklabChroma(lab, 1 + amount * muted * muted * (1 - 0.7 * skinToneWeight(c)));
}

/**
 * White balance as von Kries-style diagonal gains in linear light.
 * temperature (−1..1): R·2^(t/2), B·2^(−t/2) — warm when > 0.
 * tint (−1..1): G·2^(−0.35·tint) — magenta when > 0, green when < 0.
 * Gains are divided by their luminance so neutral greys keep their luminance.
 * Channels pushed past 1 clip, as with a camera's white balance; reducing
 * chroma at constant lightness instead would turn clipped bright colours
 * paler (yellow (1, 1, 0) would gain a visible blue component).
 */
export function whiteBalance(c: Rgb, temperature: number, tint: number): Rgb {
  let gr = Math.pow(2, temperature / 2);
  let gg = Math.pow(2, -0.35 * tint);
  let gb = Math.pow(2, -temperature / 2);
  const norm = LUMINANCE_WEIGHTS[0] * gr + LUMINANCE_WEIGHTS[1] * gg + LUMINANCE_WEIGHTS[2] * gb;
  gr /= norm;
  gg /= norm;
  gb /= norm;
  const [r, g, b] = srgbToLinearRgb(c);
  return encodeClamped([r * gr, g * gg, b * gb]);
}

export interface SplitToneOptions {
  /** OKLCh hue (degrees) pushed into shadows. */
  shadowHue: number;
  /** OKLab chroma added to the darkest tones (typically 0..0.06). */
  shadowAmount: number;
  /** OKLCh hue (degrees) pushed into highlights. */
  highlightHue: number;
  /** OKLab chroma added to the brightest tones (typically 0..0.06). */
  highlightAmount: number;
  /** −1..1: moves the shadow/highlight crossover so that more tones count as highlights (> 0) or shadows (< 0). */
  balance?: number;
}

/**
 * Split toning in OKLab. With L the input lightness, crossover
 * p = 0.5 − 0.2·balance and w_h = smoothstep(p − 0.35, p + 0.35, L), w_s = 1 − w_h,
 * the (a, b) offset w_s·shadowAmount·(cos h_s, sin h_s) + w_h·highlightAmount·(cos h_h, sin h_h)
 * is added at constant L, shortened where it would leave the gamut
 * (oklabTowardsInGamut), so pure black, pure white and clipped colours keep
 * their colour.
 */
export function splitTone(c: Rgb, options: SplitToneOptions): Rgb {
  const { shadowHue, shadowAmount, highlightHue, highlightAmount, balance = 0 } = options;
  const lab = rgbToOklab(c);
  const [L, a, b] = lab;
  const pivot = 0.5 - 0.2 * balance;
  const wh = smoothstep(pivot - 0.35, pivot + 0.35, L);
  const ws = 1 - wh;
  const da = ws * shadowAmount * Math.cos(shadowHue * DEG) + wh * highlightAmount * Math.cos(highlightHue * DEG);
  const db = ws * shadowAmount * Math.sin(shadowHue * DEG) + wh * highlightAmount * Math.sin(highlightHue * DEG);
  return oklabTowardsInGamut(lab, [L, a + da, b + db]);
}

/**
 * Channel mixer in linear light: out_i = Σ_j m[i][j]·in_j, then re-encoded and
 * clamped. Rows summing to 1 keep neutral greys unchanged; mixing linear light
 * behaves like optical colour filters rather than shifting encoded values.
 */
export function channelMixer(c: Rgb, m: Matrix3): Rgb {
  const [r, g, b] = srgbToLinearRgb(c);
  const row = (w: Rgb): number => linearToSrgb(clamp01(w[0] * r + w[1] * g + w[2] * b));
  return [row(m[0]), row(m[1]), row(m[2])];
}

// ---------------------------------------------------------------------------
// Skin-aware helpers

/** OKLCh hue of typical human skin; fair to deep complexions cluster around 45–62°. */
const SKIN_HUE = 52;
const SKIN_HUE_SIGMA = 20;

/**
 * 0..1 likelihood that a colour is skin, from OKLCh: a Gaussian on hue around
 * 52° (σ = 20°) times smooth windows on chroma (fading in over 0.012–0.04 and
 * out over 0.11–0.18) and lightness (in over 0.18–0.32, out over 0.93–0.99).
 * Smooth everywhere so LUTs built with it interpolate cleanly.
 */
export function skinToneWeight(c: Rgb): number {
  const [L, C, h] = oklabToOklch(rgbToOklab(c));
  const dh = hueDifference(SKIN_HUE, h);
  const hueWeight = Math.exp(-0.5 * (dh / SKIN_HUE_SIGMA) ** 2);
  const chromaWeight = smoothstep(0.012, 0.04, C) * (1 - smoothstep(0.11, 0.18, C));
  const lightWeight = smoothstep(0.18, 0.32, L) * (1 - smoothstep(0.93, 0.99, L));
  return hueWeight * chromaWeight * lightWeight;
}

/** Signed shortest angular difference to − from, in degrees (−180..180). */
export function hueDifference(from: number, to: number): number {
  const d = (((to - from) % 360) + 540) % 360;
  return d - 180;
}

/**
 * Keeps the graded colour's lightness but pulls its OKLCh hue (along the
 * shorter arc) and chroma back towards the original's by `hueAmount` and
 * `chromaAmount` (0..1), stopping short where the gamut ends
 * (oklabTowardsInGamut). Used to stop creative grades from turning skin
 * green, grey-violet or magenta, or draining it to grey.
 */
export function protectColor(original: Rgb, graded: Rgb, hueAmount: number, chromaAmount: number): Rgb {
  const [, C0, h0] = oklabToOklch(rgbToOklab(original));
  const gradedLab = rgbToOklab(graded);
  const [L, C, h] = oklabToOklch(gradedLab);
  // Hue is meaningless for near-greys; fade the rotation out instead of snapping.
  const hueWeight = clamp01(hueAmount) * smoothstep(0.005, 0.03, Math.min(C0, C));
  const hue = h + hueDifference(h, h0) * hueWeight;
  const chroma = C + (C0 - C) * clamp01(chromaAmount);
  return oklabTowardsInGamut(gradedLab, oklchToOklab([L, chroma, hue]));
}
