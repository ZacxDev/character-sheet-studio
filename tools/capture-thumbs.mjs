// Character-card thumbnails, enlarged (v0.1.15) — one focused shot.
// Generates the seeded sheet to done in-session so the card shows thumbs.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire('/home/hatch/workspace/.clickthrough/');
const puppeteer = require('puppeteer-core');
const CHROME = '/home/hatch/workspace/.clickthrough/chrome-headless-shell-linux64/chrome-headless-shell';
const BASE = process.env.CSS_SHOT_BASE ?? 'http://localhost:5186';
const OUT = '/home/hatch/workspace/goals/build-and-publish-apps-that-make-money-24-7/files/app-review/character-sheet-studio/thumbs-v0115';
fs.mkdirSync(OUT, { recursive: true });

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNQU9MGAADtAHibSjiOAAAAAElFTkSuQmCC', 'base64');
const HIDE = `[data-harness-banner], [data-harness-scenario-panel], [data-harness="true"] > details { display: none !important; } html, body { background: #0e1016; }`;

const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'shell', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 900 });
await page.evaluateOnNewDocument((css) => {
  const inject = () => { const s = document.createElement('style'); s.textContent = css; document.head?.appendChild(s); };
  if (document.head) inject(); else document.addEventListener('DOMContentLoaded', inject, { once: true });
}, HIDE);
await page.setRequestInterception(true);
page.on('request', (req) => {
  if (req.resourceType() === 'image') void req.respond({ status: 200, contentType: 'image/png', body: PNG });
  else void req.continue();
});
const problems = [];
page.on('pageerror', (e) => problems.push(String(e).slice(0, 200)));

await page.goto(`${BASE}/?tab=sheets`, { waitUntil: 'load', timeout: 60_000 });
await page.waitForFunction(() => document.body.innerText.includes('Kaida turnaround v1'), { timeout: 30_000 });
await page.evaluate(() => [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Open')?.click());
await page.waitForSelector('[data-testid="se-submit-all"]', { timeout: 30_000 });
await page.click('[data-testid="se-submit-all"]');
await page.waitForSelector('[data-testid="se-submit-all-confirm-submit"]', { timeout: 60_000 });
await page.click('[data-testid="se-submit-all-confirm-submit"]');
await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="se-panel-post"]')].length >= 6, { timeout: 120_000 });
await page.evaluate(() => [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Characters')?.click());
await page.waitForSelector('[data-testid="char-card-thumb"]', { timeout: 30_000 });
await new Promise((r) => setTimeout(r, 500));
await page.screenshot({ path: path.join(OUT, '01-characters-thumbs.png'), fullPage: true });
await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
await new Promise((r) => setTimeout(r, 500));
await page.screenshot({ path: path.join(OUT, '02-characters-thumbs-mobile.png'), fullPage: true });
await browser.close();
console.log('done ->', OUT);
if (problems.length) console.log('PAGE PROBLEMS:', [...new Set(problems)].slice(0, 5).join(' | '));
