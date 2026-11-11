import fs from 'node:fs';
import type { Score } from './scoring/schema.js';
import { rankScore } from './rank.js';
import { DIGEST_SIZE } from './config.js';
import type { PayFlag } from './pay.js';
import type { PostedInfo } from './fresh.js';
import { arrangementLabel, isLowOffice, type Arrangement } from './arrangement.js';

export interface DigestRow { key: string; company: string; title: string; location: string; pay: string | null; url: string; tier: number; score: Score; payDisplay?: string; payFlag?: PayFlag; payStatus?: string; payRaw?: string; arrangement?: Arrangement; officeDays?: number | null; hoursNote?: string; posted?: PostedInfo }

const payLine = (r: DigestRow) => `${r.payDisplay ?? 'unlisted'}${r.payFlag === 'negotiable' ? ' (negotiable: range spans the $115k floor)' : r.payFlag === 'meets floor' ? ' (meets the $115k floor)' : ''}`;
const unlisted = (r: DigestRow) => (r.payFlag ?? 'pay unlisted') === 'pay unlisted';
export const HIGH_FIT_MIN = 65;
export const STILL_OPEN_MIN = 60;
const arr = (r: DigestRow) => r.arrangement ?? 'unknown';
const arrLine = (r: DigestRow) => arrangementLabel(arr(r), r.officeDays ?? null);
const postedLine = (r: DigestRow) => r.posted?.label ?? 'age unknown';
const hoursLine = (r: DigestRow) => (r.hoursNote ? `possible high-demand hours: ${r.hoursNote}` : 'none flagged');

export const SHOW_MIN = 40;   // general ranking lists only jobs scored 40+
export interface ByHandEntry { row: DigestRow; vendor: string | null; reason: string | null; note: string | null; letterPdf: string | null }
export function buildDigest(rows: DigestRow[], date: string, totalNew: number, droppedForPay = 0, stillOpen: DigestRow[] = [], byHand: ByHandEntry[] = []): string {
  const rk = (r: DigestRow) => rankScore(r.score.score, r.tier, r.payFlag ?? 'pay unlisted', arr(r), r.officeDays ?? null, !!r.posted?.fresh);
  const listed = rows.filter((r) => !unlisted(r)), unl = rows.filter(unlisted);
  const below = rows.filter((r) => r.score.score < SHOW_MIN).length;
  const top = listed.filter((r) => r.score.score >= SHOW_MIN).sort((a, b) => rk(b) - rk(a)).slice(0, DIGEST_SIZE);
  const lowOffice = listed.filter((r) => r.score.score >= 40 && isLowOffice(arr(r), r.officeDays ?? null)).sort((a, b) => rk(b) - rk(a));
  const lines = [`# Job Radar digest ${date}`, '', `${totalNew} scored job(s): ${listed.length} with listed base pay, ${unl.length} with pay unlisted/unclear.`, ''];
  lines.push(`# Remote and low-office roles (${lowOffice.length}): remote, or hybrid with 3 or fewer stated office days; listed pay, scored 40+`, '',
    '(Jobs here may repeat in the general ranking below.)', '');
  lowOffice.forEach((r) => lines.push(`- **${r.score.score}** ${r.company} - ${r.title} (${r.location}) | ${arrLine(r)} | Pay: ${payLine(r)} | Hours note: ${hoursLine(r)} | ${r.url}`));
  lines.push('', top.length ? `# General ranking: top ${top.length} with listed pay, scored ${SHOW_MIN}+ (remote ranks above hybrid above onsite at equal fit; onsite is a penalty, not a drop)` : '# General ranking', '');
  if (!top.length) lines.push(rows.some((r) => r.score.score >= SHOW_MIN) ? `No new jobs with listed pay scored ${SHOW_MIN}+ today (see the sections below for unclear pay).` : `No new jobs scored ${SHOW_MIN}+ today`, '');
  if (below) lines.push(`${below} more jobs scored below ${SHOW_MIN} today (not shown)`, '');
  top.forEach((r, i) => {
    const why = r.score.fit_reasons.slice(0, 2).map((x) => x.replace(/[.\s]+$/, '')).join('. ') + '.';
    lines.push(
      `## ${i + 1}. ${r.company} - ${r.title}`,
      `- Location: ${r.location} (tier ${r.tier})`,
      `- Posted: ${postedLine(r)}`,
      `- Work arrangement: ${arrLine(r)}`,
      `- Pay: ${payLine(r)}`,
      `- Hours note: ${hoursLine(r)}`,
      `- Score: ${r.score.score} (${r.score.apply_priority})`,
      `- Why: ${why || 'n/a'}`,
      `- Apply: ${r.url}`,
      `- Resume: ${r.score.track}`,
      `- Mark: \`npm run mark -- ${r.key} applied|skip\``,
      '',
    );
  });
  // High fit must not be buried by pay status: every unlisted/unclear-pay job scored 65+ is shown right after the top 15, with the raw pay text to judge by hand.
  // (Jobs confirmed below the $115k floor are dropped upstream and never reach this function.)
  const highFit = unl.filter((r) => r.score.score >= HIGH_FIT_MIN).sort((a, b) => b.score.score - a.score.score);
  lines.push(`# High fit, pay unclear (${highFit.length}): scored ${HIGH_FIT_MIN}+ with pay unlisted or unclear; judge the pay yourself`, '');
  highFit.forEach((r) => lines.push(
    `- **${r.score.score}** ${r.company} - ${r.title} (${r.location}, tier ${r.tier}) [${r.score.track}]`,
    `  - Work arrangement: ${arrLine(r)} | Hours note: ${hoursLine(r)} | Posted: ${postedLine(r)}`,
    `  - Pay status: ${r.payStatus === 'unclear' ? 'unclear' : 'unlisted'}; raw pay text: ${r.payRaw ? `"${r.payRaw}"` : '(no pay text found in the posting)'}`,
    `  - ${r.url}`));
  lines.push('');
  // Fresh postings: posted within the last 7 days by a RELIABLE date (or first seen after the baseline scan), ranked by score.
  const freshAll = rows.filter((r) => r.posted?.fresh).sort((a, b) => b.score.score - a.score.score);
  const freshShown = freshAll.filter((r) => r.score.score >= 40);
  lines.push(`# Posted in the last 7 days (${freshShown.length} scored 40+, of ${freshAll.length} fresh): ranked by score`, '',
    '(Date sources: Greenhouse first_published, Ashby publishedAt, Lever createdAt; first_seen only for jobs that appeared after the baseline scan. Updated-at is never used. Jobs may repeat from sections above.)', '');
  freshShown.forEach((r) => lines.push(`- **${r.score.score}** ${r.company} - ${r.title} (${r.location}) | Posted: ${postedLine(r)} | ${arrLine(r)} | Pay: ${payLine(r)} | ${r.url}`));
  lines.push('');
  const section = (title: string, rs: DigestRow[]) => {
    lines.push(`# ${title} (${rs.length}), by tier then score`, '');
    let lastTier = 0;
    for (const r of rs) {
      if (r.tier !== lastTier) { lines.push(`### Tier ${r.tier}`, ''); lastTier = r.tier; }
      lines.push(`- **${r.score.score}** ${r.company} - ${r.title} (${r.location}) [${r.score.track}] | ${arrLine(r)} | Pay: ${payLine(r)} | Hours note: ${hoursLine(r)} | Posted: ${postedLine(r)} | ${r.url}`);
    }
    lines.push('');
  };
  const topKeys = new Set(top.map((r) => r.key));
  const byTierScore = (a: DigestRow, b: DigestRow) => a.tier - b.tier || b.score.score - a.score.score;
  section('Other jobs with listed pay scored 40+', listed.filter((r) => !topKeys.has(r.key) && r.score.score >= 40).sort(byTierScore));
  section(`Pay unlisted or unclear, scored 40-${HIGH_FIT_MIN - 1} (verify pay before applying; 65+ are in "High fit, pay unclear" above)`, unl.filter((r) => r.score.score >= 40 && r.score.score < HIGH_FIT_MIN).sort(byTierScore));
  lines.push(`# Still open from earlier days (${stillOpen.length}): scored ${STILL_OPEN_MIN}+, not marked applied or skip, still on the company's board; kept here until you mark them`, '');
  if (!stillOpen.length) lines.push('(none, or board presence not yet recorded: run `npm run scan -- --fetch-only` once)', '');
  stillOpen.forEach((r) => lines.push(`- **${r.score.score}** ${r.company} - ${r.title} (${r.location}) | Pay: ${payLine(r)} | ${arrLine(r)} | Posted: ${postedLine(r)} | ${r.url}  \`npm run mark -- ${r.key} applied|skip\``));
  if (stillOpen.length) lines.push('');
  if (byHand.length) {
    lines.push(`# Apply by hand (bot protected) (${byHand.length}): the tool will not open or fill these pages; nothing here was auto-filled`, '');
    byHand.forEach((e) => {
      const r = e.row;
      lines.push(`- **${r.score.score}** ${r.company} - ${r.title} (${r.location}) | Pay: ${payLine(r)} | ${arrLine(r)} | protection: ${e.vendor ?? 'unknown'} | apply: ${r.url}`);
      lines.push(e.letterPdf || e.note ? `    - cover letter PDF: ${e.letterPdf ?? 'not generated'} | tailored note: ${e.note ?? 'not generated'}` : `    - not prepared yet: \`npm run letter -- ${r.key}\` (cover letter) or \`npm run letter -- --protected\` (note + letter for all of these)`);
    });
    lines.push('');
  }
  lines.push(`${droppedForPay} jobs dropped for pay (list in dropped-for-pay file)`, '');
  return lines.join('\n');
}
export function writeDigest(md: string, date: string, dir = 'digest') {
  fs.mkdirSync(dir, { recursive: true });
  const p = `${dir}/${date}.md`;
  fs.writeFileSync(p, md);
  return p;
}
