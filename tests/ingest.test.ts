import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { openDb } from '../src/store.js';
import { extractAlertLinks, ingestEmails } from '../src/ingest/email.js';
import { simpleParser } from 'mailparser';
import { resolveRedirect } from '../src/ingest/redirect.js';
import { parseAtsUrl } from '../src/ingest/atsurl.js';
import { extractJobPosting } from '../src/ingest/extract.js';
import { addJobFromUrl } from '../src/ingest/add.js';
import { isForbiddenHost } from '../src/ingest/hosts.js';
import { fetchImapMessages, imapConfigFromEnv, parseSince, type ImapLike } from '../src/ingest/imap.js';
import type { FetchFn } from '../src/ingest/net.js';

const fx = (n: string) => fs.readFileSync(new URL(`../fixtures/ingest/${n}`, import.meta.url));
const parsed = async (n: string) => { const p = await simpleParser(fx(n)); return extractAlertLinks({ html: p.html, text: p.text }); };

/** A fake network: routes maps url -> (status, body|location). Records every request URL. */
function fakeNet(routes: Record<string, { status?: number; location?: string; json?: unknown; body?: string }>) {
  const calls: { url: string; method: string }[] = [];
  const fetch: FetchFn = async (url, init) => {
    calls.push({ url, method: init?.method ?? 'GET' });
    const r = routes[url];
    if (!r) return new Response('not found', { status: 404 });
    const headers: Record<string, string> = r.location ? { location: r.location } : {};
    if (r.json !== undefined) headers['content-type'] = 'application/json';
    return new Response(r.json !== undefined ? JSON.stringify(r.json) : (r.body ?? ''), { status: r.status ?? 200, headers });
  };
  return { fetch, calls, forbiddenCalls: () => calls.filter((c) => isForbiddenHost(new URL(c.url).hostname)) };
}
const GOOD_SCORE = JSON.stringify({ score: 77, track: 'A', fit_reasons: ['fits'], gaps: [], apply_priority: 'high' });
const fakeLlm = () => { const seen: string[] = []; const fn = async (_s: string, u: string) => { seen.push(u); return GOOD_SCORE; }; return Object.assign(fn, { seen }); };

describe('alert email parsing', () => {
  it('LinkedIn: titles, company, location, normalised URLs; footer/help/profile/search links skipped', async () => {
    const l = await parsed('linkedin-alert.eml');
    expect(l.map((x) => x.url)).toEqual(['https://www.linkedin.com/jobs/view/4012345001', 'https://www.linkedin.com/jobs/view/4012345002']);
    expect(l[0]).toMatchObject({ kind: 'linkedin', title: 'Software Engineer, New Grad', company: 'Northwind Labs', location: 'New York, NY' });
    expect(l[1]).toMatchObject({ title: 'Solutions Engineer', company: 'Brightwave Analytics', location: 'Remote' });
  });
  it('LinkedIn text-part fallback', async () => {
    const p = await simpleParser(fx('linkedin-alert.eml'));
    const l = extractAlertLinks({ html: null, text: p.text });
    expect(l).toHaveLength(2);
    expect(l[0]).toMatchObject({ title: 'Software Engineer, New Grad', company: 'Northwind Labs', location: 'New York, NY' });
  });
  it('Indeed: rc/clk and viewjob, company/location/pay, unsubscribe/settings/terms skipped', async () => {
    const l = await parsed('indeed-alert.eml');
    expect(l.map((x) => x.url)).toEqual(['https://www.indeed.com/viewjob?jk=a1b2c3d4e5f60718', 'https://www.indeed.com/viewjob?jk=0123456789abcdef']);
    expect(l[0]).toMatchObject({ kind: 'indeed', title: 'Junior Software Developer', company: 'Harbor Systems', location: 'Brooklyn, NY 11201' });
    expect(l[0].snippet).toMatch(/\$85,000/);
    expect(l[1]).toMatchObject({ title: 'Automation Engineer', company: 'Pinecrest Health', location: 'Remote' });
  });
  it('Handshake: "Company · Location" and "Title at Company"; settings/profile skipped', async () => {
    const l = await parsed('handshake-alert.eml');
    expect(l).toHaveLength(2);
    expect(l[0]).toMatchObject({ kind: 'handshake', title: 'Software Engineering Associate', company: 'Cobalt Freight', location: 'New York, NY' });
    expect(l[1]).toMatchObject({ title: 'Implementation Analyst', company: 'Larkspur Software' });
    expect(l[0].url).toBe('https://app.joinhandshake.com/jobs/9876543');
  });
  it('generic: ATS links kept, tracker links with job titles kept as candidates, unsubscribe/privacy/preferences skipped', async () => {
    const l = await parsed('generic-ats.eml');
    expect(l.map((x) => x.title)).toEqual(['Software Engineer, Platform', 'Forward Deployed Engineer', 'Data Engineer', 'Technical Support Engineer']);
    expect(l[0]).toMatchObject({ kind: 'ats', company: 'Acme Robotics', location: 'New York, NY', url: 'https://boards.greenhouse.io/acmerobotics/jobs/4455667' });
    expect(l[1]).toMatchObject({ kind: 'ats', company: 'Zenith Cloud', location: 'Remote (US)' });
    expect(l[2].kind).toBe('other');
    expect(l.some((x) => /unsubscribe|privacy|preferences/i.test(x.url + x.title))).toBe(false);
  });
});

describe('resolveRedirect', () => {
  it('follows a tracker 302 chain to a greenhouse URL', async () => {
    const net = fakeNet({
      'https://t.mailer.example.net/a': { status: 302, location: 'https://r.mailer.example.net/b' },
      'https://r.mailer.example.net/b': { status: 301, location: 'https://boards.greenhouse.io/acme/jobs/1?gh_src=x' },
      'https://boards.greenhouse.io/acme/jobs/1?gh_src=x': { status: 200 },
    });
    const r = await resolveRedirect('https://t.mailer.example.net/a', { fetch: net.fetch });
    expect(r).toMatchObject({ url: 'https://boards.greenhouse.io/acme/jobs/1?gh_src=x', hops: 2, stopped: 'done' });
    expect(net.calls.every((c) => c.method === 'HEAD')).toBe(true);
  });
  it('stops BEFORE a forbidden host and never requests it', async () => {
    const net = fakeNet({
      'https://t.mailer.example.net/a': { status: 302, location: 'https://click.linkedin.com/x?y=1' },
      'https://click.linkedin.com/x?y=1': { status: 302, location: 'https://www.linkedin.com/jobs/view/1234567' },
    });
    const r = await resolveRedirect('https://t.mailer.example.net/a', { fetch: net.fetch });
    expect(r.url).toBe('https://t.mailer.example.net/a');
    expect(r.skippedForbidden).toBe(true);
    expect(net.forbiddenCalls()).toEqual([]);
    const direct = await resolveRedirect('https://lnkd.in/abc', { fetch: net.fetch });
    expect(direct.skippedForbidden).toBe(true);
    expect(net.calls.map((c) => c.url)).toEqual(['https://t.mailer.example.net/a']);
  });
  it('refuses private/IP/localhost hosts (start and mid-chain), and non-http', async () => {
    const net = fakeNet({ 'https://t.mailer.example.net/a': { status: 302, location: 'http://192.168.1.5/admin' } });
    for (const u of ['http://127.0.0.1/x', 'http://10.0.0.1/', 'http://[::1]/', 'http://localhost:3000/', 'http://printer.local/', 'ftp://example.com/x', 'file:///etc/passwd']) {
      expect((await resolveRedirect(u, { fetch: net.fetch })).url).toBe(u);
    }
    expect(net.calls).toEqual([]);
    const r = await resolveRedirect('https://t.mailer.example.net/a', { fetch: net.fetch });
    expect(r).toMatchObject({ url: 'https://t.mailer.example.net/a', stopped: 'unsafe' });
    expect(net.calls).toHaveLength(1);
  });
  it('caps hops, falls back to GET on 405, sends the named UA and no cookies', async () => {
    const routes: Record<string, any> = {};
    for (let i = 0; i < 10; i++) routes[`https://h.example.net/${i}`] = { status: 302, location: `https://h.example.net/${i + 1}` };
    const net = fakeNet(routes);
    const r = await resolveRedirect('https://h.example.net/0', { fetch: net.fetch, maxHops: 3 });
    expect(r).toMatchObject({ url: 'https://h.example.net/3', hops: 3, stopped: 'max-hops' });
    const seen: any[] = [];
    const f: FetchFn = async (url, init) => { seen.push({ method: init?.method, init }); return init?.method === 'HEAD' ? new Response('', { status: 405 }) : new Response('', { status: 200 }); };
    await resolveRedirect('https://x.example.net/', { fetch: f });
    expect(seen.map((s) => s.method)).toEqual(['HEAD', 'GET']);
    expect(seen[1].init.redirect).toBe('manual');
    expect(seen[1].init.headers['User-Agent']).toMatch(/job-radar/);
    expect(Object.keys(seen[1].init.headers).some((k) => /cookie/i.test(k))).toBe(false);
  });
});

describe('parseAtsUrl', () => {
  const cases: [string, any][] = [
    ['https://boards.greenhouse.io/acme/jobs/12345', { source: 'greenhouse', slug: 'acme', id: '12345' }],
    ['https://job-boards.greenhouse.io/acme/jobs/12345?gh_src=x', { source: 'greenhouse', slug: 'acme', id: '12345' }],
    ['https://boards.greenhouse.io/embed/job_app?for=acme&token=999', { source: 'greenhouse', slug: 'acme', id: '999' }],
    ['https://www.acme.com/careers?gh_jid=555', null],
    ['https://jobs.lever.co/zenith/0a1b2c3d-4e5f-6071-8293-a4b5c6d7e8f9', { source: 'lever', slug: 'zenith', id: '0a1b2c3d-4e5f-6071-8293-a4b5c6d7e8f9' }],
    ['https://jobs.lever.co/zenith/0a1b2c3d-4e5f-6071-8293-a4b5c6d7e8f9/apply', { source: 'lever', slug: 'zenith', id: '0a1b2c3d-4e5f-6071-8293-a4b5c6d7e8f9' }],
    ['https://jobs.lever.co/zenith', null],
    ['https://jobs.ashbyhq.com/orbit/0a1b2c3d-4e5f-6071-8293-a4b5c6d7e8f9', { source: 'ashby', slug: 'orbit', id: '0a1b2c3d-4e5f-6071-8293-a4b5c6d7e8f9' }],
    ['https://apply.workable.com/acme/j/ABC123DEF/', { source: 'workable', slug: 'acme', id: 'ABC123DEF' }],
    ['https://jobs.smartrecruiters.com/AcmeCorp/743999876-software-engineer', { source: 'smartrecruiters', slug: 'AcmeCorp', id: '743999876' }],
    ['https://example.com/jobs/1', null],
    ['not a url', null],
  ];
  it.each(cases)('%s', (u, want) => { expect(parseAtsUrl(u)).toEqual(want); });
  it('gh_jid with a known host->slug map', () => {
    expect(parseAtsUrl('https://www.acme.com/careers?gh_jid=555', { 'acme.com': 'acmeinc' })).toEqual({ source: 'greenhouse', slug: 'acmeinc', id: '555' });
  });
});

describe('extractJobPosting', () => {
  it('uses JSON-LD JobPosting: title, org, location + TELECOMMUTE, text, date, structured pay', () => {
    const j = extractJobPosting(fx('page-jsonld.html').toString(), 'https://careers.fernhill.example.org/jobs/platform?utm_source=x#apply');
    expect(j).toMatchObject({ source: 'link', title: 'Platform Engineer', company: 'Fernhill Robotics', remote: true, postedSource: 'published' });
    expect(j.location).toBe('Remote | New York, NY, US');
    expect(j.postedAt).toBe('2025-10-28T00:00:00.000Z');
    expect(j.description).toContain('Build and run the fleet platform');
    expect(j.description).toContain('- TypeScript and Go');
    expect(j.payRaw).toMatchObject({ min: 120000, max: 150000, interval: 'year', currency: 'USD' });
    expect(j.url).toBe('https://careers.fernhill.example.org/jobs/platform');
    expect(j.id).toMatch(/^[0-9a-f]{16}$/);
  });
  it('falls back to og:title / h1 + main text without nav/script/style', () => {
    const j = extractJobPosting(fx('page-plain.html').toString(), 'https://quillstone.example.org/careers/se');
    expect(j).toMatchObject({ source: 'link', title: 'Software Engineer', company: 'Quillstone Labs', location: 'New York, NY', postedAt: null });
    expect(j.description).toContain('React and Node');
    expect(j.description).not.toMatch(/tracking|color:red|Home|Copyright/);
  });
});

describe('addJobFromUrl', () => {
  const GH = 'https://boards-api.greenhouse.io/v1/boards/acmerobotics/jobs/4455667?pay_transparency=true';
  const ghJob = { id: 4455667, title: 'Software Engineer, Platform', company_name: 'Acme Robotics', location: { name: 'New York, NY' }, content: '<p>Build the platform.</p>', absolute_url: 'https://boards.greenhouse.io/acmerobotics/jobs/4455667', first_published: '2025-10-01T10:00:00-04:00', updated_at: '2025-11-01T00:00:00Z' };

  it('forbidden hosts are refused without any fetch; bad schemes and private hosts too', async () => {
    const db = openDb(':memory:'), net = fakeNet({}), llm = fakeLlm();
    for (const u of ['https://www.linkedin.com/jobs/view/123', 'https://uk.indeed.com/viewjob?jk=abc', 'https://app.joinhandshake.com/jobs/1', 'https://www.glassdoor.com/job/1', 'https://lnkd.in/x', 'ftp://x.example.com/a', 'http://127.0.0.1/a', 'http://localhost/a']) {
      const r = await addJobFromUrl(db, u, { fetch: net.fetch, llm });
      expect(r).toMatchObject({ ok: false, status: 'refused' });
    }
    expect((await addJobFromUrl(db, 'https://www.linkedin.com/jobs/view/1', { fetch: net.fetch, llm })).reason).toMatch(/LinkedIn\/Indeed\/Handshake pages can't be fetched/);
    expect(net.calls).toEqual([]);
    expect(llm.seen).toEqual([]);
    expect((db.prepare('SELECT count(*) c FROM jobs').get() as any).c).toBe(0);
  });
  it('greenhouse URL is stored as source greenhouse with that id, scored, and re-adding makes no second row', async () => {
    const db = openDb(':memory:'), net = fakeNet({ [GH]: { json: ghJob } }), llm = fakeLlm();
    const r = await addJobFromUrl(db, 'https://boards.greenhouse.io/acmerobotics/jobs/4455667?gh_src=mail', { fetch: net.fetch, llm });
    expect(r).toMatchObject({ ok: true, status: 'new', key: 'greenhouse:4455667', score: 77 });
    expect(net.calls.map((c) => c.url)).toEqual([GH]);
    const row = db.prepare('SELECT source,id,company,posted_at_source FROM jobs').all();
    expect(row).toEqual([{ source: 'greenhouse', id: '4455667', company: 'Acme Robotics', posted_at_source: 'published' }]);
    const again = await addJobFromUrl(db, 'https://boards.greenhouse.io/acmerobotics/jobs/4455667', { fetch: net.fetch, llm });
    expect(again).toMatchObject({ ok: true, status: 'updated', key: 'greenhouse:4455667', score: 77 });
    expect((db.prepare('SELECT count(*) c FROM jobs').get() as any).c).toBe(1);
    expect(llm.seen).toHaveLength(1);
  });
  it('generic page is stored as source link and scored by the injected llm; only one GET', async () => {
    const url = 'https://quillstone.example.org/careers/se';
    const db = openDb(':memory:'), net = fakeNet({ [url]: { body: fx('page-plain.html').toString() } }), llm = fakeLlm();
    const r = await addJobFromUrl(db, url, { fetch: net.fetch, llm });
    expect(r.status).toBe('new'); expect(r.key).toMatch(/^link:[0-9a-f]{16}$/); expect(r.score).toBe(77);
    expect(net.calls).toEqual([{ url, method: 'GET' }]);
    expect(llm.seen[0]).toContain('Quillstone Labs');
    const again = await addJobFromUrl(db, url + '#top', { fetch: net.fetch, llm });
    expect(again.key).toBe(r.key);
    expect((db.prepare('SELECT count(*) c FROM jobs').get() as any).c).toBe(1);
  });
  it('a page that redirects to a forbidden host is refused and that host is never requested', async () => {
    const net = fakeNet({ 'https://short.example.net/x': { status: 302, location: 'https://www.linkedin.com/jobs/view/123456' } });
    const r = await addJobFromUrl(openDb(':memory:'), 'https://short.example.net/x', { fetch: net.fetch, llm: null });
    expect(r.status).toBe('refused'); expect(net.forbiddenCalls()).toEqual([]);
  });
  it('without an llm the job is stored unscored; fetch errors give failed', async () => {
    const url = 'https://quillstone.example.org/careers/se';
    const db = openDb(':memory:');
    const r = await addJobFromUrl(db, url, { fetch: fakeNet({ [url]: { body: fx('page-plain.html').toString() } }).fetch, llm: null });
    expect(r).toMatchObject({ ok: true, status: 'new' }); expect(r.score).toBeUndefined();
    expect(await addJobFromUrl(db, 'https://nope.example.org/x', { fetch: fakeNet({}).fetch, llm: null })).toMatchObject({ ok: false, status: 'failed' });
  });
});

describe('ingestEmails', () => {
  const T = 'https://click.mailer.example.net/c';
  const routes = {
    [`${T}/AAA111`]: { status: 302, location: 'https://boards.greenhouse.io/orchardco/jobs/777?gh_src=t' },
    [`${T}/BBB222`]: { status: 302, location: 'https://www.linkedin.com/jobs/view/4099999999?x=1' },
    'https://boards-api.greenhouse.io/v1/boards/acmerobotics/jobs/4455667?pay_transparency=true': { json: { id: 4455667, title: 'Software Engineer, Platform', company_name: 'Acme Robotics', location: { name: 'New York, NY' }, content: 'x', absolute_url: 'https://boards.greenhouse.io/acmerobotics/jobs/4455667' } },
    'https://boards-api.greenhouse.io/v1/boards/orchardco/jobs/777?pay_transparency=true': { json: { id: 777, title: 'Data Engineer', company_name: 'Orchard Data', location: { name: 'Remote - US' }, content: 'y', absolute_url: 'https://boards.greenhouse.io/orchardco/jobs/777' } },
    'https://api.lever.co/v0/postings/zenithcloud/0a1b2c3d-4e5f-6071-8293-a4b5c6d7e8f9': { json: { id: '0a1b2c3d-4e5f-6071-8293-a4b5c6d7e8f9', text: 'Forward Deployed Engineer', categories: { location: 'Remote' }, descriptionPlain: 'Work with customers', hostedUrl: 'https://jobs.lever.co/zenithcloud/0a1b2c3d-4e5f-6071-8293-a4b5c6d7e8f9', createdAt: 1761000000000 } },
  };
  it('stores ATS jobs under their ATS source, others as alert; never requests a forbidden host; counts', async () => {
    const db = openDb(':memory:'), net = fakeNet(routes), llm = fakeLlm();
    const s = await ingestEmails(db, [fx('generic-ats.eml'), fx('linkedin-alert.eml'), fx('indeed-alert.eml'), fx('handshake-alert.eml')], { fetch: net.fetch, llm });
    expect(net.forbiddenCalls()).toEqual([]);
    expect(s.emails).toBe(4);
    expect(s.links).toBe(4 + 2 + 2 + 2);
    expect(s.resolved).toBe(1);
    expect(s.skippedForbidden).toBe(2 + 2 + 2 + 1);
    expect(s.added).toBe(10); expect(s.duplicates).toBe(0);
    const keys = (db.prepare('SELECT key FROM jobs ORDER BY key').all() as any[]).map((r) => r.key);
    expect(keys).toContain('greenhouse:4455667'); expect(keys).toContain('greenhouse:777'); expect(keys).toContain('lever:0a1b2c3d-4e5f-6071-8293-a4b5c6d7e8f9');
    const alert = db.prepare("SELECT * FROM jobs WHERE source='alert' AND title='Solutions Engineer'").get() as any;
    expect(alert).toMatchObject({ company: 'Brightwave Analytics', location: 'Remote', url: 'https://www.linkedin.com/jobs/view/4012345002', posted_at: null, updated_raw: '2025-11-03T13:05:00.000Z' });
    expect(alert.id).toMatch(/^[0-9a-f]{16}$/);
    const hidden = db.prepare("SELECT url FROM jobs WHERE title='Technical Support Engineer'").get() as any;
    expect(hidden.url).toBe('https://www.linkedin.com/jobs/view/4099999999');   // kept as text, never opened
    expect(llm.seen.length).toBeGreaterThan(0);
    // second pass: everything is a duplicate, no new rows
    const s2 = await ingestEmails(db, [fx('generic-ats.eml'), fx('linkedin-alert.eml')], { fetch: net.fetch, llm });
    expect(s2.added).toBe(0); expect(s2.duplicates).toBe(s2.links);
    expect(net.forbiddenCalls()).toEqual([]);
  });
  it('--no-score path stores without calling any llm', async () => {
    const db = openDb(':memory:');
    const s = await ingestEmails(db, [fx('indeed-alert.eml')], { fetch: fakeNet({}).fetch, llm: null });
    expect(s.added).toBe(2); expect(s.scored).toBe(0);
  });
});

describe('IMAP', () => {
  it('opens the label read-only, fetches source only, calls nothing that changes mail', async () => {
    const called: string[] = []; let lockOpts: any;
    const fake = new Proxy({
      async connect() { called.push('connect'); },
      async getMailboxLock(p: string, o: any) { called.push('lock:' + p); lockOpts = o; return { release() { called.push('release'); } }; },
      async search(q: any, o: any) { called.push('search'); expect(o.uid).toBe(true); expect(q.since).toBeInstanceOf(Date); return [4, 9]; },
      fetch(range: string, q: any) { called.push('fetch:' + range); expect(q).toEqual({ source: true }); return (async function* () { yield { source: fx('indeed-alert.eml') }; yield { source: fx('generic-ats.eml') }; })(); },
      async logout() { called.push('logout'); },
    }, { get: (t: any, k: string) => { if (!(k in t) && typeof k === 'string' && /flag|move|delete|expunge|copy|append|store|seen|trash/i.test(k)) called.push('FORBIDDEN:' + k); return t[k]; } });
    const msgs = await fetchImapMessages(fake as unknown as ImapLike, { label: 'Job Alerts', since: parseSince('7d') });
    expect(msgs).toHaveLength(2);
    expect(lockOpts).toEqual({ readOnly: true });
    expect(called).toEqual(['connect', 'lock:Job Alerts', 'search', 'fetch:4,9', 'release', 'logout']);
    const s = await ingestEmails(openDb(':memory:'), msgs, { fetch: fakeNet({}).fetch, llm: null });
    expect(s.emails).toBe(2);
  });
  it('config: defaults, missing vars named without values, since parsing', () => {
    expect(imapConfigFromEnv({ IMAP_USER: 'a@example.com', IMAP_APP_PASSWORD: 'secret-pw' })).toEqual({ host: 'imap.gmail.com', user: 'a@example.com', pass: 'secret-pw', label: 'Job Alerts' });
    expect(() => imapConfigFromEnv({ IMAP_USER: 'a@example.com' })).toThrow(/IMAP_APP_PASSWORD missing/);
    const now = new Date('2025-11-10T00:00:00Z');
    expect(parseSince('7d', now).toISOString()).toBe('2025-11-03T00:00:00.000Z');
    expect(() => parseSince('soon')).toThrow();
  });
});
