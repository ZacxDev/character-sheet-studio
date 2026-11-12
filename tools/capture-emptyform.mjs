// v0.1.30 review shots: empty character list IS the create form (prefilled
// random name, per-field dice, no Randomize button), and saving lands on
// the new character's details page. The seeded characters are deleted via
// the UI so the empty state is genuinely reached.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire('/home/hatch/workspace/.clickthrough/');
const puppeteer = require('puppeteer-core');
const CHROME = '/home/hatch/workspace/.clickthrough/chrome-headless-shell-linux64/chrome-headless-shell';
const BASE = process.env.CSS_SHOT_BASE ?? 'http://localhost:5186';
const OUT = '/home/hatch/workspace/goals/build-and-publish-apps-that-make-money-24-7/files/app-review/character-sheet-studio/emptyform-v0130';
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

async function emptyTheList(page) {
  await page.goto(`${BASE}/`, { waitUntil: 'load', timeout: 60_000 });
  await page.waitForFunction(() => document.body.innerText.includes('Kaida'), { timeout: 30_000 });
  for (let i = 0; i < 3; i++) {
    const menus = await page.$$('[data-testid="char-menu"]');
    if (menus.length === 0) break;
    await menus[0].click();
    await page.waitForSelector('[data-testid="char-menu-delete"]', { timeout: 10_000 });
    await page.click('[data-testid="char-menu-delete"]');
    await page.waitForSelector('[data-testid="char-confirm-delete"]', { timeout: 10_000 });
    await page.click('[data-testid="char-confirm-delete"]');
    await settle(800);
  }
  await page.waitForSelector('[data-testid="char-name"]', { timeout: 30_000 });
  await settle();
}

const page = await newPage({ width: 1440, height: 1000 });
await emptyTheList(page);
await page.screenshot({ path: path.join(OUT, '01-empty-form.png'), fullPage: true });

await page.click('[data-testid="char-step-next"]');
await page.waitForSelector('[data-testid="char-positive-dice"]', { timeout: 30_000 });
await page.click('[data-testid="char-positive-dice"]');
await settle(300);
await page.screenshot({ path: path.join(OUT, '02-prompts-dice.png'), fullPage: true });

// Walk to the end and save — should land on the character details page.
for (let i = 0; i < 4; i++) await page.click('[data-testid="char-step-next"]');
await page.waitForSelector('[data-testid="char-save"]', { timeout: 30_000 });
await page.click('[data-testid="char-save"]');
await page.waitForSelector('[data-testid="char-view-new-sheet"]', { timeout: 30_000 });
await settle();
await page.screenshot({ path: path.join(OUT, '03-lands-on-character.png'), fullPage: true });
await page.close();

const m = await newPage({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
await emptyTheList(m);
await m.screenshot({ path: path.join(OUT, '04-mobile-empty-form.png'), fullPage: true });
await m.close();

await browser.close();
console.log('done ->', OUT);
if (problems.length) console.log('PAGE PROBLEMS:', [...new Set(problems)].slice(0, 5).join(' | '));
