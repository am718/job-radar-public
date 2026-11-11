/** The ATSs whose application forms the tool can prefill. */
export type Ats = 'greenhouse' | 'lever' | 'ashby';
export const FILLABLE: readonly Ats[] = ['greenhouse', 'lever', 'ashby'];
/** Every company job board the scanner can read (public JSON/XML feeds only). Only the FILLABLE ones get "Open and fill"; the rest are apply-by-hand. */
export type BoardAts = Ats | 'workable' | 'smartrecruiters' | 'recruitee' | 'bamboohr' | 'breezy' | 'personio' | 'teamtailor' | 'workday';
/** Public job feeds that are not one company's board. */
export type FeedSource = 'hn' | 'remoteok' | 'wwr' | 'usajobs' | 'adzuna';
/** alert = a job found in a saved job-alert email; link = a job added from a pasted URL. */
export type Source = BoardAts | FeedSource | 'alert' | 'link';
export const isFillable = (s: string): s is Ats => (FILLABLE as readonly string[]).includes(s);
export interface Company { name: string; ats: BoardAts; slug: string; tags: string[] }
export interface Job {
  source: Source;
  id: string;            // source-local id
  company: string;
  title: string;
  location: string;
  description: string;   // plain text
  url: string;
  pay?: string;
  remote?: boolean;
  postedAt?: string | null;                       // ISO; ONLY from a reliable ATS field: Greenhouse first_published, Lever createdAt, Ashby publishedAt
  postedSource?: 'published' | 'created' | null;
  updatedRaw?: string | null;                      // Greenhouse updated_at, stored but NEVER used as a posting date (it changes on edits and bulk updates)
  workplaceRaw?: string | null;  // structured work-arrangement value from the source (Ashby/Lever workplaceType, Greenhouse custom field) if present
  payRaw?: import('./pay.js').PayRaw | null;  // structured pay as exposed by the source API (verified fields only)
}
export const jobKey = (j: { source: string; id: string }) => `${j.source}:${j.id}`;
