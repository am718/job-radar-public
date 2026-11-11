// Types and pure helpers shared by the local dashboard and the public demo. Imports nothing (no database, no filesystem).
export interface JobRow { key: string; score: number; track: string; company: string; title: string; pay: string; arrangement: string; posted: string | null; fit: string; status: string; url: string; via?: string | null }
export interface JobDetail { key: string; strengths: string[]; gaps: string[]; priority: string; note: string | null; hasLetter: boolean; url: string }
export interface Stats { applied: number; appliedToday: number; appliedWeek: number; queued: number; skipped: number; byDay: { day: string; n: number }[]; undatedApplied: number }

export function statsFrom(applied: number, byDay: { day: string; n: number }[], queued: number, skipped: number, undatedApplied: number, today: string): Stats {
  const weekAgo = new Date(new Date(today + 'T12:00:00Z').getTime() - 6 * 86400000).toISOString().slice(0, 10);
  const sorted = [...byDay].sort((a, b) => a.day.localeCompare(b.day));
  return { applied, appliedToday: sorted.filter((d) => d.day === today).reduce((a, d) => a + d.n, 0), appliedWeek: sorted.filter((d) => d.day >= weekAgo && d.day <= today).reduce((a, d) => a + d.n, 0), queued, skipped, byDay: sorted, undatedApplied };
}
