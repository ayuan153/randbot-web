/**
 * Expectiminimax search with alpha-beta pruning.
 *
 * Depth 2 default: my move → opponent response.
 * Player nodes maximize, opponent nodes minimize (assume optimal play).
 * Opponent moves weighted by probability from opponent model.
 */

import type { BattleSnapshot, ScoredOption, EvalConfig, OpponentModel, Action, PokemonState, MoveAction, FieldState, RandbatsSet } from '../types';
import { evaluate, tacticalBreakdown, evaluateSwitchMatchup } from './scoring';
import { calculateDamage, DefenderOverrides } from './damage';
import { getLikelyMoves, getMostLikelySet, getRemainingSetProbabilities } from './opponent-model';


/** Async leaf evaluator: maps a leaf BattleSnapshot to a score in [-1,1]
 *  (player advantage). Injected so the worker can blend a learned net in. */
export type LeafEval = (snapshot: BattleSnapshot) => Promise<number>;

/**
 * Run expectiminimax search and return scored options. `leafEval` evaluates leaf
 * states (defaults to the heuristic `evaluate`); the worker injects a net-blended
 * evaluator in ML mode.
 */
export async function search(
  snapshot: BattleSnapshot,
  opponentModel: OpponentModel,
  config: EvalConfig,
  leafEval: LeafEval = (s) => Promise.resolve(evaluate(s)),
): Promise<ScoredOption[]> {
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
      minimaxValue = await evaluateMove(snapshot, action, topOppMoves, config.depth - 1, opponentModel, leafEval);
      pv = [action.name];

      // Add opponent's best response to PV
      if (topOppMoves.length > 0) {
        pv.push(`opp: ${topOppMoves[0].move}`);
      }
    } else {
      // Switch: evaluate the resulting position
      minimaxValue = await evaluateSwitch(snapshot, action, topOppMoves, opponentModel, leafEval);
      pv = [`switch ${action.species}`];
    }

    // Compute tactical breakdown for root scoring
    const breakdown = action.type === 'move'
      ? tacticalBreakdown(snapshot, action.id, getDefenderOverrides(opponentModel, snapshot.opponent.active.species))
      : switchBreakdown(snapshot, action);

    results.push({
      action,
      score: minimaxValue, // raw value, will be normalized below
      breakdown,
      principalVariation: pv,
    });
  }

  // Normalize scores relative to each other within this turn (0-100 scale)
  normalizeScoresRelative(results);

  // Sort by score descending, take topN
  results.sort((a, b) => b.score - a.score);
  return results.slice(0, config.topN);
}

/**
 * Evaluate a move action: compute expected value considering opponent responses.
 */
async function evaluateMove(
  snapshot: BattleSnapshot,
  action: MoveAction,
  oppMoves: Array<{ move: string; probability: number }>,
  depth: number,
  opponentModel: OpponentModel,
  leafEval: LeafEval,
): Promise<number> {
  // Our move's weighted damage to opponent across possible sets
  const ourDmg = calculateWeightedDamage(
    snapshot.player.active,
    snapshot.opponent.active,
    action.id,
    snapshot.field,
    opponentModel,
  );

  if (depth <= 0 || oppMoves.length === 0) {
    // Leaf: evaluate resulting state after our move
    const resultState = applyDamage(snapshot, 'opponent', ourDmg.avgDmg, ourDmg.realMaxHP);
    return leafEval(resultState);
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

    const value = await leafEval(afterBoth);
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
async function evaluateSwitch(
  snapshot: BattleSnapshot,
  action: { type: 'switch'; species: string; slot: number },
  oppMoves: Array<{ move: string; probability: number }>,
  opponentModel: OpponentModel,
  leafEval: LeafEval,
): Promise<number> {
  // Find the pokemon we're switching to
  const switchIn = snapshot.player.bench.find(p => p.species === action.species);
  if (!switchIn) return -1;

  // Create state with new active
  const newSnapshot: BattleSnapshot = {
    ...snapshot,
    player: { ...snapshot.player, active: switchIn },
  };

  if (oppMoves.length === 0) {
    return leafEval(newSnapshot);
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
    const value = (await leafEval(afterHit)) * oppMove.probability;
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

/** Convert a RandbatsSet to DefenderOverrides */
function setToOverrides(set: RandbatsSet): DefenderOverrides {
  return {
    evs: set.evs,
    ivs: set.ivs,
    nature: set.nature,
    ability: set.ability,
    item: set.item,
  };
}

/** Build DefenderOverrides from the opponent model's most likely set */
function getDefenderOverrides(model: OpponentModel, species: string): DefenderOverrides | undefined {
  const set = getMostLikelySet(model, species);
  if (!set) return undefined;
  return setToOverrides(set);
}

/** Get probability-weighted defender overrides for damage calculation across multiple sets */
function getWeightedDefenderSets(model: OpponentModel, species: string): Array<{ overrides: DefenderOverrides; probability: number }> {
  const sets = getRemainingSetProbabilities(model, species, 5);
  if (sets.length === 0) return [];
  return sets.map(({ set, probability }) => ({
    overrides: setToOverrides(set),
    probability,
  }));
}

/**
 * Calculate probability-weighted damage across opponent's possible sets.
 * Returns weighted average DamageResult values.
 */
function calculateWeightedDamage(
  attacker: PokemonState,
  defender: PokemonState,
  moveName: string,
  field: FieldState,
  model: OpponentModel,
  attackerOverrides?: { item?: string; ability?: string; evs?: Partial<Record<string, number>>; ivs?: Partial<Record<string, number>>; nature?: string },
): { avgDmg: number; minDmg: number; maxDmg: number; koChance: number; realMaxHP: number } {
  const defSets = getWeightedDefenderSets(model, defender.species);
  if (defSets.length === 0) {
    const result = calculateDamage(attacker, defender, moveName, field, attackerOverrides);
    return { avgDmg: result.avgDmg, minDmg: result.minDmg, maxDmg: result.maxDmg, koChance: result.koChance, realMaxHP: result.realMaxHP };
  }

  let weightedAvg = 0, weightedMin = 0, weightedMax = 0, weightedKo = 0, maxHP = 0;
  for (const { overrides, probability } of defSets) {
    const result = calculateDamage(attacker, defender, moveName, field, attackerOverrides, overrides);
    weightedAvg += result.avgDmg * probability;
    weightedMin += result.minDmg * probability;
    weightedMax += result.maxDmg * probability;
    weightedKo += result.koChance * probability;
    if (result.realMaxHP > maxHP) maxHP = result.realMaxHP;
  }

  return { avgDmg: weightedAvg, minDmg: weightedMin, maxDmg: weightedMax, koChance: weightedKo, realMaxHP: maxHP };
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

/**
 * Normalize scores relative to each other within the same turn.
 * Best option → 100, worst → 0. If all equal, all get 50.
 * Mutates the results array in place.
 */
function normalizeScoresRelative(results: ScoredOption[]): void {
  if (results.length === 0) return;

  const scores = results.map(r => r.score);
  const minScore = Math.min(...scores);
  const maxScore = Math.max(...scores);
  const range = maxScore - minScore;

  for (const result of results) {
    if (range < 1e-9) {
      // All options are effectively equal
      result.score = 0.5;
    } else {
      result.score = (result.score - minScore) / range;
    }
  }
}
