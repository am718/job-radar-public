import fs from 'node:fs';
import { wilson95 } from './metrics.js';
import { evalPaths } from './paths.js';

// npm run docs — regenerates the results tables in README.md and docs/EVAL.md from files in eval/results/. No hand-typed numbers.
const P = evalPaths();
if (P.isSample) { console.error('npm run docs rewrites README.md and docs/EVAL.md from REAL results; refusing to run on the synthetic sample. Use eval/private or set EVAL_DIR.'); process.exit(2); }
const R = P.results;
const readJson = (f: string) => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null);
const latest = (prefix: string) => {
  const fs_ = fs.readdirSync(R).filter((f) => f.startsWith(prefix) && f.endsWith('.json')).sort();
  return fs_.length ? readJson(`${R}/${fs_[fs_.length - 1]}`) : null;
};
const pct = (x: number | null | undefined) => (x == null || Number.isNaN(x) ? 'n/a' : `${(x * 100).toFixed(1)}%`);
const ci = (p: number, n: number) => { const w = wilson95(p, n); return w ? `${pct(p)} [${pct(w[0])}-${pct(w[1])}]` : pct(p); };
const num = (x: number | null | undefined, d = 2) => (x == null || Number.isNaN(x) ? 'n/a' : x.toFixed(d));

const finalSel = readJson(`${R}/final.json`);
const held = finalSel ? readJson(`${R}/${finalSel.heldout_file}`) : null;
const devRuns = ['v1', 'v2', 'v3', 'v4', 'v5'].map((v) => latest(`${v}-dev-`)).filter(Boolean);
const gold = fs.readFileSync(P.gold, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const labelReport = readJson(`${R}/proxy_labels_report.json`);
const judge = readJson(`${R}/judge.json`), judgeAgree = readJson(`${R}/judge_agreement.json`), proxyAgree = readJson(`${R}/proxy_agreement.json`);
const compareTest = readJson(`${R}/compare_test.json`);
const spend = readJson(`${R}/spend_summary.json`);
const cc = (m: any) => `a=${m.class_counts.apply}, m=${m.class_counts.maybe}, s=${m.class_counts.skip}`;
const proxyAgreeLine = proxyAgree ? `${proxyAgree.agree}/${proxyAgree.n}` : 'PENDING until filled';
const judgeAgreeLine = judgeAgree ? `${judgeAgree.agree}/${judgeAgree.n}` : 'PENDING MY REVIEW';

function devTable() {
  const head = '| Version | Binary agree | Exact 3-class | P@10 | R@15 | Track acc. | Stdev | pass^3 consistency | Priority/score consistent | n |\n|---|---|---|---|---|---|---|---|---|---|';
  return head + '\n' + devRuns.map((r) => { const m = r.metrics; return `| ${r.prompt} | ${ci(m.label_agreement, m.n)} | ${ci(m.exact_agreement_3class, m.n)} | ${pct(m.precision_at_10)} | ${pct(m.recall_at_15)} | ${ci(m.track_accuracy, m.track_n)} | ${num(m.score_stdev)} | ${ci(m.pass3_consistency, m.n)} | ${pct(m.priority_score_consistency)} | ${m.n} (${cc(m)}) |`; }).join('\n');
}
function heldTable() {
  if (!held) return 'PENDING (held-out run not completed)';
  const m = held.metrics, n = m.n, npos = m.n_positive_worth_applying, ceiling = Math.min(15, npos) / npos;
  const alwaysSkip = m.class_counts.skip / n, baseRate = npos / n;
  const rows = [
    ['Binary label agreement (scorer high/med vs gold a/m)', ci(m.label_agreement, n), `${n}`, `always-"skip" baseline: ${pct(alwaysSkip)}`],
    ['Exact 3-class agreement (high=a, med=m, low=s)', ci(m.exact_agreement_3class, n), `${n}`, `always-"skip" baseline: ${pct(alwaysSkip)}`],
    ['Precision@10 (positive = a or m)', pct(m.precision_at_10), `10 slots, ${npos} positives in ${n}`, `random-ranking expectation: ${pct(baseRate)}`],
    ['Recall@15 (positive = a or m)', pct(m.recall_at_15), `${npos} positives`, `maximum possible: ${pct(ceiling)}`],
    ['Track accuracy (A vs B), on a/m jobs', ci(m.track_accuracy, m.track_n), `${m.track_n}`, ''],
    ['Score stability (mean per-job std dev, 3 trials)', num(m.score_stdev), `${n}`, 'points on a 0-100 scale'],
    ['pass^3 consistency (all 3 trials same apply decision)', ci(m.pass3_consistency, n), `${n}`, ''],
    ['pass@3 vs gold (any trial matches gold decision)', ci(m.pass_at_3_vs_gold, n), `${n}`, ''],
    ['pass^3 vs gold (all 3 trials match gold decision)', ci(m.pass_pow_3_vs_gold, n), `${n}`, ''],
    ['apply_priority matches score band', pct(m.priority_score_consistency), `${n * held.k} trials`, ''],
  ];
  const strict = m.strict_a_only_reported ? `Strict a-only: P@10 ${pct(m.precision_at_10_strict_a)}, R@15 ${pct(m.recall_at_15_strict_a)}.` : `Strict a-only precision/recall omitted: ${m.strict_a_only_omitted_reason}.`;
  return `Prompt **${held.prompt}**, held-out half, k = ${held.k}. Class counts in this half: ${cc(m)}. ${strict}\n\n| Metric | Value [Wilson 95% CI] | n | Reference |\n|---|---|---|---|\n` + rows.map((r) => `| ${r.join(' | ')} |`).join('\n');
}
const splitCounts = held?.split_counts ?? devRuns[0]?.split_counts;
const totals = (() => { const c = { apply: 0, maybe: 0, skip: 0 } as Record<string, number>; gold.forEach((g) => c[g.label]++); return c; })();
const failureText = fs.existsSync('docs/failure_analysis.md') ? fs.readFileSync('docs/failure_analysis.md', 'utf8') : 'PENDING';

const REQUIRED = `n = ${gold.length}. All gold labels were produced by an AI proxy (Sonnet) using my interview-likelihood rubric and profile. I spot-checked 10 verdicts: agreement ${proxyAgree ? `${proxyAgree.agree}/${proxyAgree.n}` : '?/10 (PENDING until filled)'}.`;

const evalMd = `# Eval report

> ${REQUIRED}

Everything below is generated by \`npm run docs\` from files in \`eval/results/\`.

## Method
- **Task set:** ${gold.length} real postings from ${new Set(fs.readFileSync(P.candidates, 'utf8').trim().split('\n').map((l) => JSON.parse(l).snapshot.company)).size} company boards (Greenhouse, Lever, Ashby), drawn with a seeded stratified sample (tier 1, tier 2, tier 3+, and "obvious skips" that pass location but have no engineering/solutions title keyword). Full text is frozen in \`eval/candidates.jsonl\` (not published). Gold class counts: ${totals.apply} apply, ${totals.maybe} maybe, ${totals.skip} skip.
- **Labels:** produced by an **AI proxy** (Sonnet, its own prompt, blind to scorer output), not by a human. Rubric: a = in Track A or B, I meet the stated requirements and would expect an interview; m = stretch (missing one or two requirements) or an adjacent role I would take; s = missing a hard requirement (license, degree, years) or a different field. The proxy also quotes one verbatim requirement sentence per verdict (checked in code to occur in the posting). Safeguards before use: at least 25 worth-applying positives (got ${labelReport?.safeguards?.positives ?? 'n/a'}) and no class over 80% (largest: ${labelReport ? `${labelReport.safeguards.top_class} ${pct(labelReport.safeguards.top_share)}` : 'n/a'}).
- **Human check:** 10 proxy verdicts are in \`eval/proxy_spotcheck.md\` for the owner to mark agree/disagree (5 on jobs the owner had earlier labeled "would apply" where the proxy said maybe/skip). Result: ${proxyAgreeLine}.
- **Not used:** 24 early hand labels (\`eval/human_apply_labels.jsonl\`) answered "would I apply?", not the rubric, so they are not gold and not used for calibration. The proxy agreed with 0 of them under the rubric (see BLOCKED.md); that was a mismatch of question, not evidence about either labeler.
- **Positive class** for precision@10 and recall@15 is "worth applying" = gold a OR m.
- **Split:** dev / held-out by SHA-1 of the job key: dev ${splitCounts?.dev ?? 'n/a'}, held-out ${splitCounts?.heldout ?? 'n/a'}. Prompts were iterated on dev only; the held-out half was scored once with the frozen best prompt.
- **Trials:** k = 3 fresh calls per job (cache bypassed).
- **Score meaning:** how realistic it is that the candidate (profile.json) gets an interview for this entry-level role, judged against the requirements written in the posting. Mapping: \`apply_priority\` high (70-100) = a, med (40-69) = m, low (0-39) = s.
- **Metric definitions:** *binary agreement*: majority of 3 trials high/med vs gold a/m. *Exact 3-class*: majority priority (ties go to the lower) vs gold. *Precision@10 / recall@15*: jobs ranked by mean score; hit = gold a or m. *Track accuracy*: majority track vs proxy track on a/m jobs. *Stability*: mean per-job population std dev of score over 3 trials. *pass^3 consistency*: share of jobs whose 3 trials all give the same apply decision. Wilson 95% intervals are shown for proportions.
- **Graders:** code graders (vitest; no API key) for filters, tiers, ranking, dedup, caching, schema, prompt text, metrics; a Sonnet model grader checks whether each \`fit_reason\` is supported by the posting.

## Prompt versions (dev half)
${devTable()}

${finalSel ? `**Chosen on dev:** ${finalSel.prompt} (${finalSel.reason})` : 'PENDING'}

## Held-out result (frozen prompt, scored once)
${heldTable()}

## Model grader
${judge ? `Prompt ${judge.prompt}, ${judge.jobs} jobs, ${judge.claims} fit_reasons judged: ${judge.supported} supported, ${judge.unsupported} unsupported, ${judge.invalid} invalid judge outputs (supported rate ${pct(judge.supported / (judge.supported + judge.unsupported))}, n = ${judge.supported + judge.unsupported}).` : 'PENDING'}
Judge-vs-human agreement on 10 spot-checked verdicts: **${judgeAgreeLine}** (file: \`eval/judge_spotcheck.md\`).

## Regression check
${compareTest ? `Baseline = ${compareTest.baseline_prompt} held-out (precision@10 ${pct(compareTest.baseline_p10)}). \`npm run eval:compare\` on the real latest run: exit ${compareTest.real_exit}. Synthetic drop test (baseline ${pct(compareTest.baseline_p10)} vs a copy with precision@10 lowered by ${compareTest.synthetic_drop_points} points): exit ${compareTest.synthetic_drop_exit} (expected 1). Synthetic 4-point drop: exit ${compareTest.synthetic_small_exit} (expected 0). **Caveat:** precision@10 is at ${pct(compareTest.baseline_p10)} on this set, so the gate can only detect drops, and the held-out set is small.` : 'PENDING'}

## Failure analysis (10 worst held-out misses)
${failureText}

## Cost
${spend ? Object.entries(spend.phases).map(([k, v]: any) => `- phase ${k}: $${v.spent_usd.toFixed(2)} of $${v.cap_usd.toFixed(2)} cap`).join('\n') : 'PENDING'}

## Limitations
- **The gold labels are an AI proxy's, not a human's.** The proxy shares the model family (Sonnet) and the profile with the scorer, so agreement is likely inflated; the proxy is also the same kind of reader as the scorer, so shared blind spots are invisible here. The only human check is the 10-verdict spot-check (${proxyAgreeLine}), too few to bound proxy error.
- Labels are interview-likelihood estimates, not observed outcomes (no recruiter responses were measured).
- The positive class is "worth applying" (a or m). Only ${totals.apply} of ${gold.length} gold labels are "a", so strict a-only precision/recall is not reported when fewer than 10 "a" labels are in the evaluated half.
- Small n: ${splitCounts?.heldout ?? 'n/a'} held-out jobs with about ${held ? held.metrics.n_positive_worth_applying : 'n/a'} positives; precision@10 and recall@15 are coarse (recall@15 has a hard ceiling, shown above), and several metrics sit at or near their ceiling, so they cannot separate prompt versions.
- Prompt v4 was written from dev failures that mostly reflected an ambiguity in the proxy's handling of 1-2 year requirements; it aligns the scorer with the proxy's reading of the profile, which is another reason held-out agreement with the proxy should not be read as agreement with a human.
- Filters (title words, "3+ years" rule, track keywords) were tuned after auditing three companies, and one filter bug was found later through proxy reasons.
- The injection tests use a mocked LLM: they show the schema gate rejects out-of-schema output, not that the real model always resists injected text.
- Full job text is not published (\`eval/candidates.jsonl\` is gitignored); only labels, keys, scorer outputs and the proxy's short verbatim requirement quotes (in \`eval/gold.jsonl\`) are in the repo, so the eval cannot be re-run from a fresh clone without re-scanning.
- My 24 early hand labels measured "would apply" and are not used.
- Companies are a fixed list of 63 boards; the sample is not random across the job market.
`;
fs.mkdirSync('docs', { recursive: true });
fs.writeFileSync('docs/EVAL.md', evalMd);

const readme = fs.readFileSync('README.md', 'utf8');
const start = readme.indexOf('## Results'), end = readme.indexOf('## Run it');
const resultsBlock = `## Results

> ${REQUIRED}

${heldTable()}

Prompt versions compared on the dev half (v1-v${devRuns.length}) and the full method, failure analysis and limitations are in [docs/EVAL.md](docs/EVAL.md). The judge-vs-human agreement line reads: ${judgeAgreeLine}.

`;
fs.writeFileSync('README.md', readme.slice(0, start) + resultsBlock + readme.slice(end));
console.log('wrote docs/EVAL.md and README.md results');
