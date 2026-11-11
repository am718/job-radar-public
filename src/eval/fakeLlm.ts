import type { LlmFn } from '../scoring/scorer.js';
import { JUDGE_SYSTEM } from './judgelib.js';

/**
 * Deterministic, offline stand-in for the model, used by `--fake-llm` and the sample test. It is a crude keyword
 * rule, NOT a model: it exists so the harness (trials, split, metrics, results files) can be demonstrated without an API key.
 * Its numbers say nothing about the real scorer.
 */
const IN_TRACK = /engineer|developer|solutions|sales|implementation|integration|automation|business development|forward deployed|software|data|support engineer/i;
const TRACK_B = /solutions|sales|implementation|business development|customer|account|integration specialist/i;
const HARD = /(licen[sc]ed|licen[sc]e required|registered nurse|\bpmp\b|ph\.?d|master'?s degree|security clearance|\b(?:[4-9]|1\d)\+ years|\bcdl\b|\bcpa\b|board certification)/i;
const STRETCH = /\b[23]\+ years/i;

export const fakeScorerLlm: LlmFn = async (system, user) => {
  if (system === JUDGE_SYSTEM) return JSON.stringify({ supported: true, evidence: '' });
  const title = /^Title: (.*)$/m.exec(user)?.[1] ?? '';
  const desc = /<job_description>\n([\s\S]*)\n<\/job_description>/.exec(user)?.[1] ?? '';
  // only the "Requirements:" section counts; "Nice to have:" items are soft
  const reqs = /^Requirements:\n([\s\S]*?)(?:\n\n|$)/m.exec(desc)?.[1] ?? '';
  const track = TRACK_B.test(title) ? 'B' : 'A';
  let score: number, why: string[], gaps: string[];
  if (!IN_TRACK.test(title)) { score = 8; why = ['Role is outside both tracks']; gaps = ['Different field']; }
  else if (HARD.test(reqs)) { score = 15; why = ['In-track title']; gaps = ['A stated hard requirement is not met']; }
  else if (STRETCH.test(reqs)) { score = 55; why = ['In-track title; most requirements met']; gaps = ['One or two requirements are a stretch']; }
  else { score = 82; why = ['Stated requirements match the candidate profile']; gaps = []; }
  return JSON.stringify({ score, track, fit_reasons: why, gaps, apply_priority: score >= 70 ? 'high' : score >= 40 ? 'med' : 'low' });
};
