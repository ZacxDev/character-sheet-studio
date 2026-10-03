// Responsive-layout screenshot capture for Character Sheet Studio (dev-only).
//
// Boots the mock-host harness (seeded Kaida data), hides the dev chrome, and
// captures every view full-page at mobile + desktop widths (plus tablet and
// ultrawide spot checks). Image requests are answered with a solid PNG so
// generated-panel layout renders filled, not broken.
//
//   npm run dev:harness   (another terminal, port 5186)
//   node tools/capture-responsive.mjs

import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire('/home/hatch/workspace/.clickthrough/');
const puppeteer = require('puppeteer-core');

const CHROME =
  '/home/hatch/workspace/.clickthrough/chrome-headless-shell-linux64/chrome-headless-shell';
const BASE = process.env.CSS_SHOT_BASE ?? 'http://localhost:5186';
const OUT = path.resolve(
  process.env.CSS_SHOT_OUT ??
    '/home/hatch/workspace/goals/build-and-publish-apps-that-make-money-24-7/files/app-review/character-sheet-studio',
);
fs.mkdirSync(OUT, { recursive: true });

// 1x1 violet PNG — stretched by CSS into the image boxes; layout is what
// we're validating, not art.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAEBgIApD5fRAAAAABJRU5ErkJggg==',
  'base64',
);

const HIDE_DEV_CHROME = `
  [data-harness-banner], [data-harness-scenario-panel],
  [data-harness="true"] > details { display: none !important; }
  /* The harness page extends past the app on tall viewports — paint it the
     app's dark body color so shots show the slab the host frame would. */
  html, body { background: #100e14; }
`;

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'shell',
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});

const problems = [];

async function newShotPage(viewport) {
  const page = await browser.newPage();
  await page.setViewport(viewport);
  await page.evaluateOnNewDocument((css) => {
    const inject = () => {
      const style = document.createElement('style');
      style.textContent = css;
      document.head?.appendChild(style);
    };
    if (document.head) inject();
    else document.addEventListener('DOMContentLoaded', inject, { once: true });
  }, HIDE_DEV_CHROME);
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    if (req.resourceType() === 'image') {
      void req.respond({ status: 200, contentType: 'image/png', body: PNG });
    } else {
      void req.continue();
    }
  });
  page.on('pageerror', (e) => problems.push(`[pageerror] ${String(e).slice(0, 200)}`));
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(`[console] ${m.text().slice(0, 200)}`);
  });
  return page;
}

const settle = (ms = 700) => new Promise((r) => setTimeout(r, ms));

async function gotoView(page, tab, needle) {
  await page.goto(`${BASE}/?tab=${tab}`, { waitUntil: 'load', timeout: 60_000 });
  await page.waitForFunction(
    (n) => document.body.innerText.includes(n),
    { timeout: 30_000 },
    needle,
  );
  await settle();
}

async function clickByText(page, text) {
  const clicked = await page.evaluate((t) => {
    const el = [...document.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === t,
    );
    if (el) {
      el.click();
      return true;
    }
    return false;
  }, text);
  if (!clicked) throw new Error(`button not found: ${text}`);
}

async function shoot(page, name) {
  await page.screenshot({ path: path.join(OUT, name), fullPage: true });
  console.log('shot', name);
}

async function routine(label, viewport) {
  const page = await newShotPage(viewport);
  await gotoView(page, 'characters', 'Kaida');
  await shoot(page, `characters-${label}.png`);

  await gotoView(page, 'stacks', 'SDXL Anime + detail LoRAs');
  await shoot(page, `stacks-${label}.png`);

  await gotoView(page, 'builder', 'Enhance prompts');
  await shoot(page, `builder-${label}.png`);

  await gotoView(page, 'sheets', 'Kaida turnaround v1');
  await shoot(page, `sheets-${label}.png`);

  // Sheet detail: open the seeded sheet, run the queued panels in the mock,
  // and capture the finished grid (images + Post/Publish actions visible).
  await clickByText(page, 'Open');
  await page.waitForFunction(
    () => document.body.innerText.includes('Front view'),
    { timeout: 30_000 },
  );
  await page.click('[data-testid="se-submit-all"]');
  await page.waitForSelector('[data-testid="se-submit-all-confirm-submit"]', {
    timeout: 60_000,
  });
  await settle(300);
  await page.click('[data-testid="se-submit-all-confirm-submit"]');
  await page.waitForFunction(
    () =>
      document.querySelectorAll('[data-testid="se-panel-post"]:not([disabled])')
        .length >= 1 ||
      [...document.querySelectorAll('[data-testid="se-panel-post"]')].some(
        (b) => b.textContent?.includes('Post') && !b.hasAttribute('disabled'),
      ),
    { timeout: 120_000 },
  );
  // Let the rest of the batch finish for a fuller grid.
  await page
    .waitForFunction(
      () =>
        [...document.querySelectorAll('button')].filter((b) =>
          b.textContent?.includes('New variation'),
        ).length >= 6,
      { timeout: 120_000 },
    )
    .catch(() => console.log('  (batch still finishing — shooting what we have)'));
  await settle(500);
  await shoot(page, `sheetview-${label}.png`);
  await page.close();
}

await routine('mobile', {
  width: 390,
  height: 844,
  isMobile: true,
  hasTouch: true,
  deviceScaleFactor: 2,
});
await routine('desktop', { width: 1440, height: 900, deviceScaleFactor: 1 });

// Spot checks: tablet (Builder) + ultrawide (Characters, Sheet View list→detail skipped; characters only).
{
  const page = await newShotPage({ width: 834, height: 1112, deviceScaleFactor: 1 });
  await gotoView(page, 'builder', 'Enhance prompts');
  await shoot(page, 'builder-tablet.png');
  await page.close();
}
{
  const page = await newShotPage({ width: 2560, height: 1080, deviceScaleFactor: 1 });
  await gotoView(page, 'characters', 'Kaida');
  await shoot(page, 'characters-ultrawide.png');
  await gotoView(page, 'sheets', 'Kaida turnaround v1');
  await shoot(page, 'sheets-ultrawide.png');
  await page.close();
}

await browser.close();
console.log('done ->', OUT);
if (problems.length) {
  console.log('PAGE PROBLEMS (first 10):');
  for (const p of [...new Set(problems)].slice(0, 10)) console.log(' ', p);
}
