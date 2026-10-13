// v0.1.28 review shots: (1) new sheet flow — landing on Review auto-prices
// into the confirm card with no Price click; (2) Sheet View with the stack
// selector and Post-sheet button removed.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire('/home/hatch/workspace/.clickthrough/');
const puppeteer = require('puppeteer-core');
const CHROME = '/home/hatch/workspace/.clickthrough/chrome-headless-shell-linux64/chrome-headless-shell';
const BASE = process.env.CSS_SHOT_BASE ?? 'http://localhost:5186';
const OUT = '/home/hatch/workspace/goals/build-and-publish-apps-that-make-money-24-7/files/app-review/character-sheet-studio/autoprice-v0128';
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
// New sheet flow: character page -> New sheet -> walk the steps -> Review.
await page.click('[data-testid="char-card"]');
await page.waitForSelector('[data-testid="char-view-new-sheet"]', { timeout: 30_000 });
await page.click('[data-testid="char-view-new-sheet"]');
await page.waitForSelector('[data-testid="builder-step-next"]', { timeout: 30_000 });
await page.click('[data-testid="builder-step-next"]');
await page.waitForSelector('[data-testid="builder-panel-card"]', { timeout: 30_000 });
await page.click('[data-testid="builder-step-next"]');
// No Price click: the confirm card must appear on its own.
await page.waitForFunction(
  () => [...document.querySelectorAll('button')].some((b) => /Generate \d+ panels? ·/.test(b.textContent ?? '')),
  { timeout: 30_000 },
);
await settle();
await page.screenshot({ path: path.join(OUT, '01-review-autopriced.png'), fullPage: true });

// Sheet View: selector + post-sheet button gone.
await page.evaluate(() => {
  [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Characters')?.click();
});
await page.waitForFunction(() => document.body.innerText.includes('Kaida'), { timeout: 30_000 });
await page.click('[data-testid="char-card"]');
await page.waitForSelector('[data-testid="char-view-sheet"]', { timeout: 30_000 });
await page.click('[data-testid="char-view-sheet"]');
await page.waitForSelector('[data-testid="se-new-sheet"]', { timeout: 30_000 });
await settle();
await page.screenshot({ path: path.join(OUT, '02-sheet-no-selector.png'), fullPage: true });
await page.close();

await browser.close();
console.log('done ->', OUT);
if (problems.length) console.log('PAGE PROBLEMS:', [...new Set(problems)].slice(0, 5).join(' | '));
