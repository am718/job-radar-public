export const FRESH_DAYS = 7;
export const FRESH_BONUS = 2;   // ranking only: small; fit still decides
const DAY = 86400000;
export const etDate = (iso: string) => new Date(iso).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

export interface PostedInfo {
  at: string | null; source: 'published' | 'created' | 'first_seen' | null; daysAgo: number | null; fresh: boolean; newToday: boolean; label: string;
}
/** Posting date policy (verified per ATS, see README):
 *  1. reliable ATS date: Greenhouse first_published ("published"), Ashby publishedAt ("published"), Lever createdAt ("created");
 *  2. else, ONLY for jobs that first appeared after the baseline scan (is_baseline = 0): first_seen;
 *  3. else unknown. updated_at is never a posting date, and first_seen of baseline jobs is never used. */
export function postedInfo(r: { posted_at?: string | null; posted_at_source?: string | null; first_seen?: string | null; is_baseline?: number | null }, asOf: string): PostedInfo {
  const baseline = !!r.is_baseline;
  let at: string | null = null, source: PostedInfo['source'] = null;
  if (r.posted_at && (r.posted_at_source === 'published' || r.posted_at_source === 'created')) { at = r.posted_at; source = r.posted_at_source; }
  else if (!baseline && r.first_seen) { at = r.first_seen; source = 'first_seen'; }
  const newToday = !baseline && !!r.first_seen && etDate(r.first_seen) === asOf;
  if (!at) return { at: null, source: null, daysAgo: null, fresh: false, newToday, label: 'age unknown (existed before the first scan and this ATS gave no reliable date)' };
  const d = etDate(at);
  const daysAgo = Math.round((Date.parse(asOf) - Date.parse(d)) / DAY);
  if (daysAgo < -1) return { at: null, source: null, daysAgo: null, fresh: false, newToday, label: `age unknown (date ${d} is in the future)` };
  const n = Math.max(0, daysAgo);
  const fresh = n <= FRESH_DAYS;
  const how = n === 0 ? 'today' : n === 1 ? '1 day ago' : `${n} days ago`;
  return { at, source, daysAgo: n, fresh, newToday, label: `${how} (${d}, ${source})${newToday ? ' NEW today' : ''}${!fresh ? ', older than 7 days' : ''}` };
}
