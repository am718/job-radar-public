import { ImapFlow } from 'imapflow';

/** The only IMAP surface used: connect, open ONE mailbox read-only, search, fetch source, logout. No flag/move/delete method is ever called. */
export interface ImapLike {
  connect(): Promise<unknown>;
  getMailboxLock(path: string, opts: { readOnly?: boolean }): Promise<{ release(): void }>;
  search(query: { since: Date }, opts: { uid: boolean }): Promise<number[] | false>;
  fetch(range: string, query: { source: boolean }, opts: { uid: boolean }): AsyncIterable<{ source?: Buffer }>;
  logout(): Promise<unknown>;
}

export function parseSince(s: string | undefined, now = new Date()): Date {
  const m = /^(\d+)\s*([hdwm])$/i.exec((s ?? '7d').trim());
  if (!m) throw new Error(`bad --since "${s}" (use e.g. 12h, 7d, 2w, 1m)`);
  const ms = { h: 3600e3, d: 86400e3, w: 7 * 86400e3, m: 30 * 86400e3 }[m[2].toLowerCase() as 'h' | 'd' | 'w' | 'm'];
  return new Date(now.getTime() - Number(m[1]) * ms);
}

export interface ImapConfig { host: string; user: string; pass: string; label: string }
/** Reads IMAP_HOST / IMAP_USER / IMAP_APP_PASSWORD / IMAP_LABEL. Errors name the variable, never the value. */
export function imapConfigFromEnv(env: Record<string, string | undefined> = process.env): ImapConfig {
  const user = env.IMAP_USER, pass = env.IMAP_APP_PASSWORD;
  if (!user) throw new Error('IMAP_USER missing (set it in .env)');
  if (!pass) throw new Error('IMAP_APP_PASSWORD missing (set it in .env)');
  return { host: env.IMAP_HOST || 'imap.gmail.com', user, pass, label: env.IMAP_LABEL || 'Job Alerts' };
}
export function makeImapClient(cfg: ImapConfig): ImapLike {
  return new ImapFlow({ host: cfg.host, port: 993, secure: true, auth: { user: cfg.user, pass: cfg.pass }, logger: false }) as unknown as ImapLike;
}

/** Raw messages of the label received since `since`. Read-only: EXAMINE, BODY.PEEK, so nothing is marked seen. */
export async function fetchImapMessages(client: ImapLike, o: { label: string; since: Date }): Promise<Buffer[]> {
  await client.connect();
  const out: Buffer[] = [];
  const lock = await client.getMailboxLock(o.label, { readOnly: true });
  try {
    const uids = await client.search({ since: o.since }, { uid: true });
    if (uids && uids.length) for await (const m of client.fetch(uids.join(','), { source: true }, { uid: true })) if (m.source) out.push(m.source);
  } finally { lock.release(); await client.logout(); }
  return out;
}
