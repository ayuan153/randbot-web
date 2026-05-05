/**
 * Heuristic state evaluator for minimax leaf nodes.
 * Evaluates a game state from the player's perspective.
 * Returns a value in [-1, 1] where positive = player advantage.
 */

import type { BattleSnapshot, PokemonState, ScoreBreakdown, FieldState } from '../types';
import { calculateDamage, damagePercent, DefenderOverrides } from './damage';
import { Generations, TypeName } from '@pkmn/data';
import { Dex } from '@pkmn/dex';

const gens = new Generations(Dex);
const gen9 = gens.get(9);

// ─── Weights ────────────────────────────────────────────────────

const W_HP = 0.40;
const W_ITEM = 0.05;
const W_BOOSTS = 0.10;
const W_ALIVE = 0.30;
const W_STATUS_PENALTY = 0.15;

const W_HAZARD = 0.12;
const W_STATUS_DELTA = 0.10;
const W_SPEED = 0.08;

// ─── Leaf Node Evaluation ───────────────────────────────────────

/**
 * Evaluate a game state. Returns value in [-1, 1].
 * Positive = player advantage, negative = opponent advantage.
 */
export function evaluate(snapshot: BattleSnapshot): number {
  const myValue = sideValue(snapshot.player.active, snapshot.player.bench);
  const oppValue = sideValue(snapshot.opponent.active, snapshot.opponent.bench);
  const positional = positionalScore(snapshot);

  // Normalize to [-1, 1] range
  const raw = myValue - oppValue + positional;
  return Math.tanh(raw);
}

/** Sum value of all pokemon on a side */
function sideValue(active: PokemonState, bench: PokemonState[]): number {
  const all = [active, ...bench];
  let total = 0;

  for (const mon of all) {
    if (mon.hp <= 0) continue;
    const hpFraction = mon.hpMax > 0 ? mon.hp / mon.hpMax : 0;
    const hasItem = mon.item ? 1 : 0;
    const boostSum = Object.values(mon.boosts).reduce((s, b) => s + Math.max(0, b), 0);
    const statusPenalty = mon.status ? statusWeight(mon.status) : 0;

    total += (
      W_HP * hpFraction +
      W_ITEM * hasItem +
      W_BOOSTS * Math.min(boostSum / 6, 1) +
      W_ALIVE * 1 -
      W_STATUS_PENALTY * statusPenalty
    );
  }

  return total;
}

/** Positional factors: hazards, status spread, speed control */
function positionalScore(snapshot: BattleSnapshot): number {
  const myField = snapshot.field.playerSide;
  const oppField = snapshot.field.opponentSide;

  // Hazard advantage (opponent has more hazards = good for us)
  const oppHazards = (oppField.stealthRock ? 1 : 0) + oppField.spikes * 0.5 + oppField.toxicSpikes * 0.5 + (oppField.stickyWeb ? 1 : 0);
  const myHazards = (myField.stealthRock ? 1 : 0) + myField.spikes * 0.5 + myField.toxicSpikes * 0.5 + (myField.stickyWeb ? 1 : 0);
  const hazardDelta = (oppHazards - myHazards) / 4; // normalize

  // Screen advantage
  const myScreens = (myField.reflect > 0 ? 1 : 0) + (myField.lightScreen > 0 ? 1 : 0) + (myField.auroraVeil > 0 ? 1 : 0);
  const oppScreens = (oppField.reflect > 0 ? 1 : 0) + (oppField.lightScreen > 0 ? 1 : 0) + (oppField.auroraVeil > 0 ? 1 : 0);
  const screenDelta = (myScreens - oppScreens) / 3;

  // Status spread (how many opponent mons are statused vs ours)
  const oppStatused = [snapshot.opponent.active, ...snapshot.opponent.bench].filter(p => p.status && p.hp > 0).length;
  const myStatused = [snapshot.player.active, ...snapshot.player.bench].filter(p => p.status && p.hp > 0).length;
  const statusDelta = (oppStatused - myStatused) / 6;

  return W_HAZARD * hazardDelta + W_STATUS_DELTA * statusDelta + W_SPEED * screenDelta;
}

/** Weight of a status condition (how bad it is) */
function statusWeight(status: string): number {
  switch (status) {
    case 'brn': return 0.6;
    case 'par': return 0.5;
    case 'psn': return 0.3;
    case 'tox': return 0.8;
    case 'slp': return 0.7;
    case 'frz': return 0.9;
    case 'fnt': return 1.0;
    default: return 0;
  }
}

// ─── Tactical Breakdown (root-level move scoring) ───────────────

/**
 * Compute tactical breakdown for a specific move action.
 * Used to combine with minimax value at the root.
 */
export function tacticalBreakdown(
  snapshot: BattleSnapshot,
  moveName: string,
  defenderOverrides?: DefenderOverrides,
): ScoreBreakdown {
  const attacker = snapshot.player.active;
  const defender = snapshot.opponent.active;

  const dmgResult = calculateDamage(attacker, defender, moveName, snapshot.field, undefined, defenderOverrides);
  const dmgPct = damagePercent(dmgResult, defender.hpMax);

  return {
    damage: dmgPct,
    koProbability: dmgResult.koChance,
    statusValue: isStatusMove(moveName) ? 0.5 : 0,
    hazardValue: isHazardMove(moveName) ? hazardMoveValue(snapshot) : 0,
    switchInValue: 0, // computed separately for switch actions
    speedAdvantage: speedAdvantage(attacker, defender),
    positionalScore: positionalScore(snapshot),
  };
}

/**
 * Compute tactical score from breakdown.
 */
export function tacticalScore(breakdown: ScoreBreakdown): number {
  return (
    breakdown.koProbability * 0.35 +
    breakdown.damage * 0.25 +
    breakdown.statusValue * 0.15 +
    breakdown.hazardValue * 0.10 +
    breakdown.speedAdvantage * 0.05 +
    breakdown.positionalScore * 0.10
  );
}

// ─── Helpers ────────────────────────────────────────────────────

function speedAdvantage(attacker: PokemonState, defender: PokemonState): number {
  // Simple heuristic: if we're faster, slight advantage
  // In practice we'd need actual speed stats, but we can approximate from boosts
  const atkSpeBoost = attacker.boosts['spe'] || 0;
  const defSpeBoost = defender.boosts['spe'] || 0;
  if (atkSpeBoost > defSpeBoost) return 0.5;
  if (atkSpeBoost < defSpeBoost) return -0.5;
  return 0;
}

const STATUS_MOVES = new Set([
  'thunderwave', 'willowisp', 'toxic', 'spore', 'sleeppowder',
  'stunspore', 'glare', 'nuzzle', 'yawn',
]);

const HAZARD_MOVES = new Set([
  'stealthrock', 'spikes', 'toxicspikes', 'stickyweb', 'cometshards',
]);

function isStatusMove(move: string): boolean {
  return STATUS_MOVES.has(move.toLowerCase().replace(/[^a-z]/g, ''));
}

function isHazardMove(move: string): boolean {
  return HAZARD_MOVES.has(move.toLowerCase().replace(/[^a-z]/g, ''));
}

function hazardMoveValue(snapshot: BattleSnapshot): number {
  // Hazards are more valuable if opponent has more pokemon to switch in
  const oppAlive = [snapshot.opponent.active, ...snapshot.opponent.bench].filter(p => p.hp > 0).length;
  return Math.min(oppAlive / 6, 1);
}

// ─── Switch Evaluation ──────────────────────────────────────────

const W_SWITCH_DEFENSIVE = 0.35;
const W_SWITCH_OFFENSIVE = 0.25;
const W_SWITCH_SPEED = 0.15;
const W_SWITCH_HP = 0.15;
const W_SWITCH_ROLE = 0.10;

/**
 * Evaluate how good a switch-in is against the opponent's active Pokemon.
 * Returns a value in [0, 1] where higher = better switch.
 */
export function evaluateSwitchMatchup(switchIn: PokemonState, opponent: PokemonState): number {
  const defensive = defensiveMatchup(switchIn, opponent);
  const offensive = offensiveMatchup(switchIn, opponent);
  const speed = switchSpeedAdvantage(switchIn, opponent);
  const hp = switchIn.hpMax > 0 ? switchIn.hp / switchIn.hpMax : 0;
  const role = hp; // proxy: preserving a healthy mon = preserving its role

  return (
    W_SWITCH_DEFENSIVE * defensive +
    W_SWITCH_OFFENSIVE * offensive +
    W_SWITCH_SPEED * speed +
    W_SWITCH_HP * hp +
    W_SWITCH_ROLE * role
  );
}

/**
 * How well does the switch-in resist the opponent's attacks?
 * Returns 0-1: 1 = resists everything, 0 = weak to everything.
 */
function defensiveMatchup(switchIn: PokemonState, opponent: PokemonState): number {
  const switchInTypes = getSpeciesTypes(switchIn.species);
  if (!switchInTypes.length) return 0.5;

  // Get attacking types: use opponent's known moves, fall back to STAB types
  const attackingTypes = getAttackingTypes(opponent);
  if (!attackingTypes.length) return 0.5;

  // Average effectiveness of opponent's attacks against our switch-in
  let totalEff = 0;
  for (const atkType of attackingTypes) {
    totalEff += gen9.types.totalEffectiveness(atkType, switchInTypes);
  }
  const avgEff = totalEff / attackingTypes.length;

  // Map effectiveness to 0-1 score: 0.25 (4x resist) → 1, 1 (neutral) → 0.5, 4 (4x weak) → 0
  // Using log2: log2(0.25)=-2, log2(1)=0, log2(4)=2
  // Score = 0.5 - log2(avgEff) * 0.25, clamped to [0, 1]
  return Math.max(0, Math.min(1, 0.5 - Math.log2(avgEff) * 0.25));
}

/**
 * Can the switch-in threaten the opponent offensively?
 * Returns 0-1: 1 = super effective STAB, 0 = resisted.
 */
function offensiveMatchup(switchIn: PokemonState, opponent: PokemonState): number {
  const opponentTypes = getSpeciesTypes(opponent.species);
  if (!opponentTypes.length) return 0.5;

  // Get our attacking types: known moves first, fall back to STAB
  const attackingTypes = getAttackingTypes(switchIn);
  if (!attackingTypes.length) return 0.5;

  // Best effectiveness among our attacks against the opponent
  let bestEff = 0;
  for (const atkType of attackingTypes) {
    const eff = gen9.types.totalEffectiveness(atkType, opponentTypes);
    if (eff > bestEff) bestEff = eff;
  }

  // Map: 4 (4x SE) → 1, 2 (SE) → 0.75, 1 (neutral) → 0.5, 0.5 (resist) → 0.25, 0.25 → 0
  return Math.max(0, Math.min(1, 0.5 + Math.log2(bestEff) * 0.25));
}

/**
 * Is the switch-in faster than the opponent?
 * Returns 0-1: 1 = definitely faster, 0 = definitely slower.
 */
function switchSpeedAdvantage(switchIn: PokemonState, opponent: PokemonState): number {
  const switchSpeed = switchIn.stats?.['spe'];
  const oppSpeed = opponent.stats?.['spe'];

  // If we have actual stats, compare them
  if (switchSpeed && oppSpeed) {
    if (switchSpeed > oppSpeed) return 1;
    if (switchSpeed < oppSpeed) return 0;
    return 0.5;
  }

  // Fall back to boost comparison
  const switchBoost = switchIn.boosts['spe'] || 0;
  const oppBoost = opponent.boosts['spe'] || 0;
  if (switchBoost > oppBoost) return 0.75;
  if (switchBoost < oppBoost) return 0.25;
  return 0.5;
}

/** Get a Pokemon's types from species data. Falls back to empty array. */
function getSpeciesTypes(species: string): TypeName[] {
  const speciesData = gen9.species.get(toID(species));
  return (speciesData?.types as TypeName[] | undefined) ?? [];
}

/** Get the types of attacks a Pokemon is likely to use. */
function getAttackingTypes(mon: PokemonState): TypeName[] {
  const types: TypeName[] = [];

  // Use known moves to determine attacking types
  if (mon.moves.length > 0) {
    for (const moveName of mon.moves) {
      const moveData = gen9.moves.get(toID(moveName));
      if (moveData && moveData.category !== 'Status') {
        types.push(moveData.type as TypeName);
      }
    }
  }

  // If no damaging moves known, fall back to STAB types
  if (types.length === 0) {
    const speciesTypes = getSpeciesTypes(mon.species);
    types.push(...speciesTypes);
  }

  return types;
}

/** Convert a name to an ID (lowercase, alphanumeric only). */
function toID(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}
