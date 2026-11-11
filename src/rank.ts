import { PAY_ADJ, type PayFlag } from './pay.js';
import { arrangementAdj, type Arrangement } from './arrangement.js';
import { FRESH_BONUS } from './fresh.js';
/** Tier bonus: tier 1 > tier 2 > ... (job-radar.config.json locationTiers) at equal fit. Spread (4) is smaller than one arrangement step (5), so work arrangement wins at equal fit. */
export const TIER_BONUS: Record<number, number> = { 1: 4, 2: 3, 3: 2, 4: 1, 5: 0 };
export interface RankInput { score: number; tier: number; payFlag?: PayFlag; arrangement?: Arrangement; officeDays?: number | null }
/** Ranking score = LLM score + tier bonus + pay adjustment (+3/0/-3) + arrangement adjustment (0 remote ... -15 onsite) + freshness (+2 if posted within 7 days; small, fit still decides). The stored LLM score is never modified. */
export const rankScore = (score: number, tier: number, payFlag: PayFlag = 'negotiable', arrangement: Arrangement = 'remote', officeDays: number | null = null, fresh = false) =>
  score + (TIER_BONUS[tier] ?? 0) + (PAY_ADJ[payFlag] ?? 0) + arrangementAdj(arrangement, officeDays) + (fresh ? FRESH_BONUS : 0);
