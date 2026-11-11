import 'dotenv/config';
import fs from 'node:fs';
import crypto from 'node:crypto';
import Anthropic from '@anthropic-ai/sdk';
import { loadProfileFile } from '../userconfig.js';
import { MODEL, DESCRIPTION_CHAR_LIMIT } from '../config.js';
import type { Job } from '../types.js';
import { PROMPTS, DEFAULT_PROMPT } from './prompts.js';
import { parseScore, type Score } from './schema.js';

export const usage = { calls: 0, inputTokens: 0, outputTokens: 0, retries: 0, invalid: 0, apiErrors: [] as string[] };

export type LlmFn = (system: string, user: string) => Promise<string>;

/** profile.json, or profile.example.json when the real one does not exist (see src/userconfig.ts). */
export function loadProfile(): { summary: string } {
  return loadProfileFile();
}

/** Cache version = prompt id + hash of prompt text + hash of profile. Changing either re-scores. (Row key adds source+job id.) */
export function cacheVersion(pv: string, profileSummary: string = loadProfile().summary): string {
  const sha = (x: string) => crypto.createHash('sha1').update(x).digest('hex').slice(0, 8);
  return `${pv}|p${sha(PROMPTS[pv].system)}|u${sha(profileSummary)}`;
}

export function buildUserMessage(job: Pick<Job, 'title' | 'company' | 'location' | 'description'>, profileSummary: string): string {
  const desc = job.description.slice(0, DESCRIPTION_CHAR_LIMIT).replace(/<\/?job_description>/gi, '');
  return `Candidate profile:\n${profileSummary}\n\nTitle: ${job.title}\nCompany: ${job.company}\nLocation: ${job.location}\n\n<job_description>\n${desc}\n</job_description>`;
}

export interface LlmOpts { maxTokens?: number; noThinking?: boolean }
export function anthropicLlm(onUsage?: (inputTokens: number, outputTokens: number) => void, opts: LlmOpts = {}): LlmFn {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY missing (set it in .env)');
  const client = new Anthropic();
  return async (system, user) => {
    usage.calls++;
    const r = (await client.messages.create({ model: MODEL, max_tokens: opts.maxTokens ?? 1500, system, messages: [{ role: 'user', content: user }], ...(opts.noThinking ? { thinking: { type: 'between_tools' } } : {}) } as any)) as Anthropic.Message;
    usage.inputTokens += r.usage.input_tokens; usage.outputTokens += r.usage.output_tokens;
    onUsage?.(r.usage.input_tokens, r.usage.output_tokens);
    return r.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
  };
}

/** Scores one job. Retries once on invalid output; throws if still invalid (never returns unvalidated data). */
export async function scoreJob(
  job: Pick<Job, 'title' | 'company' | 'location' | 'description'>,
  llm: LlmFn,
  opts: { promptVersion?: string; profileSummary?: string } = {},
): Promise<Score> {
  const prompt = PROMPTS[opts.promptVersion ?? DEFAULT_PROMPT];
  const user = buildUserMessage(job, opts.profileSummary ?? loadProfile().summary);
  let lastErr: unknown;
  for (let i = 0; i < 2; i++) {
    try { return parseScore(await llm(prompt.system, user)); } catch (e) { lastErr = e; usage.invalid++; if (i === 0) usage.retries++; }
  }
  throw new Error(`scorer output invalid: ${(lastErr as Error).message}`);
}
