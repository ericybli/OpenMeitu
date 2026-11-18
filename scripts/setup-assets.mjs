// Copies MediaPipe wasm runtime files and downloads the Face Landmarker model
// into public/ so the app runs fully offline (no CDN at runtime).
// Model: MediaPipe Face Landmarker, Apache-2.0, https://ai.google.dev/edge/mediapipe/solutions/vision/face_landmarker
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const wasmSrc = join(root, 'node_modules', '@mediapipe', 'tasks-vision', 'wasm');
const wasmDst = join(root, 'public', 'mediapipe', 'wasm');
const modelDst = join(root, 'public', 'models', 'face_landmarker.task');
const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';

async function exists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

// Only the classic (non-module) runtime is loaded by FilesetResolver.forVisionTasks();
// the 15 MB "module" variant is never requested, so it is not shipped.
const WASM_FILES = ['vision_wasm_internal.js', 'vision_wasm_internal.wasm'];
await mkdir(wasmDst, { recursive: true });
for (const name of await readdir(wasmDst)) {
  if (!WASM_FILES.includes(name)) await rm(join(wasmDst, name), { recursive: true, force: true });
}
for (const name of WASM_FILES) await copyFile(join(wasmSrc, name), join(wasmDst, name));
console.log('[assets] mediapipe wasm -> public/mediapipe/wasm');

if (await exists(modelDst)) {
  console.log('[assets] face_landmarker.task already present');
} else {
  await mkdir(dirname(modelDst), { recursive: true });
  console.log(`[assets] downloading ${MODEL_URL}`);
  const res = await fetch(MODEL_URL);
  if (!res.ok) throw new Error(`Model download failed: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 1_000_000) throw new Error(`Model download looks truncated (${buf.length} bytes)`);
  await writeFile(`${modelDst}.part`, buf);
  await rename(`${modelDst}.part`, modelDst);
  const sha = createHash('sha256').update(await readFile(modelDst)).digest('hex');
  console.log(`[assets] face_landmarker.task ${buf.length} bytes sha256=${sha}`);
}
