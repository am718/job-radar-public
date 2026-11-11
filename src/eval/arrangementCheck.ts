import fs from 'node:fs';
import { evalPaths } from './paths.js';
import crypto from 'node:crypto';
import { openDb } from '../store.js';
import { detectFromText } from '../arrangement.js';

// npm run arrangement:spotcheck  -> eval/arrangement_spotcheck.md (20 real postings, blanks for YOUR ground truth; gitignored, contains job text)
// npm run arrangement:accuracy   -> reads your answers, reports accuracy and lists misses (eval/results/arrangement_accuracy.json)
// Also writes eval/results/arrangement_text_vs_structured.json: how often TEXT-ONLY detection agrees with the structured field (objective, no human needed).
const h = (s: string) => crypto.createHash('sha1').update('arr' + s).digest('hex');
const cmd = process.argv[2] ?? 'spotcheck';
const P = evalPaths();
const FILE = P.arrangementSpot;

if (cmd === 'spotcheck') {
  const db = openDb();
  const rows = db.prepare('SELECT * FROM jobs WHERE filter_reason IS NULL').all() as any[];
  const picks: any[] = [];
  for (const a of ['remote', 'hybrid', 'onsite', 'unknown']) picks.push(...rows.filter((r) => r.arrangement === a).sort((x, y) => h(x.key).localeCompare(h(y.key))).slice(0, 5));
  const lines = ['# Work-arrangement spot-check (20 real postings)', '',
    'For each posting read the text and fill in the two blanks. Use exactly one of: remote, hybrid, onsite, unknown (unknown = the posting does not say). For office days write a number, or `none` if not stated.', ''];
  picks.forEach((r, i) => {
    const hits = [...(r.description as string).matchAll(/[^.\n]{0,70}\b(remote|hybrid|on-?site|in[- ]office|in[- ]person|days? (?:a|per) week)\b[^.\n]{0,70}/gi)].slice(0, 4).map((m) => m[0].replace(/\s+/g, ' ').trim());
    lines.push(`## Item ${i + 1}: ${r.title} @ ${r.company}`, `key: ${r.key}`, `Location field: ${r.location}`,
      `Detected: **${r.arrangement}**, office days: ${r.office_days ?? 'none'}, via ${r.arrangement_src}${r.arrangement_evidence ? ` (${r.arrangement_evidence})` : ''}`,
      'Mentions in the posting:', ...(hits.length ? hits.map((x) => `- "${x}"`) : ['- (no remote/hybrid/onsite wording found)']), '',
      'Actual arrangement:', 'Actual office days:', '', '---', '');
  });
  fs.writeFileSync(FILE, lines.join('\n'));
  console.log(`wrote ${FILE}: ${picks.length} postings (${['remote', 'hybrid', 'onsite', 'unknown'].map((a) => `${a}=${picks.filter((p) => p.arrangement === a).length}`).join(', ')})`);
  // objective check: text-only vs structured
  const st = rows.filter((r) => r.arrangement_src === 'structured');
  const conf: Record<string, Record<string, number>> = {}; let agree = 0, decided = 0; const miss: string[] = [];
  for (const r of st) {
    const t = detectFromText(r.description, r.location);
    conf[r.arrangement] ??= {}; conf[r.arrangement][t.arrangement] = (conf[r.arrangement][t.arrangement] ?? 0) + 1;
    if (t.arrangement !== 'unknown') { decided++; if (t.arrangement === r.arrangement) agree++; else if (miss.length < 10) miss.push(`${r.company} | ${r.title}: structured=${r.arrangement}, text says ${t.arrangement} ("${t.evidence.slice(0, 80)}")`); }
  }
  fs.mkdirSync(P.results, { recursive: true });
  fs.writeFileSync(`${P.results}/arrangement_text_vs_structured.json`, JSON.stringify({ postings_with_structured_field: st.length, text_detected_something: decided, text_agrees_when_it_detects: agree, agreement_when_detecting: decided ? agree / decided : null, coverage_text_only: st.length ? decided / st.length : null, confusion_rows_structured_cols_text: conf, example_disagreements: miss }, null, 1));
  console.log(JSON.parse(fs.readFileSync(`${P.results}/arrangement_text_vs_structured.json`, 'utf8')));
} else {
  const md = fs.readFileSync(FILE, 'utf8');
  const items = md.split(/^## Item \d+:/m).slice(1);
  const res = { total: items.length, correct: 0, incorrect: 0, blank: 0, misses: [] as string[] };
  for (const it of items) {
    const title = it.split('\n')[0].trim();
    const det = /Detected: \*\*(\w+)\*\*, office days: (\w+)/.exec(it);
    const act = /^Actual arrangement:[ \t]*(.*)$/m.exec(it)?.[1].trim().toLowerCase().replace(/[`*.]/g, '') ?? '';
    const actDays = /^Actual office days:[ \t]*(.*)$/m.exec(it)?.[1].trim().toLowerCase().replace(/[`*.]/g, '') ?? '';
    if (!act || !actDays) { res.blank++; continue; }
    const ok = det![1] === act && det![2] === actDays;
    if (ok) res.correct++; else { res.incorrect++; res.misses.push(`${title}: detected ${det![1]}/${det![2]} days, actual ${act}/${actDays} days`); }
  }
  if (res.blank) { console.log(`PENDING: ${res.blank} of ${res.total} items not filled in`); process.exit(2); }
  fs.writeFileSync(`${P.results}/arrangement_accuracy.json`, JSON.stringify({ ...res, accuracy: res.correct / res.total }, null, 1));
  console.log(`arrangement accuracy: ${res.correct}/${res.total}`); res.misses.forEach((m) => console.log('  MISS', m));
}
