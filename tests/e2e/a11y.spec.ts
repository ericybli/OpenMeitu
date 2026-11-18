import { readFileSync } from 'node:fs';
import { expect, test, type FileChooser, type Locator, type Page } from '@playwright/test';

/**
 * Accessibility of the real app: keyboard-only use, focus management, screen
 * reader names, forced-colors (Windows High Contrast), contrast and touch targets.
 */

const PORTRAIT = 'tests/fixtures/portrait-a.jpg';
const PORTRAIT_B = 'tests/fixtures/portrait-b.jpg';

async function openApp(page: Page): Promise<void> {
  await page.addInitScript(() => {
    try {
      localStorage.setItem('openmeitu.language', 'en');
    } catch {
      // ignore: the app falls back to the browser locale
    }
  });
  await page.goto('/');
  await expect(page.getByTestId('drop-zone')).toBeVisible();
}

type ImageFile = string | { name: string; mimeType: string; buffer: Buffer };

async function openImage(page: Page, file: ImageFile = PORTRAIT): Promise<void> {
  await page.getByTestId('file-input').setInputFiles(file);
  await expect(page.getByTestId('editor-canvas')).toBeVisible();
  await expect(page.getByTestId('face-status')).toHaveAttribute('data-status', 'found', { timeout: 60_000 });
}

/** Raise a slider by one page step from the keyboard, which adds its layer to the Edits list. */
async function nudgeSlider(page: Page, testId: string): Promise<void> {
  const slider = page.getByTestId(testId);
  await slider.focus();
  await slider.press('PageUp');
}

async function outputSize(page: Page): Promise<{ width: number; height: number }> {
  const match = /(\d+) × (\d+)/.exec((await page.getByTestId('crop-output-size').textContent()) ?? '');
  expect(match).not.toBeNull();
  return { width: Number(match![1]), height: Number(match![2]) };
}

/** Position of the crop frame in percent of the stage. */
async function framePosition(frame: Locator): Promise<{ left: number; top: number }> {
  return frame.evaluate((el: HTMLElement) => ({ left: parseFloat(el.style.left), top: parseFloat(el.style.top) }));
}

async function press(page: Page, key: string, times: number): Promise<void> {
  for (let i = 0; i < times; i++) await page.keyboard.press(key);
}

test('the crop frame moves and resizes from the keyboard, keeping aspect locks', async ({ page }) => {
  await openApp(page);
  await openImage(page);
  await page.getByTestId('tool-crop').focus();
  await page.keyboard.press('Enter');
  const frame = page.getByTestId('crop-frame');
  await expect(frame).toHaveAttribute('aria-description', /(Alt|Option)\+Shift\+arrows the left or top edge/);
  await expect(page.getByTestId('panel-crop')).toContainText(/(Alt|Option)\+arrows move the right or bottom edge/);

  // Free aspect: Alt+arrows pull the right and bottom edges in, Alt+Shift+arrows the left and top edges.
  await frame.focus();
  await press(page, 'Alt+ArrowLeft', 10);
  await press(page, 'Alt+ArrowUp', 5);
  let size = await outputSize(page);
  expect(size.width).toBeCloseTo(576, -1);
  expect(size.height).toBeCloseTo(760, -1);
  await press(page, 'Alt+Shift+ArrowRight', 10);
  await press(page, 'Alt+Shift+ArrowDown', 5);
  size = await outputSize(page);
  expect(size.width).toBeCloseTo(512, -1);
  expect(size.height).toBeCloseTo(720, -1);
  const resized = await framePosition(frame);
  expect(resized.left).toBeCloseTo(10, 1);
  expect(resized.top).toBeCloseTo(5, 1);

  // Plain arrows still move the whole frame.
  await page.keyboard.press('ArrowRight');
  expect((await framePosition(frame)).left).toBeGreaterThan(resized.left);
  expect(await outputSize(page)).toEqual(size);

  // A locked 1:1 frame stays square whichever edge moves.
  await page.getByTestId('crop-aspect-1:1').focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('crop-output-size')).toContainText('640 × 640');
  await frame.focus();
  await press(page, 'Alt+ArrowLeft', 10);
  await press(page, 'Alt+Shift+ArrowDown', 5);
  size = await outputSize(page);
  expect(size.width).toBeLessThan(600);
  expect(Math.abs(size.width - size.height)).toBeLessThanOrEqual(1);

  // Resetting disables the reset button; focus moves to the selected aspect instead of <body>.
  await page.getByTestId('crop-reset').focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('crop-reset')).toBeDisabled();
  await expect(page.getByTestId('crop-aspect-free')).toBeFocused();
});

test('holding Space on the crop frame compares without dropping the frame or its focus', async ({ page }) => {
  await openApp(page);
  await openImage(page);
  await page.getByTestId('tool-crop').click();
  await page.getByTestId('crop-aspect-1:1').click();
  const frame = page.getByTestId('crop-frame');
  const compare = page.getByTestId('compare-button');
  await frame.focus();

  await page.keyboard.down('Space');
  await expect(compare).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('crop-overlay')).toHaveCSS('opacity', '0');
  await expect(frame).toBeFocused();
  await page.keyboard.up('Space');
  await expect(compare).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByTestId('crop-overlay')).toHaveCSS('opacity', '1');
  await expect(frame).toBeFocused();

  const before = await framePosition(frame);
  await page.keyboard.press('ArrowDown');
  expect((await framePosition(frame)).top).toBeGreaterThan(before.top);
});

test('Space on an import control opens the file picker instead of comparing', async ({ page }) => {
  // A lasting listener keeps Playwright intercepting pickers; between one-off waits it stops.
  const choosers: FileChooser[] = [];
  page.on('filechooser', (chooser) => choosers.push(chooser));
  await openApp(page);
  await openImage(page);
  await page.getByTestId('tool-presets').click();
  for (const [i, testId] of ['preset-import-input', 'lut-import-input'].entries()) {
    await page.getByTestId(testId).focus();
    await page.keyboard.press('Space');
    await expect.poll(() => choosers.length).toBe(i + 1);
    await expect(page.getByTestId('compare-button')).toHaveAttribute('aria-pressed', 'false');
    await choosers[i]!.setFiles([]);
  }
});

test('export menu: one tab stop for the format, arrow keys, and focus returns to Export', async ({ page }) => {
  await openApp(page);
  await openImage(page);
  const trigger = page.getByTestId('export-button');
  const menu = page.getByTestId('export-menu');
  const jpeg = page.getByTestId('export-format-jpeg');
  const png = page.getByTestId('export-format-png');

  await trigger.focus();
  await page.keyboard.press('Enter');
  await expect(menu).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(jpeg).toBeFocused();
  await expect(png).toHaveAttribute('tabindex', '-1');
  await page.keyboard.press('ArrowRight');
  await expect(png).toBeFocused();
  await expect(png).toHaveAttribute('aria-checked', 'true');
  await expect(jpeg).toHaveAttribute('tabindex', '-1');
  await page.keyboard.press('ArrowDown');
  await expect(jpeg).toBeFocused();
  await expect(jpeg).toHaveAttribute('aria-checked', 'true');

  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await expect(trigger).toBeFocused();

  // Downloading closes the menu and hands focus back to the trigger.
  await page.keyboard.press('Enter');
  await press(page, 'Tab', 3);
  await expect(page.getByTestId('export-download')).toBeFocused();
  const [download] = await Promise.all([page.waitForEvent('download'), page.keyboard.press('Enter')]);
  expect(download.suggestedFilename()).toBe('portrait-a-openmeitu.jpg');
  await expect(menu).toBeHidden();
  await expect(trigger).toBeFocused();

  // Tabbing past the menu closes it rather than leaving it over the next focused control.
  await page.keyboard.press('Enter');
  await expect(menu).toBeVisible();
  await press(page, 'Tab', 4);
  await expect(page.getByTestId('lang-toggle')).toBeFocused();
  await expect(menu).toBeHidden();
});

test('keyboard focus is never dropped when a photo opens or edits are removed, reset or undone', async ({ page }) => {
  // Listen early: Playwright only intercepts the picker once its listener is set up.
  const chooser = page.waitForEvent('filechooser');
  await openApp(page);
  await page.getByTestId('drop-zone').focus();
  await page.keyboard.press('Enter');
  await (await chooser).setFiles(PORTRAIT);
  await expect(page.getByRole('heading', { name: 'Beauty' })).toBeFocused();

  await nudgeSlider(page, 'slider-skinSmooth-amount');
  await nudgeSlider(page, 'slider-skinWhiten-amount');
  await page.getByTestId('tool-adjust').click();
  await nudgeSlider(page, 'slider-adjust-exposure');
  // Listed newest stage first: Adjust, Whiten, Smooth skin.
  await expect(page.getByTestId('edits-list').locator('li')).toHaveCount(3);

  // Removing a row focuses the row that takes its place, or the one above when it was last,
  // whether its own button removed it or Undo did.
  await page.getByTestId('edit-toggle-adjust').focus();
  await page.keyboard.press('ControlOrMeta+z');
  await expect(page.getByTestId('edits-list').locator('li')).toHaveCount(2);
  await expect(page.getByTestId('edit-toggle-skinWhiten')).toBeFocused();
  await page.keyboard.press('ControlOrMeta+Shift+z');
  await expect(page.getByTestId('edits-list').locator('li')).toHaveCount(3);
  await page.getByTestId('edit-delete-skinWhiten').focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('edit-toggle-skinSmooth')).toBeFocused();
  await page.getByTestId('edit-delete-skinSmooth').focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('edit-toggle-adjust')).toBeFocused();

  // Reset all empties the list: focus goes to the Edits heading.
  await page.getByTestId('edits-reset-all').focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('edits-list')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Edits' })).toBeFocused();

  // Undoing to the start disables Undo: focus moves to Redo, and back again.
  const undo = page.getByTestId('undo-button');
  const redo = page.getByTestId('redo-button');
  await undo.focus();
  while (await undo.isEnabled()) await page.keyboard.press('Enter');
  await expect(redo).toBeFocused();
  while (await redo.isEnabled()) await page.keyboard.press('Enter');
  await expect(undo).toBeFocused();
});

test('the Export button keeps its accessible name at phone width', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openApp(page);
  await expect(page.getByRole('button', { name: 'Export', exact: true })).toBeVisible();
  await page.getByTestId('lang-toggle').click();
  await expect(page.getByRole('button', { name: '导出', exact: true })).toBeVisible();
});

test('with several faces the status says every face is retouched (en and zh)', async ({ page }) => {
  await openApp(page);
  const dataUrl = (path: string) => `data:image/jpeg;base64,${readFileSync(path).toString('base64')}`;
  const pair = await page.evaluate(async (sources) => {
    const images = await Promise.all(
      sources.map(async (src) => {
        const img = new Image();
        img.src = src;
        await img.decode();
        return img;
      }),
    );
    const canvas = document.createElement('canvas');
    canvas.width = images.reduce((sum, img) => sum + img.width, 0);
    canvas.height = Math.max(...images.map((img) => img.height));
    const ctx = canvas.getContext('2d')!;
    let x = 0;
    for (const img of images) {
      ctx.drawImage(img, x, 0);
      x += img.width;
    }
    return canvas.toDataURL('image/jpeg', 0.92).split(',')[1]!;
  }, [dataUrl(PORTRAIT), dataUrl(PORTRAIT_B)]);
  await openImage(page, { name: 'pair.jpg', mimeType: 'image/jpeg', buffer: Buffer.from(pair, 'base64') });

  const status = page.getByTestId('face-status');
  await expect(status).toHaveText('2 faces detected · all are retouched');
  await page.getByTestId('lang-toggle').click();
  await expect(status).toHaveText('识别到 2 张人脸 · 全部美颜');
});

interface InkMap {
  width: number;
  height: number;
  ink: boolean[][];
}

/** Pixels of a region around `target` (padded by `pad` px) that differ clearly from its top-left pixel. */
async function inkMap(page: Page, target: Locator, pad: number): Promise<InkMap> {
  await target.scrollIntoViewIfNeeded();
  const box = (await target.boundingBox())!;
  const png = await page.screenshot({
    clip: { x: box.x - pad, y: box.y - pad, width: box.width + 2 * pad, height: box.height + 2 * pad },
    scale: 'css',
  });
  return page.evaluate(async (base64) => {
    const img = new Image();
    img.src = `data:image/png;base64,${base64}`;
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(img, 0, 0);
    const { data } = ctx.getImageData(0, 0, img.width, img.height);
    const ink: boolean[][] = [];
    for (let y = 0; y < img.height; y++) {
      const row: boolean[] = [];
      for (let x = 0; x < img.width; x++) {
        const i = (y * img.width + x) * 4;
        const diff = Math.abs(data[i]! - data[0]!) + Math.abs(data[i + 1]! - data[1]!) + Math.abs(data[i + 2]! - data[2]!);
        row.push(diff > 90);
      }
      ink.push(row);
    }
    return { width: img.width, height: img.height, ink };
  }, png.toString('base64'));
}

const fraction = (cells: boolean[]) => cells.filter(Boolean).length / cells.length;

test('sliders, switches, focus and selections stay visible in forced colors mode', async ({ page }) => {
  // A dark high-contrast theme, like Windows' "Night sky".
  await page.emulateMedia({ forcedColors: 'active', colorScheme: 'dark', reducedMotion: 'reduce' });
  await openApp(page);
  await openImage(page);
  const slider = page.getByTestId('slider-skinWhiten-amount');
  await nudgeSlider(page, 'slider-skinWhiten-amount');
  await slider.blur();

  // Track across the whole width, and a thumb clearly taller than the track.
  const pad = 6;
  const plain = await inkMap(page, slider, pad);
  const middle = plain.ink[Math.round(plain.height / 2)]!;
  expect(fraction(middle.slice(pad + 8, plain.width - pad - 8))).toBeGreaterThan(0.9);
  const thumbX = pad + 8 + 0.1 * (plain.width - 2 * pad - 16);
  const thumbColumn = plain.ink.map((row) => row[Math.round(thumbX)]!);
  expect(thumbColumn.filter(Boolean).length).toBeGreaterThanOrEqual(10);

  // A focus ring appears around the focused slider.
  const leftBand = (map: InkMap) => map.ink.slice(pad, map.height - pad).map((row) => row[pad - 3]!);
  expect(fraction(leftBand(plain))).toBeLessThan(0.2);
  await slider.focus();
  expect(fraction(leftBand(await inkMap(page, slider, pad)))).toBeGreaterThan(0.8);

  // Layer switches are drawn in both states, and differently.
  const toggle = page.getByTestId('edit-toggle-skinWhiten');
  const on = await inkMap(page, toggle, 0);
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  const off = await inkMap(page, toggle, 0);
  expect(fraction(on.ink.flat())).toBeGreaterThan(0.25);
  expect(fraction(off.ink.flat())).toBeGreaterThan(0.25);
  expect(off.ink).not.toEqual(on.ink);

  // The selected tool and filter category are marked; the others are not.
  const marked = async (testId: string) => {
    const map = await inkMap(page, page.getByTestId(testId), 2);
    return map.ink[Math.round(map.height / 2)]![6]!;
  };
  expect(await marked('tool-beauty')).toBe(true);
  expect(await marked('tool-adjust')).toBe(false);
  await page.getByTestId('tool-filters').click();
  expect(await marked('tool-filters')).toBe(true);
  expect(await marked('tool-beauty')).toBe(false);
  expect(await marked('look-category-all')).toBe(true);
  expect(await marked('look-category-natural')).toBe(false);

  // The checked export format is marked too, and the mark follows a new choice.
  await page.getByTestId('export-button').click();
  const jpeg = page.getByTestId('export-format-jpeg');
  const png = page.getByTestId('export-format-png');
  const checked = await jpeg.evaluate((el) => getComputedStyle(el).backgroundColor);
  await png.click();
  await expect(png).toHaveCSS('background-color', checked);
  await expect(jpeg).not.toHaveCSS('background-color', checked);
});

test('muted text has at least 4.5:1 contrast on every surface it is used on', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openApp(page);
  await openImage(page);
  await nudgeSlider(page, 'slider-skinSmooth-amount');
  await page.getByTestId('tool-filters').click();
  await page.getByTestId('look-film').click();
  await page.getByTestId('edit-toggle-skinSmooth').click();
  await page.getByTestId('export-button').click();
  await expect(page.getByTestId('export-menu')).toBeVisible();

  const results = await page.evaluate(() => {
    const parse = (color: string) => {
      const [r = 0, g = 0, b = 0, a = 1] = (color.match(/[\d.]+/g) ?? []).map(Number);
      return { r, g, b, a };
    };
    type Rgba = ReturnType<typeof parse>;
    const over = (top: Rgba, under: Rgba): Rgba => ({
      r: top.r * top.a + under.r * (1 - top.a),
      g: top.g * top.a + under.g * (1 - top.a),
      b: top.b * top.a + under.b * (1 - top.a),
      a: 1,
    });
    const luminance = ({ r, g, b }: Rgba) => {
      const channel = (v: number) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
      return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
    };
    const background = (el: Element): Rgba => {
      const layers: Rgba[] = [];
      for (let e: Element | null = el; e; e = e.parentElement) {
        const bg = parse(getComputedStyle(e).backgroundColor);
        if (bg.a > 0) layers.push(bg);
        if (bg.a === 1) break;
      }
      const base = parse(getComputedStyle(document.body).backgroundColor);
      return layers.reduceRight<Rgba>((under, top) => over(top, under), base);
    };
    const muted = [
      '.panel-hint',
      '.panel-section__title',
      '.slider__value',
      '.slider--compact .slider__label',
      '.edit-row__detail',
      '.edit-row.is-off .edit-row__name',
      '.text-button',
      '.topbar__file',
      '.rail__item[aria-pressed="false"]',
    ];
    return [...document.querySelectorAll(muted.join(','))]
      .filter((el) => el.getClientRects().length > 0 && !el.closest('.is-disabled, :disabled'))
      .map((el) => {
        const fg = luminance(parse(getComputedStyle(el).color));
        const bg = luminance(background(el));
        const ratio = (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05);
        return { text: `${el.className}: ${el.textContent?.trim().slice(0, 24)}`, ratio };
      });
  });
  expect(results.length).toBeGreaterThan(10);
  // The Edits rows and the export popover sit on the lighter card surface.
  expect(results.some((r) => r.text.startsWith('edit-row__detail'))).toBe(true);
  for (const { text, ratio } of results) expect(ratio, text).toBeGreaterThanOrEqual(4.5);
});

test.describe('on a touch screen', () => {
  test.use({ hasTouch: true, viewport: { width: 390, height: 844 } });

  /**
   * Whether taps 21 px left, right, above and below the control's centre still hit it, i.e. its
   * hit area spans 44 px both ways (hit testing rounds to whole pixels; corners are left out
   * because rounded corners don't hit-test).
   */
  async function has44pxHitArea(target: Locator): Promise<boolean> {
    await target.scrollIntoViewIfNeeded();
    return target.evaluate((el) => {
      const box = el.getBoundingClientRect();
      const cx = box.left + box.width / 2;
      const cy = box.top + box.height / 2;
      const points = [
        [cx - 21, cy],
        [cx + 21, cy],
        [cx, cy - 21],
        [cx, cy + 21],
      ] as const;
      return points.every(([x, y]) => {
        const hit = document.elementFromPoint(x, y);
        return hit !== null && el.contains(hit);
      });
    });
  }

  test('primary controls have hit areas of at least 44 × 44 px', async ({ page }) => {
    await openApp(page);
    await openImage(page);
    await nudgeSlider(page, 'slider-skinSmooth-amount');
    const targets = [
      'open-button',
      'undo-button',
      'redo-button',
      'compare-button',
      'export-button',
      'lang-toggle',
      'github-link',
      'edits-reset-all',
      'edit-toggle-skinSmooth',
      'edit-reset-skinSmooth',
      'edit-delete-skinSmooth',
    ];
    for (const testId of targets) expect(await has44pxHitArea(page.getByTestId(testId)), testId).toBe(true);

    await page.getByTestId('tool-filters').click();
    for (const testId of ['look-category-all', 'look-category-mono']) {
      expect(await has44pxHitArea(page.getByTestId(testId)), testId).toBe(true);
    }
    await page.getByTestId('export-button').click();
    for (const testId of ['export-format-jpeg', 'export-format-png', 'export-download']) {
      expect(await has44pxHitArea(page.getByTestId(testId)), testId).toBe(true);
    }

    // The larger header still fits small phones without sideways scrolling (below 360 px at 40 px).
    for (const width of [390, 360, 320]) {
      await page.setViewportSize({ width, height: 800 });
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow, `${width}px`).toBeLessThanOrEqual(0);
    }
  });
});
