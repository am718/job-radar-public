import type { Job } from './types.js';
import { EXCLUDE_TITLE_WORDS, EXCLUDE_DESCRIPTION_PATTERNS, TRACK_A_KEYWORDS, TRACK_B_KEYWORDS, SOFT_WORDS, HARD_WORDS } from './config.js';

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function titleExcluded(title: string, words = EXCLUDE_TITLE_WORDS): boolean {
  const t = ` ${title.toLowerCase()} `;
  return words.some((w) => new RegExp(`(^|[^a-z])${esc(w.trim().toLowerCase())}($|[^a-z])`).test(t));
}
/** Max distance (chars) between the years phrase and a soft word for the soft word to be read as modifying it. */
export const SOFT_WINDOW = 60;

/** True when some sentence demands 3+ years. A years phrase is NOT disqualifying when a soft word (preferred / ideally /
 * bonus / nice to have...) sits within SOFT_WINDOW chars of it AND its sentence has no hard word (required / must / minimum / at least).
 * The distance rule stops "5+ years in security ... (Go or Rust preferred)" from being rescued by an unrelated "preferred". */
export function requiresExperience(desc: string, patterns = EXCLUDE_DESCRIPTION_PATTERNS): boolean {
  const res = patterns.map((p) => new RegExp(p, 'i'));
  for (const seg of desc.split(/\n|(?<=[.;!?])\s+/)) {
    const low = seg.toLowerCase();
    const ms = res.map((r) => r.exec(seg)).filter((m): m is RegExpExecArray => !!m);
    for (const m of ms) {
      const start = m.index, end = m.index + m[0].length;
      const near = SOFT_WORDS.some((w) => {
        for (let i = low.indexOf(w); i >= 0; i = low.indexOf(w, i + 1)) {
          if (i + w.length >= start - SOFT_WINDOW && i <= end + SOFT_WINDOW) return true;
        }
        return false;
      });
      const hard = HARD_WORDS.some((w) => new RegExp(`\\b${w}\\b`).test(low));
      if (near && !hard) continue;
      return true;
    }
  }
  return false;
}
/** Strong Track A phrases win over the broader Track B list ("Software Engineer, Solutions" is A); bare "engineer" is the last resort. */
export function titleTrack(title: string): 'A' | 'B' | null {
  const t = title.toLowerCase();
  const strongA = TRACK_A_KEYWORDS.filter((k) => k !== 'engineer');
  if (strongA.some((k) => t.includes(k))) return 'A';
  if (TRACK_B_KEYWORDS.some((k) => t.includes(k))) return 'B';
  return t.includes('engineer') ? 'A' : null;
}
export function prefilter(job: Job): { keep: boolean; reason?: string } {
  if (titleExcluded(job.title)) return { keep: false, reason: 'excluded title' };
  if (!titleTrack(job.title)) return { keep: false, reason: 'no track keyword' };
  if (requiresExperience(job.description)) return { keep: false, reason: '3+ years required' };
  return { keep: true };
}
