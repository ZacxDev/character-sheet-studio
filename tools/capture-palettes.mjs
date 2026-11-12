// Palette preview shots (dark theme only): inject token overrides per palette,
// shoot the Sheet Builder with identical seed/state each time.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire('/home/hatch/workspace/.clickthrough/');
const puppeteer = require('puppeteer-core');
const CHROME = '/home/hatch/workspace/.clickthrough/chrome-headless-shell-linux64/chrome-headless-shell';
const BASE = process.env.CSS_SHOT_BASE ?? 'http://localhost:5186';
const OUT = '/home/hatch/workspace/goals/build-and-publish-apps-that-make-money-24-7/files/app-review/character-sheet-studio/palette-previews';
fs.mkdirSync(OUT, { recursive: true });

const TOKENS = (name, t) => `.css-root[data-preview="${name}"] {
  --civitai-color-body: ${t.body}; --civitai-color-surface: ${t.surface};
  --civitai-color-surface-2: ${t.surface2}; --civitai-color-border: ${t.border};
  --civitai-color-text: ${t.text}; --civitai-color-text-dimmed: ${t.dimmed};
  --civitai-color-primary: ${t.primary}; --civitai-color-primary-hover: ${t.hover};
  --civitai-color-primary-fg: ${t.fg}; --civitai-color-primary-light: ${t.light};
  --civitai-color-info: ${t.info}; --civitai-color-success: ${t.success};
  --civitai-color-warning: ${t.warning}; --civitai-color-error: ${t.error};
  --civitai-color-media-placeholder: ${t.ph};
}`;

const PALETTES = [
  { name: 'indigo-vivid', file: 'A-indigo-vivid.png', tokens: {
    body:'#140734', surface:'#1c0c51', surface2:'#281668', border:'#3f2c88',
    text:'#edf1fa', dimmed:'#a49ed2', primary:'#00dcfc', hover:'#45e6fc', fg:'#03222e',
    light:'rgba(0,220,252,0.14)', info:'#62bfe8', success:'#41d97e', warning:'#ffb02e',
    error:'#ff5964', ph:'#070121' } },
  { name: 'ember', file: 'B-ember.png', tokens: {
    body:'#12100e', surface:'#1a1613', surface2:'#251e17', border:'#372c21',
    text:'#f4ede3', dimmed:'#ac9f8b', primary:'#e8833a', hover:'#f29a54', fg:'#220f02',
    light:'rgba(232,131,58,0.14)', info:'#7ba7cc', success:'#6fbf73', warning:'#f5b841',
    error:'#e06a5f', ph:'#0b0907' } },
  { name: 'verdant', file: 'C-verdant.png', tokens: {
    body:'#0d1410', surface:'#121b16', surface2:'#1a271f', border:'#2a3b2e',
    text:'#eef4ee', dimmed:'#9db5a2', primary:'#4fca7f', hover:'#6bd998', fg:'#06281a',
    light:'rgba(79,202,127,0.14)', info:'#7ba7cc', success:'#4fca7f', warning:'#dfa244',
    error:'#e26d74', ph:'#090f0b' } },
  { name: 'rose-noir', file: 'D-rose-noir.png', tokens: {
    body:'#120d11', surface:'#1a1216', surface2:'#251a21', border:'#362730',
    text:'#f4ecf0', dimmed:'#b39daa', primary:'#e5486c', hover:'#ef6584', fg:'#2b0713',
    light:'rgba(229,72,108,0.14)', info:'#9bb8d8', success:'#57b87e', warning:'#f0b429',
    error:'#e5484d', ph:'#0b080a' } },
];

const CSS = PALETTES.map((p) => TOKENS(p.name, p.tokens)).join('\n') +
  `\n[data-harness-banner], [data-harness-scenario-panel], [data-harness="true"] > details { display: none !important; } html, body { background: #0e1016; }`;

const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'shell', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const problems = [];
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 1000 });
await page.evaluateOnNewDocument((css) => {
  const inject = () => { const s = document.createElement('style'); s.textContent = css; document.head?.appendChild(s); };
  if (document.head) inject(); else document.addEventListener('DOMContentLoaded', inject, { once: true });
}, CSS);
page.on('pageerror', (e) => problems.push(String(e).slice(0, 200)));

await page.goto(`${BASE}/`, { waitUntil: 'load', timeout: 60_000 });
await page.waitForFunction(() => document.body.innerText.includes('Kaida'), { timeout: 30_000 });
await page.evaluate(() => {
  const b = [...document.querySelectorAll('button')].find((x) => x.textContent?.trim() === 'Sheet Builder');
  b?.click();
});
await page.waitForSelector('[data-testid="builder-panel-card"]', { timeout: 30_000 });
await new Promise((r) => setTimeout(r, 600));

for (const p of PALETTES) {
  await page.evaluate((n) => document.querySelector('.css-root')?.setAttribute('data-preview', n), p.name);
  await new Promise((r) => setTimeout(r, 350));
  await page.screenshot({ path: path.join(OUT, p.file), fullPage: true });
  console.log('shot', p.file);
}

await browser.close();
console.log('done ->', OUT);
if (problems.length) console.log('PAGE PROBLEMS:', [...new Set(problems)].slice(0, 5).join(' | '));
