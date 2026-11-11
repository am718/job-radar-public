import fs from 'node:fs';
import { evalPaths } from './paths.js';
import { parseSpotcheckMd } from './judgelib.js';
// npm run proxy:agreement — computes YOUR agreement with the proxy from eval/proxy_spotcheck.md
const P = evalPaths(), f = P.proxySpot;
if (!fs.existsSync(f)) { console.error(`${f} not found`); process.exit(2); }
const r = parseSpotcheckMd(fs.readFileSync(f, 'utf8'));
if (r.blank || r.invalid) { console.error(`PENDING: ${r.blank} blank, ${r.invalid} invalid of ${r.items}. Fill each "Your call" with agree or disagree.`); process.exit(2); }
fs.mkdirSync(P.results, { recursive: true });
fs.writeFileSync(`${P.results}/proxy_agreement.json`, JSON.stringify({ ...r, human_proxy_agreement: r.agree / r.items, n: r.items }, null, 1));
console.log(`you agree with the proxy on ${r.agree}/${r.items}`);
