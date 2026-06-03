/**
 * Bot selector: runs minimax search + policy-prior blend to pick the best action.
 * Falls back to chooseDefault on any error so the bot never hangs.
 */
import type { BattleSnapshot } from '../src/types';
import type { BattleRequest, Choice } from './protocol';
import type { Selector } from './client';
import { chooseDefault, legalSwitchSlots, policyMoveOrder } from './protocol';
import { parseDetails } from '../src/state/snapshot';
import { BattleStateTracker } from './battle-state';
import { evalNet } from './net-node';
import { extractFeatures } from '../src/eval/features';
import { search } from '../src/eval/minimax';
import { evaluate } from '../src/eval/scoring';
import { blendPolicyPrior, buildMoveSortOrder } from '../src/eval/policy-prior';
import { toID } from '../src/util/id';

const ML_BLEND = 0.5;
const POLICY_BLEND = 0.7;
const SEARCH_DEPTH = 2;
const SEARCH_TIME_MS = 8000;
const SEARCH_TOP_N = 9;

export function createBotSelector(username: string, tracker: BattleStateTracker): Selector {
  return (req: BattleRequest): Choice | null => {
    // chooseDefault is sync fallback; the real work is async so we wrap
    // This returns a Choice synchronously by running the async work in a "fire" pattern.
    // Actually, we need a sync Selector — use chooseDefault as placeholder.
    // The REAL selector is async; we handle this in client.ts via an async wrapper.
    return chooseDefault(req);
  };
}

/**
 * Async bot decision. Called from client.ts which awaits it.
 * Returns null if wait, a Choice string otherwise.
 */
export async function selectAction(
  req: BattleRequest,
  tracker: BattleStateTracker,
): Promise<Choice | null> {
  if (req.wait) return null;

  try {
    const snapshot = tracker.buildSnapshot(req);

    // ML-blended leaf evaluator
    const leafEval = async (s: BattleSnapshot): Promise<number> => {
      const feats = extractFeatures(s);
      const { winProb } = await evalNet(feats);
      return ML_BLEND * (winProb * 2 - 1) + (1 - ML_BLEND) * evaluate(s);
    };

    const config = { depth: SEARCH_DEPTH, topN: SEARCH_TOP_N, timeLimitMs: SEARCH_TIME_MS, evalMode: 'ml' as const };
    let options = await search(snapshot, tracker.opponentModel, config, leafEval);

    if (options.length === 0) return chooseDefault(req);

    // Root policy blend
    const rootFeats = extractFeatures(snapshot);
    const { policy } = await evalNet(rootFeats);
    const moveSortOrder = buildMoveSortOrder(snapshot.player.active.moves);
    options = blendPolicyPrior(options, policy, moveSortOrder, POLICY_BLEND);

    // Pick top option and map back to request slot
    const top = options[0];
    if (top.action.type === 'move') {
      // Find the 1-based slot in req.active[0].moves matching this move ID
      const moves = req.active?.[0]?.moves;
      if (!moves) return chooseDefault(req);
      const idx = moves.findIndex(m => toID(m.move) === toID(top.action.name) || m.id === top.action.id);
      if (idx < 0) return chooseDefault(req);
      return `move ${idx + 1}`;
    } else {
      // Switch: action.slot is already the 1-based request index
      return `switch ${top.action.slot}`;
    }
  } catch (e) {
    console.error('[bot] selector error, falling back to default:', e);
    return chooseDefault(req);
  }
}
