import { readFileSync, writeFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { MAX_FACES, type FaceAnalysis } from '../../src/face/types';
import { openHarness } from './harness';

// Set UPDATE_FACE_FIXTURES=1 (npm run fixtures:faces) to regenerate tests/fixtures/*.faces.json.
const update = process.env.UPDATE_FACE_FIXTURES === '1';

for (const name of ['portrait-a', 'portrait-b']) {
  test(`detects exactly one face with 478 landmarks in ${name}`, async ({ page }) => {
    await openHarness(page);
    const analysis = await page.evaluate((url) => window.omHarness.detectFaces(url), `/tests/fixtures/${name}.jpg`);
    expect(analysis.imageWidth).toBe(640);
    expect(analysis.imageHeight).toBe(800);
    expect(analysis.faces).toHaveLength(1);
    const face = analysis.faces[0]!;
    expect(face.landmarks).toHaveLength(478);
    for (const p of face.landmarks) {
      expect(p.x).toBeGreaterThan(-0.1);
      expect(p.x).toBeLessThan(1.1);
      expect(p.y).toBeGreaterThan(-0.1);
      expect(p.y).toBeLessThan(1.1);
    }
    // Face sits in the upper-middle of these head-and-shoulders crops.
    const cx = face.box.x + face.box.width / 2;
    const cy = face.box.y + face.box.height / 2;
    expect(cx).toBeGreaterThan(0.3);
    expect(cx).toBeLessThan(0.7);
    expect(cy).toBeGreaterThan(0.2);
    expect(cy).toBeLessThan(0.6);
    // Canonical mesh: 1 = nose tip, 33/263 = outer eye corners (subject's right/left).
    const nose = face.landmarks[1]!;
    const eyeR = face.landmarks[33]!;
    const eyeL = face.landmarks[263]!;
    expect(eyeR.x).toBeLessThan(nose.x);
    expect(eyeL.x).toBeGreaterThan(nose.x);
    expect(nose.y).toBeGreaterThan(Math.min(eyeR.y, eyeL.y));
    if (update) {
      const rounded = {
        ...analysis,
        faces: analysis.faces.map((f) => ({
          box: f.box,
          landmarks: f.landmarks.map((p) => ({ x: +p.x.toFixed(5), y: +p.y.toFixed(5) })),
        })),
      };
      writeFileSync(`tests/fixtures/${name}.faces.json`, JSON.stringify(rounded) + '\n');
    }
  });
}

type Box = FaceAnalysis['faces'][number]['box'];

function iou(a: Box, b: Box): number {
  const w = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
  const h = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  return (w * h) / (a.width * a.height + b.width * b.height - w * h);
}

/** A portrait (0 = portrait-a, 1 = portrait-b, both 4:5) drawn `width` px wide with its top-left corner at x, y. */
interface Cell {
  x: number;
  y: number;
  width: number;
  portrait: number;
}

/** `count` equal portraits (alternating a and b) in `rows` centred rows filling a `width` x `height` frame. */
function rowsOf(count: number, width: number, height: number, rows = 1): Cell[] {
  const perRow = Math.ceil(count / rows);
  const cellW = Math.min(width / perRow, height / rows / 1.25);
  return Array.from({ length: count }, (_, i) => ({
    x: (width - cellW * perRow) / 2 + (i % perRow) * cellW,
    y: (height - cellW * 1.25 * rows) / 2 + Math.floor(i / perRow) * cellW * 1.25,
    width: cellW,
    portrait: i % 2,
  }));
}

/**
 * Detect faces in a `width` x `height` grey frame showing the portraits of
 * `cells`. Returns the analysis and the box each portrait's face should have,
 * from the fixtures' cached landmarks.
 */
async function detectCollage(page: Page, width: number, height: number, cells: Cell[]): Promise<{ analysis: FaceAnalysis; expected: Box[] }> {
  const analysis = await page.evaluate(
    async ({ width, height, cells }) => {
      const portraits = await Promise.all(
        ['portrait-a', 'portrait-b'].map(async (name) => createImageBitmap(await (await fetch(`/tests/fixtures/${name}.jpg`)).blob())),
      );
      const canvas = new OffscreenCanvas(width, height);
      const ctx = canvas.getContext('2d')!;
      ctx.fillStyle = '#55556a';
      ctx.fillRect(0, 0, width, height);
      for (const c of cells) ctx.drawImage(portraits[c.portrait]!, c.x, c.y, c.width, c.width * 1.25);
      const url = URL.createObjectURL(await canvas.convertToBlob({ type: 'image/png' }));
      try {
        return await window.omHarness.detectFaces(url);
      } finally {
        URL.revokeObjectURL(url);
      }
    },
    { width, height, cells },
  );
  const fixtureBoxes = ['portrait-a', 'portrait-b'].map((name) => (JSON.parse(readFileSync(`tests/fixtures/${name}.faces.json`, 'utf8')) as FaceAnalysis).faces[0]!.box);
  const expected = cells.map(({ x, y, width: w, portrait }) => {
    const b = fixtureBoxes[portrait]!;
    return { x: (x + b.x * w) / width, y: (y + b.y * w * 1.25) / height, width: (b.width * w) / width, height: (b.height * w * 1.25) / height };
  });
  return { analysis, expected };
}

/**
 * Each face found is one of the `expected` faces, where it is and at its
 * size, none twice; largest first. Returns the index of each in `expected`.
 */
function expectDistinctFaces(analysis: FaceAnalysis, expected: Box[]): number[] {
  const matches = analysis.faces.map((face) => {
    expect(face.landmarks).toHaveLength(478);
    const hits = expected.flatMap((box, i) => (iou(face.box, box) > 0.6 ? [i] : []));
    expect(hits).toHaveLength(1);
    return hits[0]!;
  });
  expect(new Set(matches).size).toBe(matches.length);
  const areas = analysis.faces.map((f) => f.box.width * f.box.height);
  expect(areas).toEqual([...areas].sort((x, y) => y - x));
  return matches;
}

// Faces about a tenth of the frame wide and smaller: the detector's
// full-frame pass misses some or all of them, the tiled pass finds them.
for (const count of [4, 5]) {
  test(`finds each of ${count} people standing in a row exactly once`, async ({ page }) => {
    await openHarness(page);
    const { analysis, expected } = await detectCollage(page, 1920, 1280, rowsOf(count, 1920, 1280));
    expect(analysis.faces).toHaveLength(count);
    expectDistinctFaces(analysis, expected);
  });
}

test('reports a face once even when MediaPipe reports it twice', async ({ page }) => {
  await openHarness(page);
  // MediaPipe's own full-frame result holds this face twice.
  const { analysis, expected } = await detectCollage(page, 1920, 640, [{ x: 400, y: 65, width: 460, portrait: 0 }]);
  expect(analysis.faces).toHaveLength(1);
  expectDistinctFaces(analysis, expected);
});

test(`returns at most ${MAX_FACES} faces, the largest ones`, async ({ page }) => {
  await openHarness(page);
  const { analysis, expected } = await detectCollage(page, 1920, 1280, rowsOf(MAX_FACES + 2, 1920, 1280, 2));
  expect(analysis.faces).toHaveLength(MAX_FACES);
  const kept = expectDistinctFaces(analysis, expected);
  const area = (b: Box) => b.width * b.height;
  const smallestKept = Math.min(...kept.map((i) => area(expected[i]!)));
  for (const [i, box] of expected.entries()) if (!kept.includes(i)) expect(area(box)).toBeLessThanOrEqual(smallestKept * 1.02);
});

// The large one also goes through the tiled pass.
for (const [width, height] of [
  [320, 240],
  [1600, 1000],
]) {
  test(`finds no face in a plain ${width}x${height} gradient`, async ({ page }) => {
    await openHarness(page);
    const analysis = await page.evaluate(
      async ({ width, height }) => {
        const c = document.createElement('canvas');
        c.width = width;
        c.height = height;
        const ctx = c.getContext('2d')!;
        const g = ctx.createLinearGradient(0, 0, width, height);
        g.addColorStop(0, '#203040');
        g.addColorStop(1, '#e0c080');
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, width, height);
        const url = c.toDataURL('image/png');
        return window.omHarness.detectFaces(url);
      },
      { width, height },
    );
    expect(analysis.faces).toHaveLength(0);
  });
}
