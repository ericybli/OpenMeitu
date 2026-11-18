/** Shared GLSL snippets. Prepend GLSL_HEADER to every fragment shader. */

export const GLSL_HEADER = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
precision highp sampler3D;
in vec2 v_uv;
out vec4 outColor;
`;

/** Colour helpers. All colours are display-referred sRGB in 0..1 unless named *Linear. */
export const GLSL_COLOR = `
float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

vec3 srgbToLinear(vec3 c) {
  vec3 lo = c / 12.92;
  vec3 hi = pow((c + 0.055) / 1.055, vec3(2.4));
  return mix(lo, hi, step(vec3(0.04045), c));
}

vec3 linearToSrgb(vec3 c) {
  c = max(c, vec3(0.0));
  vec3 lo = c * 12.92;
  vec3 hi = 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055;
  return mix(lo, hi, step(vec3(0.0031308), c));
}

// Full-range BT.601 YCbCr, Cb/Cr centred at 0.5.
vec3 rgbToYCbCr(vec3 c) {
  float y  = dot(c, vec3(0.299, 0.587, 0.114));
  float cb = 0.5 + dot(c, vec3(-0.168736, -0.331264, 0.5));
  float cr = 0.5 + dot(c, vec3(0.5, -0.418688, -0.081312));
  return vec3(y, cb, cr);
}

vec3 yCbCrToRgb(vec3 ycc) {
  float y = ycc.x, cb = ycc.y - 0.5, cr = ycc.z - 0.5;
  return vec3(y + 1.402 * cr, y - 0.344136 * cb - 0.714136 * cr, y + 1.772 * cb);
}

vec3 rgbToHsl(vec3 c) {
  float mx = max(c.r, max(c.g, c.b));
  float mn = min(c.r, min(c.g, c.b));
  float l = (mx + mn) * 0.5;
  float d = mx - mn;
  if (d < 1e-6) return vec3(0.0, 0.0, l);
  float s = l > 0.5 ? d / (2.0 - mx - mn) : d / (mx + mn);
  float h;
  if (mx == c.r) h = (c.g - c.b) / d + (c.g < c.b ? 6.0 : 0.0);
  else if (mx == c.g) h = (c.b - c.r) / d + 2.0;
  else h = (c.r - c.g) / d + 4.0;
  return vec3(h / 6.0, s, l);
}

float hueToRgb(float p, float q, float t) {
  t = fract(t);
  if (t < 1.0 / 6.0) return p + (q - p) * 6.0 * t;
  if (t < 0.5) return q;
  if (t < 2.0 / 3.0) return p + (q - p) * (2.0 / 3.0 - t) * 6.0;
  return p;
}

vec3 hslToRgb(vec3 hsl) {
  if (hsl.y < 1e-6) return vec3(hsl.z);
  float q = hsl.z < 0.5 ? hsl.z * (1.0 + hsl.y) : hsl.z + hsl.y - hsl.z * hsl.y;
  float p = 2.0 * hsl.z - q;
  return vec3(hueToRgb(p, q, hsl.x + 1.0 / 3.0), hueToRgb(p, q, hsl.x), hueToRgb(p, q, hsl.x - 1.0 / 3.0));
}

// Cheap hash-based noise in 0..1.
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
`;
