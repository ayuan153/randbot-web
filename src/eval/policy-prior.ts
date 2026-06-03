/**
 * Policy prior blending: combines search scores with the neural network's policy
 * head output to produce a final action ranking.
 */

import type { ScoredOption } from '../types';
import { toID } from '../util/id';

/** Softmax over an array of logits (handles -Infinity for masked slots). */
function softmax(logits: ArrayLike<number>): number[] | null {
  let max = -Infinity;
  for (let i = 0; i < logits.length; i++) {
    if (logits[i] > max) max = logits[i];
  }
  const exps: number[] = [];
  let sum = 0;
  for (let i = 0; i < logits.length; i++) {
    const e = Math.exp(logits[i] - max);
    exps.push(e);
    sum += e;
  }
  if (sum === 0 || !isFinite(sum)) return null;
  return exps.map(e => e / sum);
}

/**
 * Blend search scores with the policy prior and re-rank.
 *
 * @param options - Ranked actions from the search (with normalized scores in [0,1])
 * @param policyLogits - Raw logits from the model's policy head (length 5: moves 0-3, switch 4)
 * @param moveSortOrder - The toID-sorted move IDs that map to policy slots 0..3
 * @param beta - Search weight (higher = trust search more). Default 0.7.
 * @returns Re-ranked options with blendedScore added to breakdown.positionalScore preserved.
 */
export function blendPolicyPrior(
  options: ScoredOption[],
  policyLogits: Float32Array | number[],
  moveSortOrder: string[],
  beta: number,
): ScoredOption[] {
  if (options.length === 0) return [];

  // Build set of legal move IDs from the scored options (these ARE the legal actions)
  const legalMoveIds = new Set<string>();
  let hasSwitch = false;
  for (const opt of options) {
    if (opt.action.type === 'move') {
      legalMoveIds.add(toID(opt.action.name));
    } else {
      hasSwitch = true;
    }
  }

  // Legal-mask the logits: only slots whose move ID appears in legalMoveIds stay unmasked
  const masked = new Float32Array(5);
  for (let k = 0; k < 4; k++) {
    const moveId = moveSortOrder[k];
    if (moveId !== undefined && legalMoveIds.has(moveId)) {
      masked[k] = policyLogits[k];
    } else {
      masked[k] = -Infinity;
    }
  }
  masked[4] = hasSwitch ? policyLogits[4] : -Infinity;

  // Softmax over the masked logits; if degenerate (all -Inf), skip blending
  const policyProbs = softmax(masked);
  if (policyProbs === null) return options;

  // Build a map from action identity to policy probability
  const policyMap = new Map<string, number>();
  for (let k = 0; k < moveSortOrder.length; k++) {
    policyMap.set('move:' + moveSortOrder[k], policyProbs[k]);
  }
  // Switch slot (4): all switch actions share the slot-4 probability equally.
  // Rationale: the policy head models P(switch) as a single scalar; individual
  // switch targets are ranked by search value, so we distribute evenly.
  const switchCount = options.filter(o => o.action.type === 'switch').length;
  const perSwitchProb = switchCount > 0 ? policyProbs[4] / switchCount : 0;

  // Convert search scores to a distribution via softmax (temperature=1)
  const searchLogits = options.map(o => o.score);
  const searchDist = softmax(searchLogits);
  if (searchDist === null) return options;

  // Assign policy prob to each option
  const policyDist: number[] = options.map(opt => {
    if (opt.action.type === 'move') {
      const key = 'move:' + toID(opt.action.name);
      return policyMap.get(key) ?? 0;
    }
    return perSwitchProb;
  });

  // Blend: final = β * searchDist + (1−β) * policyProb
  const blended = options.map((opt, i) => ({
    opt,
    finalScore: beta * searchDist[i] + (1 - beta) * policyDist[i],
  }));

  // Sort descending by blended score
  blended.sort((a, b) => b.finalScore - a.finalScore);

  // Return re-ranked options preserving all existing fields
  return blended.map(({ opt }) => opt);
}

/**
 * Build the toID-sorted move order from the player's revealed moves (display names).
 * Dedupes by toID and sorts ascending — matches computeMoveBlock's ordering.
 */
export function buildMoveSortOrder(moveDisplayNames: string[]): string[] {
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const name of moveDisplayNames) {
    const id = toID(name);
    if (!seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  return ids.sort();
}
