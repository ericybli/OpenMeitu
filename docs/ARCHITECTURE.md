# OpenMeitu architecture

OpenMeitu is a browser-based photo and beauty editor. Everything runs locally:
images never leave the device. Stack: TypeScript, Vite, WebGL2, React 19,
MediaPipe Face Landmarker (Apache-2.0), Vitest, Playwright.

```
src/
  engine/                 framework-agnostic editing engine
    types.ts              layer kinds, params, defaults, ranges      (contract)
    document.ts           immutable EditDocument operations
    history.ts            undo/redo
    preset.ts             shareable JSON presets + built-in presets
    renderer.ts           runs a layer stack on the GPU             (contract)
    gl/gpu.ts             WebGL2 wrapper: programs, textures, pool  (contract)
    gl/pass.ts            Pass / PassEnv interfaces                 (contract)
    gl/glsl.ts            shared GLSL header + colour helpers       (contract)
    gl/blur.ts            separable Gaussian blur utility           (contract)
    gl/passes/*.ts        one Pass per layer kind
  face/
    types.ts              FaceAnalysis types                        (contract)
    detector.ts           MediaPipe Face Landmarker wrapper         (contract)
    regions.ts            landmark index groups + derived geometry
    mask.ts               region masks (skin, teeth) as textures
    warp.ts               CPU reference + parameters for face reshaping
  filters/
    lut.ts                LUT data format + builder                 (contract)
    color.ts              CPU colour math used to build looks
    looks.ts              built-in colour looks (our own designs)
    cube.ts               Adobe/Resolve .cube import/export
  app/                    EditorStore (state, history, IO) for the UI
  ui/                     React components, styles, i18n
  harness/main.ts         test-only page used by Playwright         (contract)
tests/unit/               Vitest (node)
tests/e2e/                Playwright (real GPU engine in Chromium, SwiftShader)
tests/fixtures/           public-domain portraits + cached face landmarks
scripts/setup-assets.mjs  copies MediaPipe wasm + downloads the model into public/
```

## Data model

An edit is an immutable `EditDocument` holding a list of layers
(`src/engine/types.ts`). Invariants: at most one layer per kind; layers are
ordered by stage (`LAYER_KINDS` order):

1. `skinSmooth`, `skinWhiten`, `teethWhiten` — retouching on original geometry,
   so landmark-derived masks line up.
2. `faceReshape` — landmark-driven warps.
3. `adjust`, `filter` — global tone/colour and LUT looks.
4. `sharpen`, `vignette`, `grain` — finishing.
5. `transform` — rotate, flip, crop (the only stage that changes size). The
   renderer applies the crop before every other stage and rotate/flip after
   them (see Rendering).

Each layer has `enabled` and `opacity`; the renderer skips disabled/identity
layers and blends `opacity` itself (passes never do). `faceReshape` is faded by
scaling its parameters instead, since blending a warp with its input would
show both geometries. Face-dependent kinds (`teethWhiten`, `faceReshape`) are
skipped when no face was detected; `skinSmooth`/`skinWhiten` fall back to a
colour-based skin mask.

## Rendering

`Renderer` (src/engine/renderer.ts) owns a `Gpu`, the source texture and the
face analysis. Preview renders at roughly screen resolution; export renders at
full resolution. A pass therefore sees `env.scale` (working px per source px)
and **must express sizes resolution-independently** (relative to the image
diagonal or the face size) so preview and export match.

Crop first: when the transform layer crops, the renderer maps the crop (defined
after rotate and flip) back to a rectangle of the source, which is exact for
quarter turns and flips, and builds the working image from that region alone,
resampled straight to the working size. Every stage then runs on the final
frame: `env.width`/`env.height` are the crop's working size, `env.face` is the
analysis remapped into the crop (landmarks may lie outside 0..1), and frame
effects such as the vignette are centred on what the user sees. Rotate and flip
run last, so passes always see the source orientation. Passes that read their
input at their own pixel (colour, sharpen, the blur taps, the opacity mix) use
`texelFetch`, so a full-resolution crop is pixel-identical to that part of the
uncropped photo, except within a blur radius, mask feather or warp of the crop
edge: nothing outside the crop is rendered, so there the edge pixels repeat.
Sizes that belong to the photo rather than the frame use `env.sourceDiagonal`,
the uncropped diagonal in source pixels: film grain cells are 1..4 px of a
photo with a 3000 px diagonal and scale with it, so a setting looks the same on
any photo and any crop. Where a working image has fewer pixels than that
reference (previews, small photos), grain shows what downsampling
reference-resolution grain would show.

Scales are in source-texture pixels. Sources larger than `MAX_TEXTURE_SIZE` are
downscaled on upload; `measureOutput` reports the size of the uploaded texture,
previews render at canvas size and `renderToPixels({ maxSize })` honours
`maxSize`. `env.scale` stays relative to the original pixels.

Caches: the working image and `env.cache` are kept per frame (source, analysis,
crop and working size). Previews also keep the texture entering the first layer
that changed since the previous preview, keyed by that frame and every earlier
layer's id, kind, opacity and params, so dragging a late slider does not re-run
the layers before it. Only one such texture is kept; it is dropped when the
source, analysis or a custom LUT changes. `renderToPixels` releases what it
built for its own frame and empties the target pool, so no full-resolution
temporaries stay allocated after an export. The pool itself is bounded in
count and bytes.

Coordinate convention: `v_uv = (0,0)` is the image's top-left and y grows
downwards inside render targets — identical to normalised landmark coordinates,
so `face.landmarks[i]` can be used directly as uv in every stage before
`transform`. Remember aspect ratio when measuring distances in uv
(multiply x by width/height or work in pixels).

Textures are RGBA8, linear filtered, clamp-to-edge, straight alpha; the canvas
is non-premultiplied too, so transparent pixels show the page behind it. Use
`env.gpu.acquire/release` for temporaries and `env.cache.get` for resources
derived from the source/face (cleared automatically when those change).
`gaussianBlur` runs blurs wider than 4 px on a copy reduced by successive
halving, compensating the blur the reduction itself adds.

## Filter looks

Required built-in look ids (the looks module must provide all of them; presets
and UI may reference them):

`original`, `natural`, `fresh`, `warm`, `cool`, `film`, `film-fade`,
`portrait-soft`, `rosy`, `japanese`, `vivid`, `cinematic`, `retro`, `mono`,
`mono-contrast`, `sepia`.

All looks, presets and tuning values are original work. OpenMeitu is a
clean-room project: never copy code, shaders, LUTs, masks, models or preset
values from proprietary products.

## Testing

- `npm test` — unit tests (Vitest, node).
- `npm run test:e2e` — Playwright against the dev server; GPU code runs through
  `/harness.html` (`window.omHarness.render`) with SwiftShader WebGL2.
- `npm run fixtures:faces` — regenerate cached landmarks for the fixtures.
