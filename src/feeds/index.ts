import { existsSync, readFileSync } from 'node:fs';
import { z } from 'zod';
import type { FeedSource, Job } from '../types.js';
import { fetchHn } from './hn.js';
import { fetchRemoteOk } from './remoteok.js';
import { fetchWwr } from './wwr.js';
import { fetchUsaJobs } from './usajobs.js';
import { fetchAdzuna } from './adzuna.js';

const SOURCES = ['hn', 'remoteok', 'wwr', 'usajobs', 'adzuna'] as const;
const FeedConfigSchema = z.object({
  enabled: z.array(z.enum(SOURCES)),
  hn: z.object({ threads: z.number().int().min(1).max(3).optional() }).optional(),
  remoteok: z.object({ tags: z.array(z.string()).optional() }).optional(),
  wwr: z.object({ categories: z.array(z.string().min(1)).min(1) }).optional(),
  usajobs: z.object({ keyword: z.string().min(1), location: z.string().optional(), remote: z.boolean().optional() }).optional(),
  adzuna: z.object({ what: z.string().min(1), where: z.string().optional(), country: z.string().optional() }).optional(),
});
export type FeedConfig = z.infer<typeof FeedConfigSchema>;

/** Reads feeds.json if present, else feeds.example.json. Throws a readable error on a bad file. */
export function loadFeedConfig(file = 'feeds.json'): FeedConfig {
  const path = existsSync(file) ? file : 'feeds.example.json';
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(path, 'utf8')); } catch (e) { throw new Error(`${path}: ${(e as Error).message}`); }
  const r = FeedConfigSchema.safeParse(raw);
  if (!r.success) throw new Error(`${path}: ${r.error.issues.map((i) => `${i.path.join('.') || '(root)'} ${i.message}`).join('; ')}`);
  return r.data;
}

const need = <K extends keyof FeedConfig>(cfg: FeedConfig, k: K): NonNullable<FeedConfig[K]> => {
  const v = cfg[k];
  if (v == null) throw new Error(`feeds config: "${k}" is enabled but has no "${k}" section`);
  return v as NonNullable<FeedConfig[K]>;
};

export const FEEDS: Record<FeedSource, (cfg: FeedConfig) => Promise<Job[]>> = {
  hn: (cfg) => fetchHn(cfg.hn ?? {}),
  remoteok: (cfg) => fetchRemoteOk(cfg.remoteok ?? {}),
  wwr: (cfg) => fetchWwr(need(cfg, 'wwr')),
  usajobs: (cfg) => fetchUsaJobs(need(cfg, 'usajobs')),
  adzuna: (cfg) => fetchAdzuna(need(cfg, 'adzuna')),
};

export interface FeedResult { source: FeedSource; jobs: Job[]; error?: string; skipped?: string }

const SECRET_ENV = ['USAJOBS_API_KEY', 'USAJOBS_EMAIL', 'ADZUNA_APP_ID', 'ADZUNA_APP_KEY'];
/** Message safe for output: any configured secret value is masked, URL query strings are dropped. */
function safeMessage(e: unknown): string {
  let m = e instanceof Error ? e.message : String(e);
  for (const k of SECRET_ENV) { const v = process.env[k]; if (v && v.length >= 3) m = m.split(v).join('***'); }
  return m.replace(/(https?:\/\/[^\s?#]+)[?#]\S*/g, '$1');
}

/** Runs each enabled feed in order. One failure never stops the others; a "needs ... in .env" error becomes `skipped`. `feeds` is injectable for tests. */
export async function fetchFeeds(cfg: FeedConfig, feeds: Record<FeedSource, (cfg: FeedConfig) => Promise<Job[]>> = FEEDS): Promise<FeedResult[]> {
  const out: FeedResult[] = [];
  for (const source of cfg.enabled) {
    try {
      out.push({ source, jobs: await feeds[source](cfg) });
    } catch (e) {
      const msg = safeMessage(e);
      if (/^needs .+ in \.env/.test(msg)) out.push({ source, jobs: [], skipped: msg });
      else out.push({ source, jobs: [], error: msg });
    }
  }
  return out;
}
