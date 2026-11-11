import fs from 'node:fs';
import type Database from 'better-sqlite3';

/** digest/dropped-for-pay-YYYY-MM-DD.md : every posting dropped by the pay rules (gitignored with digest/). */
export function droppedForPay(db: Database.Database) {
  return db.prepare("SELECT company, title, location, url, pay_raw, pay_display, pay_reason, pay_source FROM jobs WHERE filter_reason='pay below floor' ORDER BY company, title").all() as any[];
}
export function writeDroppedFile(db: Database.Database, date: string, dir = 'digest') {
  const rows = droppedForPay(db);
  fs.mkdirSync(dir, { recursive: true });
  const lines = [`# Jobs dropped for pay, ${date}`, '', `${rows.length} job(s) dropped by the $115,000 base-pay floor. Two rules: (1) listed base max below the floor; (2) a clearly labeled OTE/total-comp figure (USD, annual) whose maximum is below the floor (base is at most that figure). Unlabeled, hourly or non-USD figures are never dropped.`, ''];
  for (const r of rows) lines.push(`- **${r.company}** - ${r.title} (${r.location})`, `  - Rule: ${r.pay_reason ?? 'pay below floor'}`, `  - Pay text: ${r.pay_raw ? `"${r.pay_raw}"` : r.pay_display ?? '(none)'}`, `  - ${r.url}`);
  const p = `${dir}/dropped-for-pay-${date}.md`;
  fs.writeFileSync(p, lines.join('\n') + '\n');
  return { path: p, count: rows.length };
}
