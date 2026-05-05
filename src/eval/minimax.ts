/**
 * Expectiminimax search with alpha-beta pruning.
 *
 * Depth 2 default: my move → opponent response.
 * Player nodes maximize, opponent nodes minimize (assume optimal play).
 * Opponent moves weighted by probability from opponent model.
 */

import type { BattleSnapshot, ScoredOption, EvalConfig, OpponentModel, Action, PokemonState, MoveAction } from '../types';
import { evaluate, tacticalBreakdown, tacticalScore, evaluateSwitchMatchup } from './scoring';
import { calculateDamage, DefenderOverrides } from './damage';
import { getLikelyMoves, getMostLikelySet } from './opponent-model';

const MINIMAX_WEIGHT = 0.7;
const TACTICAL_WEIGHT = 0.3;

/**
 * Run expectiminimax search and return scored options.
 */
export function search(
  snapshot: BattleSnapshot,
  opponentModel: OpponentModel,
  config: EvalConfig,
): ScoredOption[] {
  const startTime = Date.now();
  const actions = snapshot.availableActions;
  if (actions.length === 0) return [];

  // Get opponent's likely moves for the minimax opponent node
  const oppMoves = getLikelyMoves(opponentModel, snapshot.opponent.active.species);
  // Take top-3 opponent moves to limit branching
  const topOppMoves = oppMoves.slice(0, 3);

  const results: ScoredOption[] = [];

  for (const action of actions) {
    // Check time limit
    if (Date.now() - startTime > config.timeLimitMs) break;

    let minimaxValue: number;
    let pv: string[] = [];

    if (action.type === 'move') {
      // Simulate our move, then opponent's best response
      minimaxValue = evaluateMove(snapshot, action, topOppMoves, config.depth - 1, opponentModel);
      pv = [action.name];

      // Add opponent's best response to PV
      if (topOppMoves.length > 0) {
        pv.push(`opp: ${topOppMoves[0].move}`);
      }
    } else {
      // Switch: evaluate the resulting position
      minimaxValue = evaluateSwitch(snapshot, action, topOppMoves, opponentModel);
      pv = [`switch ${action.species}`];
    }

    // Compute tactical breakdown for root scoring
    const breakdown = action.type === 'move'
      ? tacticalBreakdown(snapshot, action.id, getDefenderOverrides(opponentModel, snapshot.opponent.active.species))
      : switchBreakdown(snapshot, action);

    const tactical = tacticalScore(breakdown);
    const score = MINIMAX_WEIGHT * normalizeMinimaxValue(minimaxValue) + TACTICAL_WEIGHT * tactical;

    results.push({
      action,
      score: Math.max(0, Math.min(1, score)),
      breakdown,
      principalVariation: pv,
    });
  }

  // Sort by score descending, take topN
  results.sort((a, b) => b.score - a.score);
  return results.slice(0, config.topN);
}

/**
 * Evaluate a move action: compute expected value considering opponent responses.
 */
function evaluateMove(
  snapshot: BattleSnapshot,
  action: MoveAction,
  oppMoves: Array<{ move: string; probability: number }>,
  depth: number,
  opponentModel: OpponentModel,
): number {
  // Build defender overrides from opponent model
  const defOverrides = getDefenderOverrides(opponentModel, snapshot.opponent.active.species);

  // Our move's damage to opponent
  const ourDmg = calculateDamage(
    snapshot.player.active,
    snapshot.opponent.active,
    action.id,
    snapshot.field,
    undefined,
    defOverrides,
  );

  if (depth <= 0 || oppMoves.length === 0) {
    // Leaf: evaluate resulting state after our move
    const resultState = applyDamage(snapshot, 'opponent', ourDmg.avgDmg, ourDmg.realMaxHP);
    return evaluate(resultState);
  }

  // Opponent node: weighted min over opponent moves
  let worstValue = Infinity;

  for (const oppMove of oppMoves) {
    // Opponent's damage to us (opponent is attacker, player is defender with actual HP)
    const oppAtkOverrides = getDefenderOverrides(opponentModel, snapshot.opponent.active.species);
    const oppDmg = calculateDamage(
      snapshot.opponent.active,
      snapshot.player.active,
      oppMove.move,
      snapshot.field,
      oppAtkOverrides,
    );

    // State after both moves (simplified: apply both damages)
    const afterOurMove = applyDamage(snapshot, 'opponent', ourDmg.avgDmg, ourDmg.realMaxHP);
    const afterBoth = applyDamage(afterOurMove, 'player', oppDmg.avgDmg, oppDmg.realMaxHP);

    const value = evaluate(afterBoth);
    // Weight by probability, take minimum (opponent plays optimally)
    const weightedValue = value * oppMove.probability;
    if (weightedValue < worstValue) {
      worstValue = weightedValue;
    }
  }

  return worstValue;
}

/**
 * Evaluate a switch action.
 */
function evaluateSwitch(
  snapshot: BattleSnapshot,
  action: { type: 'switch'; species: string; slot: number },
  oppMoves: Array<{ move: string; probability: number }>,
  opponentModel: OpponentModel,
): number {
  // Find the pokemon we're switching to
  const switchIn = snapshot.player.bench.find(p => p.species === action.species);
  if (!switchIn) return -1;

  // Create state with new active
  const newSnapshot: BattleSnapshot = {
    ...snapshot,
    player: { ...snapshot.player, active: switchIn },
  };

  if (oppMoves.length === 0) {
    return evaluate(newSnapshot);
  }

  // Opponent gets a free hit on our switch-in
  let worstValue = Infinity;
  for (const oppMove of oppMoves) {
    const oppAtkOverrides = getDefenderOverrides(opponentModel, snapshot.opponent.active.species);
    const oppDmg = calculateDamage(
      snapshot.opponent.active,
      switchIn,
      oppMove.move,
      snapshot.field,
      oppAtkOverrides,
    );

    const afterHit = applyDamage(newSnapshot, 'player', oppDmg.avgDmg, oppDmg.realMaxHP);
    const value = evaluate(afterHit) * oppMove.probability;
    if (value < worstValue) worstValue = value;
  }

  return worstValue;
}

/**
 * Create a ScoreBreakdown for a switch action.
 */
function switchBreakdown(
  snapshot: BattleSnapshot,
  action: { type: 'switch'; species: string; slot: number },
) {
  const switchIn = snapshot.player.bench.find(p => p.species === action.species);
  const opponent = snapshot.opponent.active;
  const switchInValue = switchIn ? evaluateSwitchMatchup(switchIn, opponent) : 0;

  return {
    damage: 0,
    koProbability: 0,
    statusValue: 0,
    hazardValue: 0,
    switchInValue,
    speedAdvantage: 0,
    positionalScore: 0,
  };
}

// ─── Helpers ────────────────────────────────────────────────────

/** Build DefenderOverrides from the opponent model's most likely set */
function getDefenderOverrides(model: OpponentModel, species: string): DefenderOverrides | undefined {
  const set = getMostLikelySet(model, species);
  if (!set) return undefined;
  return {
    evs: set.evs,
    ivs: set.ivs,
    nature: set.nature,
    ability: set.ability,
    item: set.item,
  };
}

/** Apply damage to a side's active pokemon (returns new snapshot).
 *  realMaxHP is the defender's actual max HP from the calc (handles percentage HP conversion). */
function applyDamage(snapshot: BattleSnapshot, side: 'player' | 'opponent', damage: number, realMaxHP?: number): BattleSnapshot {
  const target = side === 'player' ? snapshot.player.active : snapshot.opponent.active;
  // If target uses percentage HP (hpMax=100) and we know the real max HP, convert damage to percentage scale
  let scaledDamage = damage;
  if (target.hpMax === 100 && realMaxHP && realMaxHP !== 100) {
    scaledDamage = (damage / realMaxHP) * 100;
  }
  const newHp = Math.max(0, target.hp - scaledDamage);
  const newActive: PokemonState = { ...target, hp: newHp, status: newHp <= 0 ? 'fnt' : target.status };

  if (side === 'player') {
    return { ...snapshot, player: { ...snapshot.player, active: newActive } };
  }
  return { ...snapshot, opponent: { ...snapshot.opponent, active: newActive } };
}

/** Normalize minimax value from [-1, 1] to [0, 1] for scoring */
function normalizeMinimaxValue(value: number): number {
  return (value + 1) / 2;
}
