import { expect, test } from '@playwright/test';
import { makeImage, meanAbsDiff, openHarness, pixelAt, render } from './harness';

test('WebGL2 is available and an empty stack is an exact identity', async ({ page }) => {
  await openHarness(page);
  const info = await page.evaluate(() => window.omHarness.info());
  expect(info.webgl2).toBe(true);
  const image = makeImage(32, 16, (x, y) => [x * 8, y * 16, 128]);
  const out = await render(page, { image, layers: [] });
  expect(out.width).toBe(32);
  expect(out.height).toBe(16);
  expect(meanAbsDiff(out, image)).toBe(0);
  // Row 0 must be the image top (orientation convention).
  expect(pixelAt(out, 31, 0).slice(0, 3)).toEqual([248, 0, 128]);
  expect(pixelAt(out, 0, 15).slice(0, 3)).toEqual([0, 240, 128]);
});

test('maxSize downscales the export', async ({ page }) => {
  await openHarness(page);
  const image = makeImage(64, 32, () => [200, 100, 50]);
  const out = await render(page, { image, layers: [], maxSize: 16 });
  expect(out.width).toBe(16);
  expect(out.height).toBe(8);
  expect(pixelAt(out, 8, 4).slice(0, 3)).toEqual([200, 100, 50]);
});
