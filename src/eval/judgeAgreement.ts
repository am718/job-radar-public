import fs from 'node:fs';
import { evalPaths } from './paths.js';
import { parseSpotcheckMd } from './judgelib.js';
// npm run judge:agreement  — reads your verdicts from eval/judge_spotcheck.md
const P = evalPaths(), f = P.judgeSpot;
if (!fs.existsSync(f)) { console.error(`${f} not found (run npm run judge first)`); process.exit(2); }
const r = parseSpotcheckMd(fs.readFileSync(f, 'utf8'));
if (r.blank || r.invalid) { console.error(`incomplete: ${r.blank} blank, ${r.invalid} invalid of ${r.items}. Fill each "Your call" with agree or disagree.`); process.exit(2); }
const out = { ...r, human_judge_agreement: r.agree / r.items, n: r.items };
fs.mkdirSync(P.results, { recursive: true });
fs.writeFileSync(`${P.results}/judge_agreement.json`, JSON.stringify(out, null, 1));
console.log(`human-judge agreement: ${r.agree}/${r.items}`);
