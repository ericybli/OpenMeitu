import type { Page } from '@playwright/test';
import type { HarnessImage, HarnessRenderRequest, HarnessRenderResult } from '../../src/harness/main';

export type { HarnessImage, HarnessRenderRequest, HarnessRenderResult };

export interface Pixels {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

export async function openHarness(page: Page): Promise<void> {
  await page.goto('/harness.html');
  await page.waitForFunction(() => (window as unknown as { omHarness?: { ready: boolean } }).omHarness?.ready === true);
}

export async function render(page: Page, req: HarnessRenderRequest): Promise<Pixels> {
  const res = (await page.evaluate((r) => window.omHarness.render({ ...r, encoding: 'base64' }), req)) as HarnessRenderResult;
  const bytes = Buffer.from(res.base64 ?? '', 'base64');
  return { width: res.width, height: res.height, data: new Uint8ClampedArray(bytes) };
}

/** Build a synthetic RGBA image from a per-pixel function returning 0..255 values. */
export function makeImage(width: number, height: number, fn: (x: number, y: number) => [number, number, number, number?]) {
  const data: number[] = new Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b, a = 255] = fn(x, y);
      const i = (y * width + x) * 4;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = a;
    }
  }
  return { width, height, data };
}

export function pixelAt(p: Pixels, x: number, y: number): [number, number, number, number] {
  const i = (y * p.width + x) * 4;
  return [p.data[i]!, p.data[i + 1]!, p.data[i + 2]!, p.data[i + 3]!];
}

/** Mean absolute difference over RGB channels (0..255). */
export function meanAbsDiff(a: Pixels | { data: ArrayLike<number> }, b: Pixels | { data: ArrayLike<number> }): number {
  const n = Math.min(a.data.length, b.data.length);
  let sum = 0;
  let count = 0;
  for (let i = 0; i < n; i += 4) {
    sum += Math.abs(a.data[i]! - b.data[i]!) + Math.abs(a.data[i + 1]! - b.data[i + 1]!) + Math.abs(a.data[i + 2]! - b.data[i + 2]!);
    count += 3;
  }
  return count ? sum / count : 0;
}

export function meanLuma(p: Pixels): number {
  let s = 0;
  for (let i = 0; i < p.data.length; i += 4) s += 0.2126 * p.data[i]! + 0.7152 * p.data[i + 1]! + 0.0722 * p.data[i + 2]!;
  return s / (p.data.length / 4);
}
