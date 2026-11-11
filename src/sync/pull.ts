import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';

// npm run sync:pull  (run on the MacBook). Pulls ONLY data/jobs.db and digest/ from the Mac Mini over Tailscale (rsync over ssh).
// Host and user come from the environment (.env): SYNC_HOST, SYNC_USER, optional SYNC_REMOTE_DIR (default "Dev/job-radar", relative to the remote home).
// It never syncs .env, answers.json, resumes/, prepared/ or backups.
export const SYNC_ITEMS = [
  { remote: 'data/jobs.db', local: 'data/jobs.db.incoming', dir: false },
  { remote: 'digest/', local: 'digest/', dir: true },
] as const;
const FORBIDDEN = /(^|\/)(\.env[^/]*|answers[^/]*\.json|resumes?(\/|$)|prepared(\/|$)|backups?(\/|$)|\.git(\/|$)|id_rsa|\.ssh)/i;

export class SyncConfigError extends Error {}
export function syncConfig(env: NodeJS.ProcessEnv = process.env) {
  const host = env.SYNC_HOST?.trim(), user = env.SYNC_USER?.trim();
  if (!host || !user) throw new SyncConfigError('SYNC_HOST and SYNC_USER must be set (in .env). Example: SYNC_HOST=<mac-mini name or Tailscale IP>  SYNC_USER=<your username on the Mac Mini>');
  if (!/^[A-Za-z0-9._-]+$/.test(host) || !/^[A-Za-z0-9._-]+$/.test(user)) throw new SyncConfigError('SYNC_HOST / SYNC_USER contain unexpected characters');
  const dir = (env.SYNC_REMOTE_DIR?.trim() || 'Dev/job-radar').replace(/\/+$/, '');
  if (!/^[A-Za-z0-9._\/~-]+$/.test(dir)) throw new SyncConfigError('SYNC_REMOTE_DIR contains unexpected characters');
  return { host, user, dir };
}

/** The exact rsync argument lists (one per item). Pure, so it is unit-tested without any network. */
export function buildRsyncCommands(cfg: { host: string; user: string; dir: string }, dryRun = false): { cmd: string; args: string[] }[] {
  return SYNC_ITEMS.map((it) => {
    if (FORBIDDEN.test(it.remote) || FORBIDDEN.test(it.local)) throw new SyncConfigError(`refusing to sync forbidden path ${it.remote}`);
    return { cmd: 'rsync', args: ['-az', '--partial', '--human-readable', '--itemize-changes', ...(dryRun ? ['--dry-run'] : []),
      '--exclude', '.env*', '--exclude', 'answers*.json', '--exclude', 'resumes/', '--exclude', 'prepared/',
      '-e', 'ssh -o BatchMode=yes -o ConnectTimeout=10', `${cfg.user}@${cfg.host}:${cfg.dir}/${it.remote}`, it.local] };
  });
}

/** Marks you made locally (applied / skip) must survive a pull: re-apply them onto the incoming database. */
export function mergeLocalMarks(localDb: string, incomingDb: string): number {
  if (!fs.existsSync(localDb)) return 0;
  const loc = new Database(localDb, { readonly: true, fileMustExist: true });
  const marks = loc.prepare("SELECT key, status FROM jobs WHERE status IN ('applied','skip')").all() as { key: string; status: string }[];
  loc.close();
  const inc = new Database(incomingDb);
  const upd = inc.prepare("UPDATE jobs SET status=? WHERE key=? AND status NOT IN ('applied','skip')");
  let n = 0; inc.transaction(() => { for (const m of marks) n += upd.run(m.status, m.key).changes; })();
  inc.close(); return n;
}
export function integrityOk(file: string): boolean {
  try { const d = new Database(file, { readonly: true, fileMustExist: true }); const r = d.pragma('integrity_check', { simple: true }); const jobs = d.prepare('SELECT count(*) c FROM jobs').get() as { c: number }; d.close(); return r === 'ok' && jobs.c >= 0; } catch { return false; }
}

export function main(argv = process.argv.slice(2)) {
  const dry = argv.includes('--dry-run');
  const cfg = syncConfig();
  fs.mkdirSync('data', { recursive: true }); fs.mkdirSync('digest', { recursive: true });
  for (const c of buildRsyncCommands(cfg, dry)) {
    console.log(`$ ${c.cmd} ${c.args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ')}`);
    const r = spawnSync(c.cmd, c.args, { stdio: 'inherit' });
    if (r.status !== 0) { console.error(`rsync failed (exit ${r.status}). Is Tailscale up and ssh working to ${cfg.user}@${cfg.host}?`); process.exit(r.status ?? 1); }
  }
  if (dry) { console.log('dry run only: nothing was changed.'); return; }
  const incoming = 'data/jobs.db.incoming', live = 'data/jobs.db';
  if (!integrityOk(incoming)) { console.error('incoming jobs.db failed the integrity check (was a scan writing to it?). Kept your current database; try again.'); fs.rmSync(incoming, { force: true }); process.exit(2); }
  if (fs.existsSync(live)) { const dir = path.join('data/backups', new Date().toISOString().replace(/[:.]/g, '-')); fs.mkdirSync(dir, { recursive: true }); fs.copyFileSync(live, path.join(dir, 'jobs.db')); console.log(`backed up your current jobs.db to ${dir}/`); }
  const kept = mergeLocalMarks(live, incoming);
  fs.renameSync(incoming, live);
  console.log(`jobs.db updated; re-applied ${kept} applied/skip mark(s) you made on this machine. digest/ updated.`);
}
if (process.argv[1]?.endsWith('pull.ts')) { try { main(); } catch (e) { console.error((e as Error).message); process.exit(e instanceof SyncConfigError ? 1 : 3); } }
