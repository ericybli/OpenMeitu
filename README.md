# OpenMeitu

**The open-source alternative to Meitu Xiuxiu, Facetune, and BeautyPlus.**

OpenMeitu is a portrait and photo editor that runs entirely in your browser.
Skin retouching, face reshaping, colour filters and crop all happen on your
device, on the GPU. Your photos are never uploaded anywhere.

> Status: early preview (v0.1). The editing engine, beauty tools and editor UI
> work end to end; expect rough edges.

## Features

**Beauty (美颜)**
- Skin smoothing with a "keep texture" control, so skin doesn't look plastic.
  It uses an edge-preserving filter that leaves eyes, brows, lips and hair sharp.
- Skin brightening (美白) and teeth whitening (美牙).
- Face reshaping: slim face, bigger eyes, slim nose, shorter or longer chin.
  These are landmark-driven warps that never fold the image.
- Group photos: up to 8 faces are detected, down to about 6% of the photo's
  long edge, and each one is retouched and reshaped at its own scale.

**Colour and effects**
- Adjust: exposure, contrast, highlights, shadows, saturation, vibrance,
  temperature and tint.
- 16 original filter looks in 6 categories (natural, portrait, film, vivid,
  mono, creative), each with an intensity slider.
- Import your own `.cube` 3D LUTs (Adobe / Resolve format).
- Sharpen (luminance only), vignette and film grain.
- Effects look the same in the preview and in the full-resolution export.

**Workflow**
- Non-destructive edits. Every change is a layer you can toggle, fade
  (opacity) or remove.
- Undo and redo; one slider drag is one undo step.
- Hold to compare with the original.
- Crop with aspect presets, rotate and flip.
- Six one-tap presets that keep your face-shape edits. Save and share your own
  presets as JSON.
- Export full-resolution JPEG or PNG (PNG keeps transparency).
- English and 简体中文 UI.

## Privacy

- No uploads, accounts, analytics or tracking. Your photos are processed in
  the browser tab and never leave your device.
- Face detection is [MediaPipe Face Landmarker](https://ai.google.dev/edge/mediapipe/solutions/vision/face_landmarker).
  It runs locally in WebAssembly, and the model and runtime are served by the
  app itself, not by a third-party CDN.
- A Content-Security-Policy restricts the app to its own origin. It also
  blocks the usage-statistics ping that the MediaPipe library would otherwise
  send to Google. This is enforced by an end-to-end test
  (`tests/e2e/privacy.spec.ts`).
- The production build is a static site with no server-side code.

## Quick start

Requirements: Node.js 24+ and a browser with WebGL2 (any current Chrome, Edge,
Firefox or Safari).

```bash
git clone https://github.com/ericybli/OpenMeitu.git
cd OpenMeitu
npm install
npm run dev        # http://localhost:5179
```

The first `dev`/`build` copies the MediaPipe WebAssembly runtime into `public/`
and downloads the Face Landmarker model (~3.7 MB) from Google's model storage
(`scripts/setup-assets.mjs`).

```bash
npm run build      # static site in dist/ (relative paths; host it anywhere)
npm run preview    # serve dist/ locally
```

## Development

```bash
npm run typecheck
npm test           # unit tests (Vitest)
npm run test:e2e   # end-to-end tests (Playwright; real WebGL2 via SwiftShader)
```

The GPU passes are tested pixel by pixel in headless Chromium through a
test-only page (`harness.html`). The app's flows are tested in the real UI.
CI runs all of it on every push (`.github/workflows/ci.yml`).

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the module map, the layer
model, rendering conventions and how to add an effect.

```
src/engine   editing engine: layer model, undo, presets, WebGL2 renderer + passes
src/face     face detection, landmark regions, skin/teeth masks, reshape warp
src/filters  colour science, built-in looks, .cube import/export
src/app      editor state (history, file IO, export, thumbnails)
src/ui       React UI, styles, i18n
```

## Roadmap

- Desktop app (Tauri) and installable PWA
- Background blur and replacement (portrait segmentation)
- Blemish and spot removal (healing / inpainting)
- Makeup: lips, blush, brows
- Batch editing with presets
- WebGPU backend; HEIC decoding in every browser

Contributions are welcome. Please open an issue to discuss larger changes first.

## Clean-room policy

OpenMeitu is an independent, clean-room implementation. It contains no code,
shaders, LUTs, masks, models, presets or other assets from Meitu, Lightricks
(Facetune), BeautyPlus or any other proprietary product. All algorithms,
filter looks and preset values are original work or come from openly licensed
projects credited below. Contributions must follow the same rule: don't submit
anything derived from decompiled, decrypted or otherwise proprietary material.

OpenMeitu is not affiliated with, endorsed by, or sponsored by Meitu, Inc.,
Lightricks Ltd., or the makers of BeautyPlus. All product names and trademarks
belong to their respective owners and are used only to describe compatibility
of purpose.

## License

[Apache License 2.0](LICENSE).

Every build ships `THIRD_PARTY_NOTICES.txt` (MediaPipe runtime and model) and
`THIRD_PARTY_LICENSES.md` (bundled npm packages) next to `index.html`.

Third-party components:
- [MediaPipe Tasks Vision](https://github.com/google-ai-edge/mediapipe)
  WebAssembly runtime: Apache-2.0, © The MediaPipe Authors (Google LLC).
- MediaPipe Face Landmarker model: provided by Google as part of MediaPipe
  Solutions; see its [model card](https://ai.google.dev/edge/mediapipe/solutions/vision/face_landmarker).
  It is downloaded at setup time and not stored in this repository.
- [React](https://react.dev), React DOM and scheduler: MIT.
- Test photos in `tests/fixtures/`: NASA, public domain (see
  [tests/fixtures/README.md](tests/fixtures/README.md)).
