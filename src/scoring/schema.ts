import { z } from 'zod';
export const ScoreSchema = z.object({
  score: z.number().int().min(0).max(100),
  track: z.enum(['A', 'B']),
  fit_reasons: z.array(z.string()).max(8),
  gaps: z.array(z.string()).max(8),
  apply_priority: z.enum(['high', 'med', 'low']),
}).strict();
export type Score = z.infer<typeof ScoreSchema>;

/** Extract the first JSON object from model text and validate it. Throws on invalid. */
export function parseScore(text: string): Score {
  const start = text.indexOf('{'), end = text.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('no JSON object in model output');
  return ScoreSchema.parse(JSON.parse(text.slice(start, end + 1)));
}
