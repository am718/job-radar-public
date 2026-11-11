import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { installGuards, safeClick } from './guard.js';
import { waitForForm } from './ats.js';
import { USER_AGENT } from '../config.js';

// REAL-FORM HARNESS (read-only). usage:
//   tsx src/apply/harness.ts capture <name> <url> [greenhouse|lever|ashby]
// Loads the live application page (GET only; every non-GET request is blocked, no submit is ever clicked), opens each dropdown to RECORD its real option list,
// and saves a sanitized snapshot to tests/fixtures/<name>.html so the fill logic can be tested offline against the real option text.
// The snapshot contains only the empty form: scripts/styles/images stripped, no personal data (nothing is typed here).
const [cmd, name, url, ats = 'greenhouse'] = process.argv.slice(2);
if (cmd !== 'capture' || !name || !url) { console.error('usage: tsx src/apply/harness.ts capture <name> <url> [greenhouse|lever|ashby]'); process.exit(1); }

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ userAgent: USER_AGENT, viewport: { width: 1280, height: 1000 } });
await installGuards(ctx);
const page = await ctx.newPage();
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
await waitForForm(page, ats as any);
await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
await page.waitForTimeout(2500);   // Ashby renders the application after its GraphQL calls
// Ashby/Lever show the posting first; the form may be at /application
const recorded: Record<string, string[]> = {};
const combos = await page.locator('input[role="combobox"]').all();
for (const [i, c] of combos.entries()) {
  try {
    if (!(await c.isVisible())) continue;
    await safeClick(c, 'open dropdown to record options');
    await page.locator('[role="option"]:visible').first().waitFor({ state: 'visible', timeout: 1500 }).catch(() => {});
    const texts = (await page.locator('[role="option"]:visible').allInnerTexts()).map((t) => t.trim()).filter(Boolean);
    if (texts.length && texts.length <= 300) { const id = (await c.getAttribute('id')) ?? `combo-${i}`; recorded[id] = texts; await c.evaluate((el, o) => el.setAttribute('data-jr-options', JSON.stringify(o)), texts); }
    await c.evaluate((el) => (el as HTMLElement).blur());
  } catch { /* a combobox that cannot be opened is simply not recorded */ }
}
const html = await page.evaluate(() => (document.querySelector('form#application-form, form') ?? document.querySelector('main') ?? document.body).outerHTML);
const clean = html
  .replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<iframe[\s\S]*?<\/iframe>/gi, '')   // iframes (hCaptcha/recaptcha) are invisible on the live page only because of CSS, which a static snapshot loses.replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<svg[\s\S]*?<\/svg>/gi, '').replace(/<img[^>]*>/gi, '').replace(/<link[^>]*>/gi, '')
  .replace(/(<input[^>]*type="hidden"[^>]*value=")([^"]{120,})(")/gi, '$1x$3').replace(/ style="[^"]*"/gi, '').replace(/ value="(?!x")[^"]{0,200}"(?=[^>]*type="text")/gi, ' value=""')
  .replace(/(name="[^"]*(?:token|csrf|nonce)[^"]*"[^>]*value=")[^"]{8,}(")/gi, '$1x$2')   // session tokens never go into a fixture
  .replace(/<form([^>]*)>/i, '<form$1 onsubmit="return false">');
fs.mkdirSync('tests/fixtures', { recursive: true });
const out = path.join('tests/fixtures', `${name}.html`);
fs.writeFileSync(out, `<!DOCTYPE html><html><head><meta charset="utf-8"><title>snapshot ${name} (captured ${new Date().toISOString().slice(0, 10)} from ${new URL(url).host}, inert, empty form)</title></head><body>\n${clean}\n<script src="../../fixtures/forms/mock-widgets.js"></script></body></html>\n`);
console.log(`${name}: ${clean.length} chars, ${Object.keys(recorded).length} dropdown option lists recorded -> ${out}`);
for (const [k, v] of Object.entries(recorded)) console.log(`  ${k}: ${v.slice(0, 6).join(' | ')}${v.length > 6 ? ` ... (${v.length})` : ''}`);
await browser.close();
