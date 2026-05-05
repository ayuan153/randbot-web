/**
 * Wrapper around @smogon/calc for damage calculation.
 * Translates our PokemonState + FieldState into @smogon/calc inputs.
 */

import { calculate, Generations, Pokemon, Move, Field } from '@smogon/calc';
import type { Weather, Terrain, StatusName, TypeName } from '@smogon/calc/dist/data/interface';
import type { PokemonState, FieldState } from '../types';

const gen = Generations.get(9);

export interface DamageResult {
  move: string;
  minDmg: number;
  maxDmg: number;
  avgDmg: number;
  koChance: number;
  rolls: number[];
  /** The defender's real max HP (computed from stats, not percentage) */
  realMaxHP: number;
}

export interface DefenderOverrides {
  evs?: Partial<Record<string, number>>;
  ivs?: Partial<Record<string, number>>;
  nature?: string;
  ability?: string;
  item?: string;
}

/** Map our boost keys to @smogon/calc stat names */
const BOOST_MAP: Record<string, string> = {
  atk: 'atk', def: 'def', spa: 'spa', spd: 'spd', spe: 'spe',
};

/** Convert our FieldState to @smogon/calc Field */
function buildField(field: FieldState, attackerIsPlayer: boolean): Field {
  const playerSide = field.playerSide;
  const oppSide = field.opponentSide;

  const attackerSide = attackerIsPlayer ? playerSide : oppSide;
  const defenderSide = attackerIsPlayer ? oppSide : playerSide;

  return new Field({
    weather: (field.weather || undefined) as Weather | undefined,
    terrain: (field.terrain || undefined) as Terrain | undefined,
    attackerSide: {
      isReflect: attackerSide.reflect > 0,
      isLightScreen: attackerSide.lightScreen > 0,
      isAuroraVeil: attackerSide.auroraVeil > 0,
      isTailwind: attackerSide.tailwind > 0,
    },
    defenderSide: {
      isReflect: defenderSide.reflect > 0,
      isLightScreen: defenderSide.lightScreen > 0,
      isAuroraVeil: defenderSide.auroraVeil > 0,
      spikes: defenderSide.spikes,
      steelsurge: false,
      isSR: defenderSide.stealthRock,
    },
  });
}

/** Convert our PokemonState to @smogon/calc Pokemon */
function buildPokemon(
  state: PokemonState,
  overrides?: { item?: string; ability?: string; evs?: Partial<Record<string, number>>; ivs?: Partial<Record<string, number>>; nature?: string }
): Pokemon {
  const boosts: Record<string, number> = {};
  for (const [key, val] of Object.entries(state.boosts)) {
    if (BOOST_MAP[key]) boosts[BOOST_MAP[key]] = val;
  }

  return new Pokemon(gen, state.species, {
    level: state.level,
    item: overrides?.item || state.item || undefined,
    ability: overrides?.ability || state.ability || undefined,
    nature: overrides?.nature || undefined,
    evs: overrides?.evs || undefined,
    ivs: overrides?.ivs || undefined,
    boosts,
    status: (state.status || undefined) as StatusName | undefined,
    curHP: state.hp,
    teraType: state.terastallized ? ((state.teraType || undefined) as TypeName | undefined) : undefined,
  });
}

/**
 * Calculate damage for a move from attacker to defender.
 * Returns damage rolls, average, and KO chance.
 */
export function calculateDamage(
  attacker: PokemonState,
  defender: PokemonState,
  moveName: string,
  field: FieldState,
  attackerOverrides?: { item?: string; ability?: string; evs?: Partial<Record<string, number>>; ivs?: Partial<Record<string, number>>; nature?: string },
  defenderOverrides?: DefenderOverrides,
): DamageResult {
  try {
    const atkMon = buildPokemon(attacker, attackerOverrides);
    const defMon = buildPokemon(defender, defenderOverrides);

    // Fix Bug 1: Opponent HP is reported as percentage (hpMax=100).
    // @smogon/calc needs curHP relative to the Pokemon's actual max HP stat.
    // If hpMax is 100 (percentage-based), convert to actual HP.
    const realMaxHP = defMon.maxHP();
    let defenderActualCurHP: number;
    if (defender.hpMax === 100 && realMaxHP !== 100) {
      // Opponent: hp is a percentage, convert to actual
      defenderActualCurHP = Math.ceil(defender.hp * realMaxHP / 100);
      defMon.originalCurHP = defenderActualCurHP;
    } else {
      // Player side: hp is already actual
      defenderActualCurHP = defender.hp;
    }

    const move = new Move(gen, moveName);
    const calcField = buildField(field, true);

    const result = calculate(gen, atkMon, defMon, move, calcField);

    // result.damage is either a number or number[] (16 rolls)
    const rolls: number[] = Array.isArray(result.damage)
      ? (result.damage as number[])
      : [result.damage as number];

    const minDmg = Math.min(...rolls);
    const maxDmg = Math.max(...rolls);
    const avgDmg = rolls.reduce((a, b) => a + b, 0) / rolls.length;

    // Fix Bug 3: Compare rolls against actual current HP, not percentage
    const koRolls = rolls.filter(d => d >= defenderActualCurHP).length;
    const koChance = rolls.length > 0 ? koRolls / rolls.length : 0;

    return { move: moveName, minDmg, maxDmg, avgDmg, koChance, rolls, realMaxHP };
  } catch {
    // Move doesn't exist or calc fails — return zero damage
    return { move: moveName, minDmg: 0, maxDmg: 0, avgDmg: 0, koChance: 0, rolls: [], realMaxHP: 0 };
  }
}

/**
 * Calculate damage as a percentage of defender's max HP.
 * Uses the real max HP from the calc result when available (handles percentage-based HP).
 */
export function damagePercent(result: DamageResult, defenderMaxHp: number): number {
  const hp = result.realMaxHP > 0 ? result.realMaxHP : defenderMaxHp;
  if (hp <= 0) return 0;
  return result.avgDmg / hp;
}
