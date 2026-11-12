// v0.1.29 review shots: character editor Prompts step — per-field Enhance
// buttons, and the priced confirm for the positive field.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire('/home/hatch/workspace/.clickthrough/');
const puppeteer = require('puppeteer-core');
const CHROME = '/home/hatch/workspace/.clickthrough/chrome-headless-shell-linux64/chrome-headless-shell';
const BASE = process.env.CSS_SHOT_BASE ?? 'http://localhost:5186';
const OUT = '/home/hatch/workspace/goals/build-and-publish-apps-that-make-money-24-7/files/app-review/character-sheet-studio/fieldenhance-v0129';
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
await page.evaluate(() => {
  [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'New character')?.click();
});
await page.waitForSelector('[data-testid="char-name"]', { timeout: 30_000 });
await page.type('[data-testid="char-name"]', 'Nyx');
await page.click('[data-testid="char-step-next"]');
await page.waitForSelector('[data-testid="char-positive-prompt"]', { timeout: 30_000 });
await page.type('[data-testid="char-positive-prompt"]', 'a cyberpunk fox mercenary, lean build, silver-streaked fur');
await page.type('[data-testid="char-negative-prompt"]', 'blurry, watermark');
await settle();
await page.screenshot({ path: path.join(OUT, '01-prompts-step.png'), fullPage: true });

await page.click('[data-testid="char-enhance-positive"]');
await page.waitForSelector('[data-testid="char-enhance-confirm"]', { timeout: 30_000 });
await settle(300);
await page.screenshot({ path: path.join(OUT, '02-enhance-confirm.png'), fullPage: true });
await page.close();

const m = await newPage({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
await m.goto(`${BASE}/`, { waitUntil: 'load', timeout: 60_000 });
await m.waitForFunction(() => document.body.innerText.includes('Kaida'), { timeout: 30_000 });
await m.evaluate(() => {
  [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'New character')?.click();
});
await m.waitForSelector('[data-testid="char-name"]', { timeout: 30_000 });
await m.type('[data-testid="char-name"]', 'Nyx');
await m.click('[data-testid="char-step-next"]');
await m.waitForSelector('[data-testid="char-positive-prompt"]', { timeout: 30_000 });
await settle();
await m.screenshot({ path: path.join(OUT, '03-mobile-prompts.png'), fullPage: true });
await m.close();

await browser.close();
console.log('done ->', OUT);
if (problems.length) console.log('PAGE PROBLEMS:', [...new Set(problems)].slice(0, 5).join(' | '));
