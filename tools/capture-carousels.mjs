// v0.1.26 review shots: profile images everywhere, Builder carousels
// (character + stack), Sheet View stack switcher, editor Profile step.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire('/home/hatch/workspace/.clickthrough/');
const puppeteer = require('puppeteer-core');
const CHROME = '/home/hatch/workspace/.clickthrough/chrome-headless-shell-linux64/chrome-headless-shell';
const BASE = process.env.CSS_SHOT_BASE ?? 'http://localhost:5186';
const OUT = '/home/hatch/workspace/goals/build-and-publish-apps-that-make-money-24-7/files/app-review/character-sheet-studio/carousels-v0126';
fs.mkdirSync(OUT, { recursive: true });

const HIDE = `[data-harness-banner], [data-harness-scenario-panel], [data-harness="true"] > details { display: none !important; } html, body { background: #120d11; }`;
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

const page = await newPage({ width: 1440, height: 1000 });
await page.goto(`${BASE}/`, { waitUntil: 'load', timeout: 60_000 });
await page.waitForFunction(() => document.body.innerText.includes('Kaida'), { timeout: 30_000 });
await settle();
await page.screenshot({ path: path.join(OUT, '01-characters.png'), fullPage: true });

// Character page: profile header + sheet carousel with real images.
await page.click('[data-testid="char-card"]');
await page.waitForSelector('[data-testid="char-view-profile"]', { timeout: 30_000 });
await settle();
await page.screenshot({ path: path.join(OUT, '02-character.png'), fullPage: true });

// Sheet View: stack switcher carousel.
await page.click('[data-testid="char-view-sheet"]');
await page.waitForSelector('[data-testid="se-stack-card"]', { timeout: 30_000 });
await settle();
await page.screenshot({ path: path.join(OUT, '03-sheet-stack.png'), fullPage: true });

// Back to characters via the breadcrumb, then into the editor's Profile step.
await page.evaluate(() => {
  [...document.querySelectorAll('a')].find((a) => a.textContent.trim() === 'Characters')?.click();
});
await page.waitForSelector('[data-testid="char-card"]', { timeout: 30_000 });
await page.click('[data-testid="char-menu"]');
await page.waitForSelector('[data-testid="char-menu-edit"]', { timeout: 10_000 });
await page.click('[data-testid="char-menu-edit"]');
await page.waitForSelector('[data-testid="char-step-indicator"]', { timeout: 30_000 });
for (let i = 0; i < 5; i++) {
  await page.click('[data-testid="char-step-next"]');
  await settle(250);
}
await page.waitForSelector('[data-testid="char-profile-option"]', { timeout: 10_000 });
await settle(300);
await page.screenshot({ path: path.join(OUT, '04-editor-profile.png'), fullPage: true });
await page.close();

// Builder carousels, desktop + mobile.
const b = await newPage({ width: 1440, height: 1000 });
await b.goto(`${BASE}/`, { waitUntil: 'load', timeout: 60_000 });
await b.waitForFunction(() => document.body.innerText.includes('Kaida'), { timeout: 30_000 });
await b.evaluate(() => {
  [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Sheet Builder')?.click();
});
await b.waitForSelector('[data-testid="builder-char-card"]', { timeout: 30_000 });
await settle();
await b.screenshot({ path: path.join(OUT, '05-builder-carousels.png'), fullPage: true });
await b.close();

const m = await newPage({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
await m.goto(`${BASE}/`, { waitUntil: 'load', timeout: 60_000 });
await m.waitForFunction(() => document.body.innerText.includes('Kaida'), { timeout: 30_000 });
await m.click('[data-testid="nav-toggle"]');
await m.waitForFunction(
  () => [...document.querySelectorAll('button')].some((x) => x.textContent.trim() === 'Sheet Builder'),
  { timeout: 10_000 },
);
await m.evaluate(() => {
  [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Sheet Builder')?.click();
});
await m.waitForSelector('[data-testid="builder-char-card"]', { timeout: 30_000 });
await settle();
await m.screenshot({ path: path.join(OUT, '06-mobile-builder.png'), fullPage: true });
await m.close();

await browser.close();
console.log('done ->', OUT);
if (problems.length) console.log('PAGE PROBLEMS:', [...new Set(problems)].slice(0, 5).join(' | '));
