import fs from 'node:fs';
import path from 'node:path';

export const SAMPLE_DIR = 'eval/sample';
export const PRIVATE_DIR = 'eval/private';

/**
 * Which data directory the eval scripts use. Order:
 *  1. EVAL_DIR env var (explicit override)
 *  2. --sample on the command line (the synthetic sample in eval/sample)
 *  3. eval/private if it exists (the owner's real, gitignored data)
 *  4. eval/sample (a fresh clone has no eval/private)
 */
export function resolveEvalDir(argv: string[] = process.argv, env: NodeJS.ProcessEnv = process.env, exists: (p: string) => boolean = fs.existsSync): string {
  if (env.EVAL_DIR) return env.EVAL_DIR;
  if (argv.includes('--sample')) return SAMPLE_DIR;
  return exists(PRIVATE_DIR) ? PRIVATE_DIR : SAMPLE_DIR;
}

export function evalPaths(dir: string = resolveEvalDir()) {
  const p = (f: string) => path.join(dir, f);
  return {
    dir,
    isSample: path.normalize(dir) === path.normalize(SAMPLE_DIR),
    gold: p('gold.jsonl'), candidates: p('candidates.jsonl'), humanLabels: p('human_apply_labels.jsonl'), proxyLabels: p('proxy_labels.jsonl'),
    approval: p('GOLD_APPROVED'), profile: p('profile.json'), results: p('results'),
    judgeSpot: p('judge_spotcheck.md'), proxySpot: p('proxy_spotcheck.md'), arrangementSpot: p('arrangement_spotcheck.md'),
  };
}
export type EvalPaths = ReturnType<typeof evalPaths>;

/**
 * Candidate profile summary for the eval: <dir>/profile.json when the data dir ships one, else (sample only) the invented candidate in
 * profile.example.json at the repo root, else undefined = the scorer's default profile.json (the owner's real profile; eval/private has none of its own).
 */
export function dirProfileSummary(p: EvalPaths): string | undefined {
  const read = (f: string) => JSON.parse(fs.readFileSync(f, 'utf8')).summary as string;
  if (fs.existsSync(p.profile)) return read(p.profile);
  if (p.isSample) {
    if (fs.existsSync('profile.example.json')) return read('profile.example.json');
    throw new Error('the sample needs eval/sample/profile.json or profile.example.json');
  }
  return undefined;
}
