import { describe, it, expect, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseHn } from '../src/feeds/hn.js';
import { parseRemoteOk } from '../src/feeds/remoteok.js';
import { parseWwr, wwrUrl } from '../src/feeds/wwr.js';
import { parseUsaJobs, fetchUsaJobs } from '../src/feeds/usajobs.js';
import { parseAdzuna, fetchAdzuna } from '../src/feeds/adzuna.js';
import { redactUrl } from '../src/feeds/http.js';
import { fetchFeeds, loadFeedConfig, FEEDS, type FeedConfig } from '../src/feeds/index.js';
import { resolvePay } from '../src/pay.js';
import type { FeedSource, Job } from '../src/types.js';

const fx = (f: string) => readFileSync(new URL(`../fixtures/feeds/${f}`, import.meta.url), 'utf8');
const saved = { ...process.env };
afterEach(() => { process.env = { ...saved }; vi.restoreAllMocks(); });

describe('hn', () => {
  const thread = JSON.parse(fx('hn-thread.json'));
  const jobs = parseHn(thread.children, thread.id);
  it('parses job posts, skips non-job comments and replies', () => {
    expect(jobs).toHaveLength(4);   // 3 posts + one post that has a reply under it
    expect(jobs.every((j) => j.source === 'hn' && typeof j.id === 'string')).toBe(true);
    expect(jobs.map((j) => j.id)).not.toContain(String(thread.children[4].id));          // "Apply here: ..." is not a post
    expect(jobs.some((j) => j.description.includes('Nothing says'))).toBe(false);
  });
  it('splits company/title/location, uses first link, published date', () => {
    const sa = jobs.find((j) => j.company === 'Simple Analytics')!;
    expect(sa.title).toBe('DevOps Engineer');
    expect(sa.location).toMatch(/^Remote/);
    expect(sa.remote).toBe(true);
    expect(sa.url).toMatch(/^https:\/\/www\.simpleanalytics\.com/);
    expect(sa.postedSource).toBe('published');
    expect(sa.postedAt).toMatch(/^2026-11-02T/);
    expect(sa.description).not.toMatch(/<|&#x/);
  });
  it('falls back to the item url when there is no link', () => {
    const j = parseHn([{ id: 1, type: 'comment', parent_id: 9, created_at: '2026-11-02T00:00:00Z', text: 'Acme | Backend Engineer | Boston, MA | ONSITE' }], 9)[0];
    expect(j.url).toBe('https://news.ycombinator.com/item?id=1');
    expect(j.title).toBe('Backend Engineer');
    expect(j.location).toBe('Boston, MA');
  });
  it('ignores comments whose parent is not the story', () => {
    expect(parseHn([{ id: 2, parent_id: 5, text: 'Acme | Engineer | Remote' }], 9)).toHaveLength(0);
  });
});

describe('remoteok', () => {
  const json = JSON.parse(fx('remoteok.json'));
  const jobs = parseRemoteOk(json);
  it('skips the legal notice and keeps attribution + remoteok url', () => {
    expect(json[0].legal).toBeTruthy();
    expect(jobs).toHaveLength(json.length - 1);
    for (const j of jobs) {
      expect(j.description.startsWith('Source: Remote OK (remoteok.com)')).toBe(true);
      expect(j.url).toMatch(/^https:\/\/remoteok\.com\/remote-jobs\//i);
      expect(j.remote).toBe(true);
      expect(j.postedSource).toBe('published');
      expect(j.postedAt).toMatch(/^2026-/);
    }
  });
  it('maps structured salary and filters by tag', () => {
    const paid = jobs.find((j) => j.payRaw);
    expect(paid?.payRaw?.interval).toBe('year');
    expect(resolvePay(paid!).status).toBe('listed');
    expect(parseRemoteOk(json, ['no-such-tag'])).toHaveLength(0);
  });
});

describe('wwr', () => {
  const jobs = parseWwr(fx('wwr.rss'));
  it('parses Company: Title, pubDate and plain description', () => {
    expect(jobs).toHaveLength(3);
    for (const j of jobs) {
      expect(j.source).toBe('wwr');
      expect(j.company).toBeTruthy();
      expect(j.title).not.toMatch(/&amp;/);
      expect(j.url).toMatch(/^https:\/\/weworkremotely\.com\/remote-jobs\//);
      expect(j.postedSource).toBe('published');
      expect(j.postedAt).toMatch(/^2026-/);
      expect(j.description).not.toMatch(/<\/?(p|li|ul|h\d)>|&lt;/);
      expect(j.location).toMatch(/^Remote/);
    }
  });
  it('handles CDATA and builds category urls', () => {
    const x = '<rss><channel><item><title><![CDATA[Foo & Co: Dev]]></title><description><![CDATA[<p>Hi <b>there</b></p>]]></description><pubDate>Mon, 19 Oct 2026 07:31:25 +0000</pubDate><guid>g1</guid><link>https://weworkremotely.com/remote-jobs/foo</link></item></channel></rss>';
    const j = parseWwr(x)[0];
    expect([j.company, j.title, j.description, j.id]).toEqual(['Foo & Co', 'Dev', 'Hi there', 'g1']);
    expect(wwrUrl('remote-programming-jobs')).toBe('https://weworkremotely.com/categories/remote-programming-jobs.rss');
  });
});

describe('usajobs', () => {
  const jobs = parseUsaJobs(JSON.parse(fx('usajobs.json')));
  it('parses the documented shape', () => {
    expect(jobs).toHaveLength(2);
    expect(jobs[0]).toMatchObject({ source: 'usajobs', id: '799001200', company: 'Bureau of Example Statistics', title: 'IT Specialist (APPSW)', location: 'Washington, District of Columbia', postedSource: 'published' });
    expect(jobs[0].postedAt).toMatch(/^2026-11-03/);
    expect(jobs[0].payRaw).toMatchObject({ min: 99172, max: 128756, interval: 'year', currency: 'USD' });
    expect(jobs[0].description).toContain('application software');
    expect(jobs[0].description).not.toContain('<b>');
    expect(jobs[1].location).toBe('Remote');
    expect(jobs[1].payRaw?.interval).toBe('hour');
  });
  it('missing env throws the needs-error without keys', async () => {
    delete process.env.USAJOBS_API_KEY; delete process.env.USAJOBS_EMAIL;
    await expect(fetchUsaJobs({ keyword: 'x' })).rejects.toThrow(/^needs USAJOBS_API_KEY and USAJOBS_EMAIL in \.env/);
  });
});

describe('adzuna', () => {
  const jobs = parseAdzuna(JSON.parse(fx('adzuna.json')));
  it('parses the documented shape', () => {
    expect(jobs).toHaveLength(3);
    expect(jobs[0]).toMatchObject({ source: 'adzuna', id: '4812345678', company: 'Example Logistics Inc', title: 'Junior Software Engineer', location: 'Austin, Travis County', postedSource: 'published' });
    expect(jobs[0].payRaw).toMatchObject({ min: 90000, max: 110000, interval: 'year' });
    expect(jobs[0].description).not.toContain('<strong>');
  });
  it('remote detection, predicted salary ignored, bad date -> no postedAt', () => {
    expect(jobs[1].location).toBe('Remote');
    expect(jobs[1].payRaw).toBeNull();
    expect(jobs[2].postedAt).toBeNull();
    expect(jobs[2].postedSource).toBeNull();
  });
  it('missing env throws the needs-error', async () => {
    delete process.env.ADZUNA_APP_ID; delete process.env.ADZUNA_APP_KEY;
    await expect(fetchAdzuna({ what: 'x' })).rejects.toThrow(/^needs ADZUNA_APP_ID and ADZUNA_APP_KEY in \.env/);
  });
});

describe('fetchFeeds', () => {
  const cfg: FeedConfig = { enabled: ['hn', 'remoteok', 'usajobs', 'adzuna'], usajobs: { keyword: 'x' }, adzuna: { what: 'x' } };
  const job = { source: 'hn', id: '1', company: 'A', title: 'T', location: '', description: '', url: 'u' } as Job;
  it('isolates failures and reports skipped; no secret in output', async () => {
    process.env.ADZUNA_APP_ID = 'id-SECRET1'; process.env.ADZUNA_APP_KEY = 'key-SECRET2';
    delete process.env.USAJOBS_API_KEY; delete process.env.USAJOBS_EMAIL;
    const fakes = {
      ...FEEDS,
      hn: async () => [job],
      remoteok: async () => { throw new Error('HTTP 500 at https://remoteok.com/api?app_key=key-SECRET2'); },
      usajobs: (c: FeedConfig) => FEEDS.usajobs(c),
      adzuna: async () => { throw new Error('boom key-SECRET2'); },
    } as Record<FeedSource, (c: FeedConfig) => Promise<Job[]>>;
    const res = await fetchFeeds(cfg, fakes);
    expect(res.map((r) => r.source)).toEqual(['hn', 'remoteok', 'usajobs', 'adzuna']);
    expect(res[0].jobs).toHaveLength(1);
    expect(res[1].error).toBeTruthy();
    expect(res[2].skipped).toMatch(/^needs USAJOBS_API_KEY and USAJOBS_EMAIL in \.env/);
    expect(res[3].error).toBeTruthy();
    expect(JSON.stringify(res)).not.toMatch(/SECRET|app_key/);
  });
});

describe('config + http helpers', () => {
  it('feeds.example.json validates with all five enabled', () => {
    const c = loadFeedConfig('does-not-exist.json');
    expect([...c.enabled].sort()).toEqual(['adzuna', 'hn', 'remoteok', 'usajobs', 'wwr']);
  });
  it('redactUrl drops the query', () => {
    expect(redactUrl('https://api.adzuna.com/v1/api/jobs/us/search/1?app_id=a&app_key=b')).toBe('https://api.adzuna.com/v1/api/jobs/us/search/1');
  });
});
