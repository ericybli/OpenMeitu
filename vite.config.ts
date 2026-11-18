import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Content-Security-Policy: the app never talks to any server but its own
 * origin. This also blocks the usage logging that @mediapipe/tasks-vision
 * sends to Google (odml.pa.googleapis.com) and cannot be switched off.
 * 'wasm-unsafe-eval' is needed to compile the MediaPipe WebAssembly runtime.
 */
const CSP_COMMON = [
  "default-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' blob: data:",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
];
const CSP_BUILD = [...CSP_COMMON, "script-src 'self' 'wasm-unsafe-eval'", "connect-src 'self' blob: data:"].join('; ');
// Dev needs Vite's inline React-refresh preamble and the HMR websocket.
const CSP_DEV = [
  ...CSP_COMMON,
  "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'",
  "connect-src 'self' ws: blob: data:",
].join('; ');

function contentSecurityPolicy(): Plugin {
  return {
    name: 'openmeitu:csp',
    apply: 'build',
    transformIndexHtml: {
      order: 'post',
      handler: () => [
        { tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: CSP_BUILD }, injectTo: 'head-prepend' },
      ],
    },
  };
}

// `base: './'` keeps the build portable (GitHub Pages, file hosting, Tauri).
export default defineConfig({
  base: './',
  plugins: [react(), contentSecurityPolicy()],
  build: {
    // Licences of every bundled npm dependency (React etc.), shipped next to the app.
    license: { fileName: 'THIRD_PARTY_LICENSES.md' },
  },
  server: { port: 5179, strictPort: true, headers: { 'Content-Security-Policy': CSP_DEV } },
  preview: { port: 5179, strictPort: true },
});
