import { expect, test } from '@playwright/test';

/**
 * Privacy guarantees: the app may only talk to its own origin. A
 * Content-Security-Policy enforces this, which also blocks the usage logging
 * built into @mediapipe/tasks-vision (it POSTs to odml.pa.googleapis.com).
 */

test('the app is served with a same-origin-only Content-Security-Policy', async ({ page }) => {
  const response = await page.goto('/');
  const csp = response?.headers()['content-security-policy'] ?? '';
  expect(csp).toContain("default-src 'self'");
  expect(csp).toMatch(/connect-src 'self'[^;]*;?/);
  expect(csp).not.toMatch(/connect-src[^;]*https?:/);
});

test('requests to other origins are blocked, including MediaPipe telemetry', async ({ page }) => {
  await page.goto('/');
  const results = await page.evaluate(async () => {
    const attempt = async (url: string, init?: RequestInit) => {
      try {
        await fetch(url, init);
        return 'sent';
      } catch {
        return 'blocked';
      }
    };
    return {
      telemetry: await attempt('https://odml.pa.googleapis.com/v1/log', { method: 'POST', body: 'x' }),
      cdn: await attempt('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision/package.json'),
      sameOrigin: await attempt('/favicon.svg'),
    };
  });
  expect(results).toEqual({ telemetry: 'blocked', cdn: 'blocked', sameOrigin: 'sent' });
});

test('face detection works under the policy and never leaves the origin', async ({ page, baseURL }) => {
  const origin = new URL(baseURL ?? 'http://localhost:5179').origin;
  const foreign: string[] = [];
  page.on('request', (req) => {
    const url = new URL(req.url());
    if (['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol) && url.origin !== origin) foreign.push(req.url());
  });
  const violations: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error' && /Content Security Policy/i.test(msg.text()) && !/googleapis\.com/.test(msg.text())) {
      violations.push(msg.text());
    }
  });
  await page.goto('/harness.html');
  await page.waitForFunction(() => window.omHarness?.ready === true);
  const analysis = await page.evaluate(() => window.omHarness.detectFaces('/tests/fixtures/portrait-a.jpg'));
  expect(analysis.faces.length).toBe(1);
  expect(foreign).toEqual([]);
  expect(violations).toEqual([]);
});
