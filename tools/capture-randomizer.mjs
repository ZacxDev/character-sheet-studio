// Randomizer form shots (v0.1.18): empty form, rolled form, dirty-confirm.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire('/home/hatch/workspace/.clickthrough/');
const puppeteer = require('puppeteer-core');
const CHROME = '/home/hatch/workspace/.clickthrough/chrome-headless-shell-linux64/chrome-headless-shell';
const BASE = process.env.CSS_SHOT_BASE ?? 'http://localhost:5186';
const OUT = '/home/hatch/workspace/goals/build-and-publish-apps-that-make-money-24-7/files/app-review/character-sheet-studio/randomizer-v0118';
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
const settle = (ms = 500) => new Promise((r) => setTimeout(r, ms));

const page = await newPage({ width: 1440, height: 900 });
await page.goto(`${BASE}/?tab=characters`, { waitUntil: 'load', timeout: 60_000 });
await page.waitForFunction(() => document.body.innerText.includes('Kaida'), { timeout: 30_000 });
await page.evaluate(() => [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'New character')?.click());
await page.waitForSelector('[data-testid="char-name-dice"]', { timeout: 30_000 });
await settle();
await page.screenshot({ path: path.join(OUT, '01-create-form.png'), fullPage: true });

// Roll a whole character — form fills from empty.
await page.click('[data-testid="char-randomize"]');
await settle(400);
await page.screenshot({ path: path.join(OUT, '02-randomized-form.png'), fullPage: true });

// Type something of "mine", then randomize again — confirm must appear.
await page.evaluate(() => {
  const ta = [...document.querySelectorAll('textarea')][0];
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
  setter.call(ta, 'my own concept, do not lose');
  ta.dispatchEvent(new Event('input', { bubbles: true }));
});
await page.click('[data-testid="char-randomize"]');
await page.waitForSelector('[data-testid="char-randomize-confirm"]', { timeout: 30_000 });
await settle(400);
await page.screenshot({ path: path.join(OUT, '03-randomize-confirm.png'), fullPage: true });
await page.close();

const m = await newPage({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
await m.goto(`${BASE}/?tab=characters`, { waitUntil: 'load', timeout: 60_000 });
await m.waitForFunction(() => document.body.innerText.includes('Kaida'), { timeout: 30_000 });
await m.evaluate(() => [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'New character')?.click());
await m.waitForSelector('[data-testid="char-name-dice"]', { timeout: 30_000 });
await m.click('[data-testid="char-randomize"]');
await settle(400);
await m.screenshot({ path: path.join(OUT, '04-mobile-randomized.png'), fullPage: true });
await m.close();

await browser.close();
console.log('done ->', OUT);
if (problems.length) console.log('PAGE PROBLEMS:', [...new Set(problems)].slice(0, 5).join(' | '));
