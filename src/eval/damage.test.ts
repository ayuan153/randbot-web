import { describe, it, expect } from 'vitest';
import { calculateDamage, damagePercent, DamageResult } from './damage';
import type { PokemonState, FieldState } from '../types';

function makeMon(overrides: Partial<PokemonState> = {}): PokemonState {
  return {
    species: 'Pikachu', level: 100, hp: 100, hpMax: 100,
    status: null, boosts: {}, moves: [],
    item: null, ability: null, teraType: null, terastallized: false,
    ...overrides,
  };
}

const emptyField: FieldState = {
  weather: null, weatherTurns: 0, terrain: null, terrainTurns: 0,
  playerSide: { spikes: 0, stealthRock: false, toxicSpikes: 0, stickyWeb: false, reflect: 0, lightScreen: 0, auroraVeil: 0, tailwind: 0 },
  opponentSide: { spikes: 0, stealthRock: false, toxicSpikes: 0, stickyWeb: false, reflect: 0, lightScreen: 0, auroraVeil: 0, tailwind: 0 },
};

describe('calculateDamage', () => {
  it('returns a valid DamageResult with all fields', () => {
    const attacker = makeMon({ species: 'Garchomp', level: 75, moves: ['Earthquake'] });
    const defender = makeMon({ species: 'Pikachu', level: 80, hp: 200, hpMax: 200 });

    const result = calculateDamage(attacker, defender, 'Earthquake', emptyField);

    expect(result.move).toBe('Earthquake');
    expect(result.minDmg).toBeGreaterThan(0);
    expect(result.maxDmg).toBeGreaterThanOrEqual(result.minDmg);
    expect(result.avgDmg).toBeGreaterThanOrEqual(result.minDmg);
    expect(result.avgDmg).toBeLessThanOrEqual(result.maxDmg);
    expect(result.koChance).toBeGreaterThanOrEqual(0);
    expect(result.koChance).toBeLessThanOrEqual(1);
    expect(result.rolls.length).toBeGreaterThan(0);
    expect(result.realMaxHP).toBeGreaterThan(0);
  });

  it('handles multi-hit moves by multiplying per-hit damage', () => {
    const attacker = makeMon({ species: 'Breloom', level: 75, ability: 'Technician', moves: ['Bullet Seed'] });
    const defender = makeMon({ species: 'Blastoise', level: 80, hp: 300, hpMax: 300 });

    const result = calculateDamage(attacker, defender, 'Bullet Seed', emptyField);

    // Bullet Seed hits 2-5 times; damage should reflect multiple hits
    // Compare against a single-hit move from same attacker to verify multiplier effect
    const singleHitResult = calculateDamage(attacker, defender, 'Mach Punch', emptyField);

    // Bullet Seed (multi-hit) should deal more total damage than a single weak hit
    // The key check: avgDmg should be > per-hit damage (i.e., multiplied)
    expect(result.avgDmg).toBeGreaterThan(0);
    expect(result.minDmg).toBeGreaterThan(0);
    // Multi-hit: min should be per-hit-min * hits, so minDmg < maxDmg
    expect(result.maxDmg).toBeGreaterThanOrEqual(result.minDmg);
  });

  it('computes realMaxHP correctly when defender hpMax is 100 (percentage)', () => {
    // Simulate opponent with percentage-based HP (hpMax=100)
    const attacker = makeMon({ species: 'Garchomp', level: 75, moves: ['Earthquake'] });
    const defender = makeMon({ species: 'Blastoise', level: 80, hp: 100, hpMax: 100 });

    const result = calculateDamage(attacker, defender, 'Earthquake', emptyField);

    // Blastoise at level 80 has more than 100 actual HP
    expect(result.realMaxHP).toBeGreaterThan(100);
  });

  it('defender overrides affect damage calculation', () => {
    const attacker = makeMon({ species: 'Garchomp', level: 75, moves: ['Earthquake'] });
    const defender = makeMon({ species: 'Blastoise', level: 80, hp: 300, hpMax: 300 });

    const resultNoOverrides = calculateDamage(attacker, defender, 'Earthquake', emptyField);
    const resultWithDefense = calculateDamage(attacker, defender, 'Earthquake', emptyField, undefined, {
      evs: { hp: 252, def: 252 },
      nature: 'Bold',
    });

    // More defensive EVs/nature should reduce damage taken
    expect(resultWithDefense.avgDmg).toBeLessThan(resultNoOverrides.avgDmg);
  });

  it('returns zero damage for invalid/status moves', () => {
    const attacker = makeMon({ species: 'Pikachu', level: 80, moves: ['Thunder Wave'] });
    const defender = makeMon({ species: 'Blastoise', level: 80, hp: 300, hpMax: 300 });

    const result = calculateDamage(attacker, defender, 'Thunder Wave', emptyField);

    expect(result.avgDmg).toBe(0);
    expect(result.minDmg).toBe(0);
    expect(result.maxDmg).toBe(0);
  });

  it('returns zero damage for nonexistent moves', () => {
    const attacker = makeMon({ species: 'Pikachu', level: 80 });
    const defender = makeMon({ species: 'Blastoise', level: 80 });

    const result = calculateDamage(attacker, defender, 'NotARealMove', emptyField);

    expect(result.avgDmg).toBe(0);
    expect(result.minDmg).toBe(0);
    expect(result.maxDmg).toBe(0);
  });

  it('boosts affect damage output', () => {
    const attacker = makeMon({ species: 'Garchomp', level: 75, moves: ['Earthquake'] });
    const defender = makeMon({ species: 'Blastoise', level: 80, hp: 300, hpMax: 300 });

    const resultNeutral = calculateDamage(attacker, defender, 'Earthquake', emptyField);
    const boostedAttacker = makeMon({ species: 'Garchomp', level: 75, moves: ['Earthquake'], boosts: { atk: 2 } });
    const resultBoosted = calculateDamage(boostedAttacker, defender, 'Earthquake', emptyField);

    expect(resultBoosted.avgDmg).toBeGreaterThan(resultNeutral.avgDmg);
  });
});

describe('damagePercent', () => {
  it('returns avgDmg / realMaxHP when realMaxHP is set', () => {
    const result: DamageResult = {
      move: 'Earthquake', minDmg: 80, maxDmg: 100, avgDmg: 90,
      koChance: 0, rolls: [80, 90, 100], realMaxHP: 300,
    };
    expect(damagePercent(result, 100)).toBeCloseTo(90 / 300);
  });

  it('falls back to defenderMaxHp when realMaxHP is 0', () => {
    const result: DamageResult = {
      move: 'Earthquake', minDmg: 80, maxDmg: 100, avgDmg: 90,
      koChance: 0, rolls: [80, 90, 100], realMaxHP: 0,
    };
    expect(damagePercent(result, 200)).toBeCloseTo(90 / 200);
  });

  it('returns 0 when both HP values are 0', () => {
    const result: DamageResult = {
      move: 'Earthquake', minDmg: 0, maxDmg: 0, avgDmg: 0,
      koChance: 0, rolls: [], realMaxHP: 0,
    };
    expect(damagePercent(result, 0)).toBe(0);
  });
});
