import { mkdirSync, readFileSync } from 'node:fs';
import { crc32, deflateSync, inflateSync } from 'node:zlib';
import { expect, test, type Page } from '@playwright/test';

const PORTRAIT = 'tests/fixtures/portrait-a.jpg';
// Screenshots for design review; override the folder with APP_SCREENSHOT_DIR.
const SHOTS = process.env.APP_SCREENSHOT_DIR ?? 'test-results/app';

mkdirSync(SHOTS, { recursive: true });

declare global {
  interface Window {
    __omSnapshots?: Map<string, Uint8ClampedArray>;
    __omInputEvents?: number;
    __omLoseContext?: WEBGL_lose_context;
  }
}

/**
 * MediaPipe's wasm runtime prints informational TFLite ("INFO: ...") and glog
 * ("I1118 00:33:34.734 ...", "W...") lines on stderr, which surface as console errors.
 */
function isMediaPipeInfo(text: string): boolean {
  return /^(INFO: |[IW]\d{4} \d{2}:\d{2}:\d{2})/.test(text);
}

/**
 * MediaPipe uploads usage statistics about a minute after the detector starts; the
 * Content-Security-Policy blocks that request and logs the violation (see privacy.spec.ts).
 */
function isBlockedTelemetry(text: string): boolean {
  return /Content Security Policy/.test(text) && /\/\/odml\.pa\.googleapis\.com\//.test(text);
}

/** Collects console errors and uncaught exceptions for the lifetime of the page. */
function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (msg) => {
    const text = msg.text();
    if (msg.type() === 'error' && !isMediaPipeInfo(text) && !isBlockedTelemetry(text)) errors.push(text);
  });
  page.on('pageerror', (err) => errors.push(err.message));
  return errors;
}

async function openApp(page: Page, language: 'en' | 'zh' = 'en'): Promise<void> {
  await page.addInitScript((lang) => {
    try {
      localStorage.setItem('openmeitu.language', lang);
    } catch {
      // ignore: the app falls back to the browser locale
    }
  }, language);
  await page.goto('/');
  await expect(page.getByTestId('drop-zone')).toBeVisible();
}

async function openPortrait(page: Page): Promise<void> {
  await page.getByTestId('file-input').setInputFiles(PORTRAIT);
  await expect(page.getByTestId('editor-canvas')).toBeVisible();
  await expect(page.getByTestId('face-status')).toHaveAttribute('data-status', 'found', { timeout: 60_000 });
}

/** Wait until queued preview frames have been drawn. */
async function settle(page: Page): Promise<void> {
  await page.evaluate(
    () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
  );
}

/** Store the current preview pixels in the page under `name`; returns the canvas size. */
async function snapshot(page: Page, name: string): Promise<{ width: number; height: number }> {
  await settle(page);
  return page.evaluate((key) => {
    const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="editor-canvas"]');
    if (!canvas) throw new Error('no preview canvas');
    const copy = document.createElement('canvas');
    copy.width = canvas.width;
    copy.height = canvas.height;
    const ctx = copy.getContext('2d');
    if (!ctx) throw new Error('no 2d context');
    ctx.drawImage(canvas, 0, 0);
    window.__omSnapshots ??= new Map();
    window.__omSnapshots.set(key, ctx.getImageData(0, 0, copy.width, copy.height).data);
    return { width: canvas.width, height: canvas.height };
  }, name);
}

/** Mean absolute RGB difference (0..255) between two stored snapshots of the same size. */
async function snapshotDiff(page: Page, a: string, b: string): Promise<number> {
  return page.evaluate(
    ([ka, kb]) => {
      const pa = window.__omSnapshots?.get(ka);
      const pb = window.__omSnapshots?.get(kb);
      if (!pa || !pb) throw new Error('missing snapshot');
      if (pa.length !== pb.length) return Number.POSITIVE_INFINITY;
      let sum = 0;
      for (let i = 0; i < pa.length; i += 4) {
        sum += Math.abs(pa[i]! - pb[i]!) + Math.abs(pa[i + 1]! - pb[i + 1]!) + Math.abs(pa[i + 2]! - pb[i + 2]!);
      }
      return sum / ((pa.length / 4) * 3);
    },
    [a, b] as const,
  );
}

/** Width/height of a baseline JPEG from its SOF marker. */
function jpegSize(bytes: Buffer): { width: number; height: number } {
  expect(bytes[0]).toBe(0xff);
  expect(bytes[1]).toBe(0xd8);
  let i = 2;
  while (i + 9 < bytes.length) {
    if (bytes[i] !== 0xff) {
      i++;
      continue;
    }
    const marker = bytes[i + 1]!;
    if (marker === 0xff || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      i += 2;
      continue;
    }
    const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrame) return { height: bytes.readUInt16BE(i + 5), width: bytes.readUInt16BE(i + 7) };
    i += 2 + bytes.readUInt16BE(i + 2);
  }
  throw new Error('no SOF marker found');
}

/** Width/height of a PNG from its IHDR chunk. */
function pngSize(bytes: Buffer): { width: number; height: number } {
  expect([...bytes.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  expect(bytes.toString('latin1', 12, 16)).toBe('IHDR');
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function pngChunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

/** Encode straight-alpha RGBA pixels as an 8-bit RGBA PNG. */
function encodePng(width: number, height: number, rgba: Uint8Array): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // colour type RGBA
  const stride = width * 4;
  const rows = Buffer.alloc((stride + 1) * height); // filter byte 0 (none) before each row
  for (let y = 0; y < height; y++) rows.set(rgba.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(rows)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Decode a non-interlaced 8-bit RGBA PNG into straight-alpha RGBA pixels. */
function decodePng(bytes: Buffer): { width: number; height: number; data: Uint8Array } {
  const { width, height } = pngSize(bytes);
  expect([bytes[24], bytes[25], bytes[28]]).toEqual([8, 6, 0]);
  const idat: Buffer[] = [];
  for (let i = PNG_SIGNATURE.length; i < bytes.length; i += 12 + bytes.readUInt32BE(i)) {
    if (bytes.toString('latin1', i + 4, i + 8) === 'IDAT') idat.push(bytes.subarray(i + 8, i + 8 + bytes.readUInt32BE(i)));
  }
  const rows = inflateSync(Buffer.concat(idat));
  const stride = width * 4;
  const data = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = rows[y * (stride + 1)]!;
    for (let x = 0; x < stride; x++) {
      const left = x >= 4 ? data[y * stride + x - 4]! : 0;
      const up = y > 0 ? data[(y - 1) * stride + x]! : 0;
      const upLeft = x >= 4 && y > 0 ? data[(y - 1) * stride + x - 4]! : 0;
      const p = left + up - upLeft;
      const paeth =
        Math.abs(p - left) <= Math.abs(p - up) && Math.abs(p - left) <= Math.abs(p - upLeft)
          ? left
          : Math.abs(p - up) <= Math.abs(p - upLeft)
            ? up
            : upLeft;
      const predictor = [0, left, up, (left + up) >> 1, paeth][filter]!;
      data[y * stride + x] = (rows[y * (stride + 1) + 1 + x]! + predictor) & 0xff;
    }
  }
  return { width, height, data };
}

/** A PNG file for `setInputFiles`; `pixel` gives each pixel's straight-alpha RGBA. */
function pngFile(name: string, width: number, height: number, pixel: (x: number, y: number) => readonly number[]) {
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) rgba.set(pixel(x, y), (y * width + x) * 4);
  return { name, mimeType: 'image/png', buffer: encodePng(width, height, rgba) };
}

async function downloadExport(page: Page, format: 'jpeg' | 'png'): Promise<{ name: string; bytes: Buffer }> {
  await page.getByTestId('export-button').click();
  await page.getByTestId(`export-format-${format}`).click();
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('export-download').click()]);
  return { name: download.suggestedFilename(), bytes: readFileSync(await download.path()) };
}

async function exportImage(page: Page, format: 'jpeg' | 'png'): Promise<{ name: string; width: number; height: number }> {
  const { name, bytes } = await downloadExport(page, format);
  const size = format === 'jpeg' ? jpegSize(bytes) : pngSize(bytes);
  return { name, ...size };
}

const exportJpeg = (page: Page) => exportImage(page, 'jpeg');

/** Drag a range input's thumb from its current position by `fraction` of the track, in several pointer moves. */
async function dragSlider(page: Page, testId: string, fraction: number): Promise<void> {
  const slider = page.getByTestId(testId);
  const box = await slider.boundingBox();
  expect(box).not.toBeNull();
  const value = Number(await slider.inputValue());
  const { min, max } = await slider.evaluate((el: HTMLInputElement) => ({ min: Number(el.min), max: Number(el.max) }));
  const thumb = 8; // half the thumb width: the track runs between the thumb centres
  const x = box!.x + thumb + ((value - min) / (max - min)) * (box!.width - 2 * thumb);
  const y = box!.y + box!.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + fraction * (box!.width - 2 * thumb), y, { steps: 8 });
  await page.mouse.up();
}

test('loads with no console errors and shows the empty state', async ({ page }) => {
  const errors = watchErrors(page);
  await openApp(page);
  await expect(page.getByTestId('privacy-tagline')).toHaveText('Your photos never leave your device');
  await expect(page.getByTestId('undo-button')).toBeDisabled();
  await expect(page.getByTestId('export-button')).toBeDisabled();
  await page.screenshot({ path: `${SHOTS}/desktop-empty.png` });
  expect(errors).toEqual([]);
});

test('edits a portrait: beauty, undo, filters, crop and export', async ({ page }) => {
  const errors = watchErrors(page);
  await openApp(page);
  await openPortrait(page);
  const base = await snapshot(page, 'base');
  expect(base.height).toBeGreaterThan(base.width);

  // Smooth slider: one keyboard gesture = one undo step.
  const smooth = page.getByTestId('slider-skinSmooth-amount');
  await smooth.focus();
  await smooth.press('End');
  await expect(smooth).toHaveValue('1');
  await expect(page.getByTestId('edit-skinSmooth')).toBeVisible();
  await snapshot(page, 'smooth');
  expect(await snapshotDiff(page, 'base', 'smooth')).toBeGreaterThan(0.2);
  await page.screenshot({ path: `${SHOTS}/desktop-beauty.png` });

  // Holding Space shows the original.
  await page.keyboard.down('Space');
  await expect(page.getByTestId('compare-button')).toHaveAttribute('aria-pressed', 'true');
  await snapshot(page, 'compare');
  expect(await snapshotDiff(page, 'base', 'compare')).toBeLessThan(0.05);
  await page.keyboard.up('Space');
  await expect(page.getByTestId('compare-button')).toHaveAttribute('aria-pressed', 'false');

  await page.keyboard.press('ControlOrMeta+z');
  await expect(smooth).toHaveValue('0');
  await snapshot(page, 'undone');
  expect(await snapshotDiff(page, 'base', 'undone')).toBeLessThan(0.05);
  await expect(page.getByTestId('redo-button')).toBeEnabled();

  // Filters: thumbnails render, and choosing a look changes the preview.
  await page.getByTestId('tool-filters').click();
  const film = page.getByTestId('look-film');
  await expect(film.locator('img')).toBeVisible();
  // An opaque photo gets compact JPEG tiles.
  await expect(film.locator('img')).toHaveAttribute('src', /^data:image\/jpeg;/);
  await film.click();
  await expect(film).toHaveAttribute('aria-pressed', 'true');
  // A newly picked look is applied at full strength, as its tile shows it.
  await expect(page.getByTestId('slider-filter-intensity')).toHaveValue('1');
  await expect(page.getByTestId('edit-filter')).toBeVisible();
  await snapshot(page, 'film');
  expect(await snapshotDiff(page, 'base', 'film')).toBeGreaterThan(1);
  // Every tile gets its own rendered thumbnail.
  const grid = page.getByTestId('look-grid');
  await expect(grid.locator('.skeleton')).toHaveCount(0);
  await expect(grid.locator('img')).toHaveCount(await grid.locator('button').count());
  await page.screenshot({ path: `${SHOTS}/desktop-filters.png` });

  // Export at full resolution before any geometry change.
  const portrait = await exportJpeg(page);
  expect(portrait).toEqual({ name: 'portrait-a-openmeitu.jpg', width: 640, height: 800 });

  // Crop panel: rotating 90° turns the portrait preview into a landscape one.
  await page.getByTestId('tool-crop').click();
  await expect(page.getByTestId('crop-overlay')).toBeVisible();
  await page.getByTestId('crop-rotate-right').click();
  await expect
    .poll(async () => {
      const s = await snapshot(page, 'rotated');
      return s.width / s.height;
    })
    .toBeGreaterThan(1);
  await page.getByTestId('crop-aspect-1:1').click();
  await expect(page.getByTestId('crop-aspect-1:1')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('crop-output-size')).toContainText('640 × 640');

  // Dragging a corner keeps the locked 1:1 aspect and shrinks the output.
  const corner = await page.getByTestId('crop-handle-se').boundingBox();
  expect(corner).not.toBeNull();
  // Grab just inside the frame corner (the handle's centre sits on the image edge).
  const start = { x: corner!.x + corner!.width / 2 - 4, y: corner!.y + corner!.height / 2 - 4 };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x - 60, start.y - 40, { steps: 4 });
  await page.mouse.up();
  const outputSize = async () => {
    const match = /(\d+) × (\d+)/.exec((await page.getByTestId('crop-output-size').textContent()) ?? '');
    return match ? { width: Number(match[1]), height: Number(match[2]) } : { width: 0, height: 0 };
  };
  await expect.poll(async () => (await outputSize()).width).toBeLessThan(640);
  const cropped = await outputSize();
  expect(Math.abs(cropped.width - cropped.height)).toBeLessThanOrEqual(1);
  await page.screenshot({ path: `${SHOTS}/desktop-crop.png` });

  // One drag = one undo step; two undos remove the drag and the 1:1 crop.
  await page.getByTestId('undo-button').click();
  await expect(page.getByTestId('crop-output-size')).toContainText('640 × 640');
  await page.getByTestId('undo-button').click();
  await expect(page.getByTestId('crop-output-size')).toContainText('800 × 640');

  const landscape = await exportJpeg(page);
  expect(landscape).toEqual({ name: 'portrait-a-openmeitu.jpg', width: 800, height: 640 });

  // Free aspect: an edge can be grabbed anywhere along its length, not only at its grip.
  await page.getByTestId('crop-aspect-free').click();
  const frame = await page.getByTestId('crop-frame').boundingBox();
  expect(frame).not.toBeNull();
  const grab = { x: frame!.x + 4, y: frame!.y + frame!.height * 0.2 };
  await page.mouse.move(grab.x, grab.y);
  await page.mouse.down();
  await page.mouse.move(grab.x + 80, grab.y + 30, { steps: 4 });
  await page.mouse.up();
  await expect.poll(async () => (await outputSize()).width).toBeLessThan(800);
  expect((await outputSize()).height).toBe(640);

  expect(errors).toEqual([]);
});

test('a slider drag is one undo step; redo and PNG export work', async ({ page }) => {
  const errors = watchErrors(page);
  await openApp(page);
  await openPortrait(page);
  await page.getByTestId('tool-adjust').click();
  await snapshot(page, 'base');

  await page.getByTestId('slider-adjust-exposure').evaluate((el) => {
    window.__omInputEvents = 0;
    el.addEventListener('input', () => (window.__omInputEvents = (window.__omInputEvents ?? 0) + 1));
  });
  await dragSlider(page, 'slider-adjust-exposure', 0.3);
  const exposure = await page.getByTestId('slider-adjust-exposure').inputValue();
  expect(Number(exposure)).toBeGreaterThan(0.5);
  // The drag produced many intermediate values, yet only one undo step.
  expect(await page.evaluate(() => window.__omInputEvents ?? 0)).toBeGreaterThan(2);

  await dragSlider(page, 'slider-adjust-contrast', 0.2);
  const contrast = await page.getByTestId('slider-adjust-contrast').inputValue();
  expect(Number(contrast)).toBeGreaterThan(0.2);
  await snapshot(page, 'edited');
  expect(await snapshotDiff(page, 'base', 'edited')).toBeGreaterThan(5);

  await page.keyboard.press('ControlOrMeta+z');
  await expect(page.getByTestId('slider-adjust-contrast')).toHaveValue('0');
  await expect(page.getByTestId('slider-adjust-exposure')).toHaveValue(exposure);
  await page.keyboard.press('ControlOrMeta+z');
  await expect(page.getByTestId('slider-adjust-exposure')).toHaveValue('0');
  await expect(page.getByTestId('undo-button')).toBeDisabled();

  await page.keyboard.press('ControlOrMeta+Shift+z');
  await expect(page.getByTestId('slider-adjust-exposure')).toHaveValue(exposure);
  await page.keyboard.press('Control+y');
  await expect(page.getByTestId('slider-adjust-contrast')).toHaveValue(contrast);
  await expect(page.getByTestId('redo-button')).toBeDisabled();
  await snapshot(page, 'redone');
  expect(await snapshotDiff(page, 'edited', 'redone')).toBeLessThan(0.05);
  await page.screenshot({ path: `${SHOTS}/desktop-adjust.png` });

  expect(await exportImage(page, 'png')).toEqual({ name: 'portrait-a-openmeitu.png', width: 640, height: 800 });
  expect(errors).toEqual([]);
});

test('recovers the preview after the GPU context is lost', async ({ page }) => {
  const errors = watchErrors(page);
  await openApp(page);
  await openPortrait(page);
  const smooth = page.getByTestId('slider-skinSmooth-amount');
  await smooth.focus();
  await smooth.press('End');
  await snapshot(page, 'before');

  await page.getByTestId('editor-canvas').evaluate((canvas: HTMLCanvasElement) => {
    const ext = canvas.getContext('webgl2')?.getExtension('WEBGL_lose_context');
    if (!ext) throw new Error('WEBGL_lose_context unavailable');
    window.__omLoseContext = ext;
    ext.loseContext();
  });
  await expect(page.getByTestId('toast').last()).toContainText('graphics processor was reset');
  await page.evaluate(() => window.__omLoseContext?.restoreContext());

  // The rebuilt renderer shows the same edit, and further edits and export still work.
  await expect
    .poll(async () => {
      await snapshot(page, 'restored');
      return snapshotDiff(page, 'before', 'restored');
    })
    .toBeLessThan(0.05);
  await page.getByTestId('tool-filters').click();
  await page.getByTestId('look-mono').click();
  await snapshot(page, 'mono');
  expect(await snapshotDiff(page, 'before', 'mono')).toBeGreaterThan(1);
  expect(await exportJpeg(page)).toEqual({ name: 'portrait-a-openmeitu.jpg', width: 640, height: 800 });
  expect(errors).toEqual([]);
});

test('applies built-in presets and imports presets and LUTs', async ({ page }) => {
  const errors = watchErrors(page);
  await openApp(page);
  await openPortrait(page);
  await snapshot(page, 'base');
  await page.getByTestId('tool-presets').click();

  await page.getByTestId('preset-0').click();
  await expect(page.getByTestId('edits-list').locator('li')).not.toHaveCount(0);
  await expect(page.getByTestId('toast').last()).toContainText('Applied');

  // A preset with an unknown layer kind still imports, with the warning listed.
  const preset = {
    format: 'openmeitu.preset',
    version: 1,
    name: 'Bright',
    layers: [
      { kind: 'adjust', params: { exposure: 0.6 } },
      { kind: 'sparkles', params: {} },
    ],
  };
  await page.getByTestId('preset-import-input').setInputFiles({
    name: 'bright.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(preset)),
  });
  await expect(page.getByTestId('preset-warnings')).toContainText('sparkles');
  await expect(page.getByTestId('edit-adjust')).toBeVisible();
  await expect(page.getByTestId('edit-skinSmooth')).toHaveCount(0);

  // A 2x2x2 .cube that inverts colours becomes the active filter.
  const cube = ['TITLE "Invert"', 'LUT_3D_SIZE 2'];
  for (let b = 0; b < 2; b++) for (let g = 0; g < 2; g++) for (let r = 0; r < 2; r++) cube.push(`${1 - r} ${1 - g} ${1 - b}`);
  await page.getByTestId('lut-import-input').setInputFiles({
    name: 'invert.cube',
    mimeType: 'text/plain',
    buffer: Buffer.from(cube.join('\n')),
  });
  await expect(page.getByTestId('edit-filter')).toContainText('Invert');
  await snapshot(page, 'inverted');
  expect(await snapshotDiff(page, 'base', 'inverted')).toBeGreaterThan(40);

  await page.getByTestId('tool-filters').click();
  await expect(page.getByTestId(/^look-custom:/)).toHaveAttribute('aria-pressed', 'true');

  // Exporting the current edit as a preset downloads JSON that parses back.
  await page.getByTestId('tool-presets').click();
  await page.getByTestId('preset-name').fill('My look');
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('preset-export').click()]);
  expect(download.suggestedFilename()).toBe('My look.json');
  // The imported LUT itself is not part of the preset file.
  await expect(page.getByTestId('toast').last()).toContainText('Share the .cube file');
  const saved = JSON.parse(readFileSync(await download.path(), 'utf8')) as { format: string; name: string; layers: { kind: string }[] };
  expect(saved.format).toBe('openmeitu.preset');
  expect(saved.name).toBe('My look');
  expect(saved.layers.map((l) => l.kind)).toEqual(['adjust', 'filter']);
  await page.screenshot({ path: `${SHOTS}/desktop-presets.png` });
  expect(errors).toEqual([]);
});

test('exports translucent photos faithfully: PNG keeps alpha, JPEG is flattened onto white', async ({ page }) => {
  const errors = watchErrors(page);
  await openApp(page);
  // One colour with alpha rising from 0 to 255 across the width.
  const color = [200, 120, 40] as const;
  const fade = pngFile('fade.png', 256, 16, (x) => [...color, x]);
  await page.getByTestId('file-input').setInputFiles(fade);
  await expect(page.getByTestId('editor-canvas')).toBeVisible();

  const source = decodePng(fade.buffer);
  const png = decodePng((await downloadExport(page, 'png')).bytes);
  expect([png.width, png.height]).toEqual([256, 16]);
  let maxError = 0;
  for (let i = 0; i < source.data.length; i++) maxError = Math.max(maxError, Math.abs(png.data[i]! - source.data[i]!));
  expect(maxError).toBeLessThanOrEqual(1);

  const jpeg = await downloadExport(page, 'jpeg');
  const blocks = [0, 120, 240];
  const means = await page.evaluate(
    async ({ base64, xs }) => {
      const bytes = Uint8Array.from(atob(base64), (ch) => ch.charCodeAt(0));
      const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }));
      const ctx = new OffscreenCanvas(bitmap.width, bitmap.height).getContext('2d')!;
      ctx.drawImage(bitmap, 0, 0);
      return xs.map((x) => {
        const d = ctx.getImageData(x, 0, 16, 16).data;
        const sum = [0, 0, 0];
        for (let i = 0; i < d.length; i += 4) for (let c = 0; c < 3; c++) sum[c] = sum[c]! + d[i + c]!;
        return sum.map((v) => v / (d.length / 4));
      });
    },
    { base64: jpeg.bytes.toString('base64'), xs: blocks },
  );
  blocks.forEach((x, k) => {
    const alpha = (x + 7.5) / 255; // mean alpha of the 16 px wide block
    const expected = color.map((c) => c * alpha + 255 * (1 - alpha));
    means[k]!.forEach((value, c) => expect(Math.abs(value - expected[c]!)).toBeLessThan(6));
  });

  // Filter tiles keep the transparency as well, rather than showing it black.
  await page.getByTestId('tool-filters').click();
  await expect(page.getByTestId('look-original').locator('img')).toHaveAttribute('src', /^data:image\/png;/);
  expect(errors).toEqual([]);
});

test('asks before another photo or leaving the page discards edits', async ({ page }) => {
  const errors = watchErrors(page);
  await openApp(page);
  await openPortrait(page);
  const smooth = page.getByTestId('slider-skinSmooth-amount');
  await smooth.focus();
  await smooth.press('End');
  await expect(page.getByTestId('edit-skinSmooth')).toBeVisible();

  const other = pngFile('other.png', 64, 48, () => [90, 120, 150, 255]);
  const confirmations: string[] = [];
  page.once('dialog', (dialog) => {
    confirmations.push(dialog.message());
    void dialog.dismiss();
  });
  await page.getByTestId('file-input').setInputFiles(other);
  await expect.poll(() => confirmations).toEqual(['Open “other.png”? Your edits to the current photo will be discarded.']);
  await expect(page).toHaveTitle('portrait-a.jpg · OpenMeitu');
  await expect(page.getByTestId('edit-skinSmooth')).toBeVisible();

  page.once('dialog', (dialog) => void dialog.accept());
  await page.getByTestId('file-input').setInputFiles(other);
  await expect(page).toHaveTitle('other.png · OpenMeitu');
  await expect(page.getByTestId('edits-list')).toHaveCount(0);

  await smooth.focus();
  await smooth.press('End');
  await expect(page.getByTestId('edit-skinSmooth')).toBeVisible();
  expect(errors).toEqual([]);
  const leaving = page.waitForEvent('dialog');
  await page.close({ runBeforeUnload: true });
  const dialog = await leaving;
  expect(dialog.type()).toBe('beforeunload');
  await dialog.accept();
});

test('toasts stay while hovered or focused, and hand focus back when dismissed', async ({ page }) => {
  const errors = watchErrors(page);
  await openApp(page);
  await page.getByTestId('file-input').setInputFiles(pngFile('flat.png', 64, 48, () => [90, 120, 150, 255]));
  await page.getByTestId('tool-presets').click();
  const exportPreset = page.getByTestId('preset-export');
  const toast = page.getByTestId('toast');
  const successToastMs = 3500;

  await exportPreset.click();
  await expect(toast).toHaveCount(1);
  await toast.hover();
  await page.waitForTimeout(successToastMs + 1000);
  await expect(toast).toHaveCount(1);
  await page.mouse.move(0, 0);
  await expect(toast).toHaveCount(0);

  await exportPreset.focus();
  await page.keyboard.press('Enter');
  await expect(toast).toHaveCount(1);
  await page.getByTestId('toast-dismiss').focus();
  await page.waitForTimeout(successToastMs + 1000);
  await expect(toast).toHaveCount(1);
  await page.keyboard.press('Enter');
  await expect(toast).toHaveCount(0);
  await expect(exportPreset).toBeFocused();

  // When the window loses focus the countdown resumes; focus still returns once the toast goes.
  await page.keyboard.press('Enter');
  await expect(toast).toHaveCount(1);
  await page.getByTestId('toast-dismiss').focus();
  await page.getByTestId('toast-dismiss').dispatchEvent('focusout');
  await expect(toast).toHaveCount(0);
  await expect(exportPreset).toBeFocused();
  expect(errors).toEqual([]);
});

test('language toggle switches visible labels', async ({ page }) => {
  await openApp(page, 'en');
  await expect(page.getByTestId('lang-toggle')).toHaveText('中文');
  await expect(page.getByTestId('privacy-tagline')).toHaveText('Your photos never leave your device');
  await page.getByTestId('lang-toggle').click();
  await expect(page.getByTestId('privacy-tagline')).toHaveText('照片仅在本地处理，不会上传');
  await expect(page.getByTestId('lang-toggle')).toHaveText('EN');
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');

  await openPortrait(page);
  await expect(page.getByTestId('tool-beauty')).toHaveText('美颜');
  await expect(page.getByTestId('tool-crop')).toHaveText('裁剪');
  await page.getByTestId('lang-toggle').click();
  await expect(page.getByTestId('tool-beauty')).toHaveText('Beauty');

  // The choice is remembered for the next visit.
  await page.getByTestId('lang-toggle').click();
  expect(await page.evaluate(() => localStorage.getItem('openmeitu.language'))).toBe('zh');
});

test('disables face tools with a hint when no face is found', async ({ page }) => {
  const errors = watchErrors(page);
  await openApp(page);
  const png = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 320;
    canvas.height = 240;
    const ctx = canvas.getContext('2d')!;
    const gradient = ctx.createLinearGradient(0, 0, 320, 240);
    gradient.addColorStop(0, '#203040');
    gradient.addColorStop(1, '#e0c080');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, 320, 240);
    return canvas.toDataURL('image/png').split(',')[1]!;
  });
  await page.getByTestId('file-input').setInputFiles({ name: 'gradient.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') });
  await expect(page.getByTestId('face-status')).toHaveAttribute('data-status', 'none', { timeout: 60_000 });
  await expect(page.getByTestId('face-tools-hint')).toBeVisible();
  await expect(page.getByTestId('slider-faceReshape-slim')).toBeDisabled();
  await expect(page.getByTestId('slider-teethWhiten-amount')).toBeDisabled();
  await expect(page.getByTestId('slider-skinSmooth-amount')).toBeEnabled();

  // Double-click restores a slider's default value.
  const whiten = page.getByTestId('slider-skinWhiten-amount');
  await whiten.focus();
  await whiten.press('PageUp');
  await expect(whiten).not.toHaveValue('0');
  await whiten.dblclick();
  await expect(whiten).toHaveValue('0');
  expect(errors).toEqual([]);
});

test('rejects non-image files with a message', async ({ page }) => {
  await openApp(page);
  await page.getByTestId('file-input').setInputFiles({
    name: 'notes.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('not a photo'),
  });
  await expect(page.getByTestId('toast')).toContainText('notes.txt');
  await expect(page.getByTestId('drop-zone')).toBeVisible();
});

test('explains when WebGL2 is unavailable', async ({ page }) => {
  await page.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, type: string, ...args: unknown[]) {
      if (type === 'webgl2') return null;
      return (original as (...a: unknown[]) => RenderingContext | null).call(this, type, ...args);
    } as typeof HTMLCanvasElement.prototype.getContext;
  });
  await openApp(page);
  await page.getByTestId('file-input').setInputFiles(PORTRAIT);
  await expect(page.getByTestId('webgl-error')).toBeVisible();
});

test('is usable on a 375px wide screen', async ({ page }) => {
  const errors = watchErrors(page);
  await page.setViewportSize({ width: 375, height: 812 });
  await openApp(page);
  await page.screenshot({ path: `${SHOTS}/mobile-empty.png` });
  await openPortrait(page);

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);

  const canvas = await page.getByTestId('editor-canvas').boundingBox();
  expect(canvas).not.toBeNull();
  expect(canvas!.x).toBeGreaterThanOrEqual(0);
  expect(canvas!.x + canvas!.width).toBeLessThanOrEqual(375);

  for (const tool of ['beauty', 'adjust', 'filters', 'effects', 'crop', 'presets']) {
    await expect(page.getByTestId(`tool-${tool}`)).toBeInViewport();
  }
  await page.getByTestId('slider-skinSmooth-amount').focus();
  await page.getByTestId('slider-skinSmooth-amount').press('PageUp');
  await expect(page.getByTestId('edit-skinSmooth')).toBeAttached();
  await page.screenshot({ path: `${SHOTS}/mobile-beauty.png` });

  await page.getByTestId('tool-filters').click();
  await expect(page.getByTestId('look-grid')).toBeVisible();
  await expect(page.getByTestId('look-grid').locator('.skeleton')).toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}/mobile-filters.png`, fullPage: true });

  const overflowAfter = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflowAfter).toBeLessThanOrEqual(0);
  expect(errors).toEqual([]);
});
