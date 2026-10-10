// New-sheet flow shots (v0.1.20): stack cards, inline stack create with
// presets, panel icon cards, custom panel editor, mobile.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire('/home/hatch/workspace/.clickthrough/');
const puppeteer = require('puppeteer-core');
const CHROME = '/home/hatch/workspace/.clickthrough/chrome-headless-shell-linux64/chrome-headless-shell';
const BASE = process.env.CSS_SHOT_BASE ?? 'http://localhost:5186';
const OUT = '/home/hatch/workspace/goals/build-and-publish-apps-that-make-money-24-7/files/app-review/character-sheet-studio/newflow-v0120';
fs.mkdirSync(OUT, { recursive: true });

const HIDE = `[data-harness-banner], [data-harness-scenario-panel], [data-harness="true"] > details { display: none !important; } html, body { background: #0e1016; }`;
const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'shell', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const problems = [];

async function newPage(viewport) {
  const page = await browser.newPage();
  await page.setViewport(viewport);
  await page.evaluateOnNewDocument((css) => {
    const inject = () => { const s = document.createElement('style'); s.textContent = css; document.head?.appendChild(s); };
    if (document.head) inject(); else document.addEventListener('DOMContentLoaded', inject, { once: true });
  }, HIDE);
  page.on('pageerror', (e) => problems.push(String(e).slice(0, 200)));
  return page;
}
const settle = (ms = 600) => new Promise((r) => setTimeout(r, ms));
const clickText = (page, text) => page.evaluate((t) => {
  const b = [...document.querySelectorAll('button')].find((x) => x.textContent?.trim() === t);
  b?.click();
  return !!b;
}, text);

const page = await newPage({ width: 1440, height: 1000 });
await page.goto(`${BASE}/`, { waitUntil: 'load', timeout: 60_000 });
await page.waitForFunction(() => document.body.innerText.includes('Kaida'), { timeout: 30_000 });

// Make a fresh (sheetless) character via the stepped form + randomizer.
await clickText(page, 'New character');
await page.waitForSelector('[data-testid="char-randomize"]', { timeout: 30_000 });
await page.click('[data-testid="char-randomize"]');
for (let i = 0; i < 5; i++) { await page.click('[data-testid="char-step-next"]'); await settle(150); }
await page.click('[data-testid="char-save"]');
await page.waitForFunction(() => document.body.innerText.includes('Characters'), { timeout: 30_000 });
await settle();

// Click the fresh character's card — 0 sheets → the new-sheet flow.
await page.evaluate(() => {
  const cards = [...document.querySelectorAll('[data-testid="char-card"]')];
  (cards[cards.length - 1]).click();
});
await page.waitForSelector('[data-testid="builder-stack-card"]', { timeout: 30_000 });
await settle();
await page.screenshot({ path: path.join(OUT, '01-new-sheet-flow.png'), fullPage: true });

// Inline stack create with presets.
await page.click('[data-testid="builder-stack-new"]');
await page.waitForSelector('[data-testid="stack-name"]', { timeout: 30_000 });
await page.click('[data-testid="builder-stack-preset-anime"]');
await settle(400);
await page.screenshot({ path: path.join(OUT, '02-inline-stack-create.png'), fullPage: true });
await clickText(page, 'Cancel');
await settle(300);

// Custom panel editor (Enhance lives here).
await page.click('[data-testid="builder-panel-new"]');
await page.waitForSelector('[data-testid="builder-panel-prompt"]', { timeout: 30_000 });
await page.type('[data-testid="builder-panel-label"]', 'Sky whale ride');
await page.type('[data-testid="builder-panel-prompt"]', 'riding a sky-whale at dawn, wind in her hair');
await settle(400);
await page.screenshot({ path: path.join(OUT, '03-custom-panel-editor.png'), fullPage: true });
await page.click('[data-testid="builder-panel-add"]');
await page.waitForSelector('[data-testid="builder-panel-custom"]', { timeout: 30_000 });
await settle(400);
await page.screenshot({ path: path.join(OUT, '04-custom-panel-added.png'), fullPage: true });
await page.close();

const m = await newPage({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
await m.goto(`${BASE}/`, { waitUntil: 'load', timeout: 60_000 });
await m.waitForFunction(() => document.body.innerText.includes('Kaida'), { timeout: 30_000 });
await clickText(m, 'Sheet Builder');
await m.waitForSelector('[data-testid="builder-stack-card"]', { timeout: 30_000 });
await settle();
await m.screenshot({ path: path.join(OUT, '05-mobile-flow.png'), fullPage: true });
await m.close();

await browser.close();
console.log('done ->', OUT);
if (problems.length) console.log('PAGE PROBLEMS:', [...new Set(problems)].slice(0, 5).join(' | '));
