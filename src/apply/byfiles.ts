import fs from 'node:fs';
import path from 'node:path';

export const PREPARED_DIR = () => process.env.JOB_RADAR_PREPARED ?? 'prepared';
export interface ByHandFiles { note: string | null; letterMd: string | null; letterPdf: string | null }

/** Files already written for a job under prepared/ (note md, letter md, letter PDF found through its .job marker). */
export function byHandFiles(key: string, dir = PREPARED_DIR()): ByHandFiles {
  const [source, ...rest] = key.split(':'); const id = rest.join(':');
  const f = (n: string) => { const p = path.resolve(dir, n); return fs.existsSync(p) ? p : null; };
  let pdf: string | null = null;
  try { for (const n of fs.readdirSync(dir)) if (n.endsWith('.pdf.job') && fs.readFileSync(path.join(dir, n), 'utf8') === key) { const p = path.resolve(dir, n.slice(0, -4)); if (fs.existsSync(p)) pdf = p; } } catch { /* no dir yet */ }
  return { note: f(`${source}-${id}.md`), letterMd: f(`${source}-${id}-cover-letter.md`), letterPdf: pdf };
}

