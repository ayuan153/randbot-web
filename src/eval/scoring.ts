/**
 * Heuristic state evaluator for minimax leaf nodes.
 * Evaluates a game state from the player's perspective.
 * Returns a value in [-1, 1] where positive = player advantage.
 */

import type { BattleSnapshot, PokemonState, ScoreBreakdown, FieldState } from '../types';
import { calculateDamage, damagePercent, DefenderOverrides } from './damage';

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
