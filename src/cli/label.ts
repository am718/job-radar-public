import fs from 'node:fs';
import readline from 'node:readline';
import { titleTrack } from '../prefilter.js';
import { LabelSession, type LabelRow } from './labelcore.js';

// Keys: a=apply m=maybe s=skip t=toggle track u=undo q=quit (progress is saved after every label; rerun to resume).
// Labels go to eval/gold.progress.jsonl as you go; eval/gold.jsonl is written only after you type "save" at the end.
const PROGRESS = 'eval/gold.progress.jsonl', GOLD = 'eval/gold.jsonl';
const cands: { key: string; snapshot: any }[] = fs.readFileSync('eval/candidates.jsonl', 'utf8').trim().split('\n').map((l) => JSON.parse(l));
if (cands.some((c) => !c.snapshot)) { console.error('candidates not frozen; run: npm run sample'); process.exit(1); }
if (fs.existsSync(GOLD) && fs.readFileSync(GOLD, 'utf8').trim()) { console.log(`${GOLD} already saved. Move it aside to relabel.`); process.exit(0); }

const write = (f: string, rows: LabelRow[]) => fs.writeFileSync(f, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
const s = new LabelSession(
  cands.map((c) => ({ key: c.key, defaultTrack: titleTrack(c.snapshot.title) ?? 'A' })),
  {
    loadProgress: () => (fs.existsSync(PROGRESS) ? fs.readFileSync(PROGRESS, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []),
    saveProgress: (rows) => write(PROGRESS, rows),
    writeFinal: (rows) => write(GOLD, rows),
  },
  Date.now,
);

const RUBRIC = `RUBRIC (realistic candidacy):
  a = Track A or B, I meet the stated requirements, I would expect an interview.
  m = stretch: missing one or two requirements, or an adjacent role I would take; a good application could still get an interview.
  s = missing a hard requirement (license, degree, years of experience) or a different field entirely.
${'='.repeat(60)}`;

function render() {
  console.clear();
  console.log(RUBRIC);
  const t = s.tally;
  const head = `[${Math.min(s.index + 1, cands.length)}/${cands.length}]  labeled ${s.labels.length}   apply ${t.apply}  maybe ${t.maybe}  skip ${t.skip}`;
  if (s.state === 'confirm') {
    console.log(`${head}\n\nAll ${cands.length} labeled. Final tally: apply ${t.apply}, maybe ${t.maybe}, skip ${t.skip}.\n${s.skewNotice}\nType "save" and press Enter to write ${GOLD}. Anything else lets you review again.\n> ${s.typed}`);
  } else if (s.state === 'done') {
    console.log(`${s.message}  Final: apply ${t.apply}, maybe ${t.maybe}, skip ${t.skip}.`); process.exit(0);
  } else {
    const j = cands[s.index].snapshot;
    console.log(`${head}\n${s.skewNotice ? '*** ' + s.skewNotice + '\n' : ''}${'-'.repeat(60)}\n${j.title}\n${j.company}  |  ${j.location}\n${'-'.repeat(60)}\n${j.description.slice(0, 1500)}\n${'-'.repeat(60)}`);
    if (s.state === 'paused') console.log(`\n${s.paceMessage}`);
    else process.stdout.write(`\n${s.message ? s.message + '  ' : ''}Track: ${s.track}   [a]pply [m]aybe [s]kip [t]rack [u]ndo [q]uit > `);
  }
}
readline.emitKeypressEvents(process.stdin);
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.on('keypress', (str, k) => {
  if (!k) return;
  if ((k.ctrl && k.name === 'c') || (k.name === 'q' && s.state !== 'confirm')) { console.log('\nprogress saved; rerun to resume'); process.exit(0); }
  s.press(k.name === 'return' || k.name === 'enter' ? 'return' : (k.name ?? ''), str ?? '');
  render();
});
render();
