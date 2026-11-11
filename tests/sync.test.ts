import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildRsyncCommands, syncConfig, SyncConfigError, mergeLocalMarks, integrityOk, SYNC_ITEMS } from '../src/sync/pull.js';
import { openDb, upsertJob } from '../src/store.js';

describe('sync:pull', () => {
  it('requires SYNC_HOST and SYNC_USER from the environment (nothing hardcoded) and rejects odd characters', () => {
    expect(() => syncConfig({})).toThrow(SyncConfigError); expect(() => syncConfig({ SYNC_HOST: 'h' })).toThrow(SyncConfigError);
    expect(syncConfig({ SYNC_HOST: 'mini.tail.ts.net', SYNC_USER: 'amq' })).toEqual({ host: 'mini.tail.ts.net', user: 'amq', dir: 'Dev/job-radar' });
    expect(() => syncConfig({ SYNC_HOST: 'h; rm -rf /', SYNC_USER: 'u' })).toThrow(SyncConfigError); expect(() => syncConfig({ SYNC_HOST: 'h', SYNC_USER: 'u', SYNC_REMOTE_DIR: 'x; ls' })).toThrow(SyncConfigError);
    const src = fs.readFileSync('src/sync/pull.ts', 'utf8'); expect(src).not.toMatch(/tail[a-z0-9-]*\.ts\.net|@\d+\.\d+\.\d+\.\d+/);   // no hardcoded host
    const ex = fs.readFileSync('.env.example', 'utf8'); expect(ex).toMatch(/^SYNC_HOST=$/m); expect(ex).toMatch(/^SYNC_USER=$/m);
  });
  it('syncs ONLY data/jobs.db and digest/; never .env, answers.json or resumes/', () => {
    expect(SYNC_ITEMS.map((i) => i.remote)).toEqual(['data/jobs.db', 'digest/']);
    const cmds = buildRsyncCommands({ host: 'h', user: 'u', dir: 'Dev/job-radar' });
    expect(cmds).toHaveLength(2);
    const srcs = cmds.map((c) => c.args.find((a) => a.startsWith('u@h:'))!); expect(srcs).toEqual(['u@h:Dev/job-radar/data/jobs.db', 'u@h:Dev/job-radar/digest/']);
    for (const c of cmds) { const a = c.args.join(' '); expect(a).toContain("--exclude .env*"); expect(a).toContain('--exclude answers*.json'); expect(a).toContain('--exclude resumes/'); expect(a).not.toMatch(/--delete/); }
    expect(buildRsyncCommands({ host: 'h', user: 'u', dir: 'd' }, true)[0].args).toContain('--dry-run');
  });
  it('the CLI refuses to run without SYNC_HOST / SYNC_USER (exit 1, no rsync attempted)', () => {
    const r = spawnSync('node_modules/.bin/tsx', ['src/sync/pull.ts'], { env: { PATH: process.env.PATH, HOME: process.env.HOME, SYNC_HOST: '', SYNC_USER: '' }, encoding: 'utf8' });
    expect(r.status).toBe(1); expect(r.stderr).toMatch(/SYNC_HOST and SYNC_USER must be set/); expect(r.stdout).not.toMatch(/rsync/);
  }, 30000);
  it('local applied/skip marks survive a pull; marks already on the incoming db are kept; integrity check works', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-'));
    const mk = (f: string, rows: [string, string][]) => { const db = openDb(f); rows.forEach(([id, st], i) => { upsertJob(db, { source: 'ashby', id, company: 'C', title: `Software Engineer ${id}`, location: 'NYC', description: 'd', url: 'u' }, 1, null); db.prepare('UPDATE jobs SET status=? WHERE id=?').run(st, id); }); db.close(); };
    const local = path.join(dir, 'local.db'), incoming = path.join(dir, 'incoming.db');
    mk(local, [['a', 'applied'], ['b', 'skip'], ['c', 'new']]); mk(incoming, [['a', 'seen'], ['b', 'applied'], ['c', 'seen'], ['d', 'new']]);
    expect(mergeLocalMarks(local, incoming)).toBe(1);                                            // a: seen -> applied; b already applied remotely (kept); c has no mark
    const st = Object.fromEntries((openDb(incoming).prepare('SELECT id, status FROM jobs').all() as any[]).map((r) => [r.id, r.status]));
    expect(st).toEqual({ a: 'applied', b: 'applied', c: 'seen', d: 'new' });
    expect(integrityOk(incoming)).toBe(true); fs.writeFileSync(path.join(dir, 'bad.db'), 'not a database'); expect(integrityOk(path.join(dir, 'bad.db'))).toBe(false);
  });
});
