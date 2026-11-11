import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
// Screenshots of the PUBLIC DEMO only (sample data), for the README. Never of the local dashboard, which shows real jobs.
const file = path.resolve(process.argv[2] ?? 'docs/index.html'), outDir = path.resolve(process.argv[3] ?? 'docs/shots');
fs.mkdirSync(outDir, { recursive: true });
const b = await chromium.launch({ headless: true });
const p = await (await b.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
await p.goto('file://' + file); await p.waitForSelector('tbody tr');
await p.screenshot({ path: path.join(outDir, 'demo-table.png') });
await p.selectOption('#f-arr', 'remote+hybrid'); await p.fill('#f-lo', '60');
await p.locator('tbody tr').first().click(); await p.waitForSelector('#detail h2');
await p.screenshot({ path: path.join(outDir, 'demo-filtered-detail.png'), fullPage: true });
await b.close(); console.log(`screenshots: ${outDir}/demo-table.png, demo-filtered-detail.png`);
