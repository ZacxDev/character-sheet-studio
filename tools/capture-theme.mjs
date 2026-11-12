// "Indigo Lineup" theme (v0.1.13) review captures — palette sampled from the listing media.
// Boots against the dev harness (npm run dev:harness, port 5186):
//   node tools/capture-fixbatch.mjs
// Shots land in files/app-review/character-sheet-studio/theme-indigo-lineup/.

import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire('/home/hatch/workspace/.clickthrough/');
const puppeteer = require('puppeteer-core');

const CHROME =
  '/home/hatch/workspace/.clickthrough/chrome-headless-shell-linux64/chrome-headless-shell';
const BASE = process.env.CSS_SHOT_BASE ?? 'http://localhost:5186';
const OUT = path.resolve(
  '/home/hatch/workspace/goals/build-and-publish-apps-that-make-money-24-7/files/app-review/character-sheet-studio/theme-indigo-lineup',
);
fs.mkdirSync(OUT, { recursive: true });

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNQU9MGAADtAHibSjiOAAAAAElFTkSuQmCC',
  'base64',
);

const HIDE_DEV_CHROME = `
  [data-harness-banner], [data-harness-scenario-panel],
  [data-harness="true"] > details { display: none !important; }
  html, body { background: #140734; }
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
  return page;
}

const settle = (ms = 700) => new Promise((r) => setTimeout(r, ms));

async function gotoTab(page, tab, needle, extra = '') {
  await page.goto(`${BASE}/?tab=${tab}${extra}`, { waitUntil: 'load', timeout: 60_000 });
  await page.waitForFunction((n) => document.body.innerText.includes(n), { timeout: 30_000 }, needle);
  await settle();
}

async function clickByText(page, text) {
  const clicked = await page.evaluate((t) => {
    const el = [...document.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === t,
    );
    if (el) { el.click(); return true; }
    return false;
  }, text);
  if (!clicked) throw new Error(`button not found: ${text}`);
}

async function shoot(page, name) {
  await page.screenshot({ path: path.join(OUT, name), fullPage: true });
  console.log('shot', name);
}

const DESKTOP = { width: 1440, height: 900, deviceScaleFactor: 1 };
const MOBILE = { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };

// --- 1–2: Builder (default + Advanced open) ---------------------------------
{
  const page = await newShotPage(DESKTOP);
  await gotoTab(page, 'builder', 'Enhance prompts');
  await shoot(page, '01-builder.png');
  await page.click('[data-testid="se-builder-advanced-toggle"]');
  await page.waitForFunction(() => document.body.innerText.includes('Buzz pool'), { timeout: 10_000 });
  await settle(400);
  await shoot(page, '02-builder-advanced.png');
  await page.close();
}

// --- 3: Builder confirm with a 0 balance (guard blocks Generate) ------------
{
  const page = await newShotPage(DESKTOP);
  await gotoTab(page, 'builder', 'Enhance prompts', '&balance=0');
  await page.click('[data-testid="se-builder-price"]');
  await page.waitForSelector('[data-testid="se-builder-insufficient"]', { timeout: 60_000 });
  await settle(400);
  await shoot(page, '03-builder-insufficient.png');
  await page.close();
}

// --- 4–7: Sheet View (queued, batch confirm, done+quiet, More open) ---------
{
  const page = await newShotPage(DESKTOP);
  await gotoTab(page, 'sheets', 'Kaida turnaround v1');
  await clickByText(page, 'Open');
  await page.waitForSelector('[data-testid="se-submit-all"]', { timeout: 30_000 });
  await settle(400);
  await shoot(page, '04-sheetview-queued.png');
  await page.click('[data-testid="se-submit-all"]');
  await page.waitForSelector('[data-testid="se-submit-all-confirm-submit"]', { timeout: 60_000 });
  await settle(400);
  await shoot(page, '05-sheetview-batch-confirm.png');
  await page.click('[data-testid="se-submit-all-confirm-submit"]');
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll('[data-testid="se-panel-post"]')].length >= 6,
    { timeout: 120_000 },
  );
  await settle(800);
  await shoot(page, '06-sheetview-done.png');
  await page.click('[data-testid="se-panel-more"]');
  await settle(500);
  await shoot(page, '07-sheetview-more.png');
  await page.close();
}

// --- 8: Cancel sticks (wait past two old poll cycles, then shoot) -----------
{
  const page = await newShotPage(DESKTOP);
  await gotoTab(page, 'sheets', 'Kaida turnaround v1');
  await clickByText(page, 'Open');
  await page.waitForSelector('[data-testid="se-submit-all"]', { timeout: 30_000 });
  // Submit ONE panel, then cancel it while it generates.
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === 'Submit',
    );
    btn?.click();
  });
  await page.waitForSelector('[data-testid="se-panel-confirm-submit"]', { timeout: 30_000 });
  await page.click('[data-testid="se-panel-confirm-submit"]');
  await page.waitForSelector('[data-testid="se-panel-skeleton"]', { timeout: 30_000 });
  await clickByText(page, 'Cancel');
  // The pre-fix bug resurrected the panel within ~4s of polling.
  await settle(6500);
  await shoot(page, '08-sheetview-canceled.png');
  await page.close();
}


// --- Theme extras: Characters + Stacks lists --------------------------------
{
  const page = await newShotPage(DESKTOP);
  await gotoTab(page, 'characters', 'Kaida');
  await shoot(page, '11-characters.png');
  await gotoTab(page, 'stacks', 'SDXL Anime');
  await shoot(page, '12-stacks.png');
  await page.close();
}

// --- 9–10: Mobile ------------------------------------------------------------
{
  const page = await newShotPage(MOBILE);
  await gotoTab(page, 'builder', 'Enhance prompts');
  await shoot(page, '09-mobile-builder.png');
  await gotoTab(page, 'sheets', 'Kaida turnaround v1');
  await clickByText(page, 'Open');
  await page.waitForSelector('[data-testid="se-submit-all"]', { timeout: 30_000 });
  await settle(400);
  await shoot(page, '10-mobile-sheetview.png');
  await page.close();
}

await browser.close();
console.log('done ->', OUT);
if (problems.length) {
  console.log('PAGE PROBLEMS (first 10):');
  for (const p of [...new Set(problems)].slice(0, 10)) console.log(' ', p);
}
