import { describe, it, expect } from 'vitest';
import { evaluate } from './scoring';
import type { BattleSnapshot } from '../types';

function makeSnapshot(overrides: Partial<BattleSnapshot> = {}): BattleSnapshot {
  return {
    roomId: 'battle-gen9randombattle-1',
    turn: 1,
    format: 'gen9randombattle',
    player: {
      active: {
        species: 'Pikachu', level: 84, hp: 100, hpMax: 100,
        status: null, boosts: {}, moves: ['Thunderbolt'],
        item: 'Light Ball', ability: 'Static', teraType: null, terastallized: false,
      },
      bench: [],
    },
    opponent: {
      active: {
        species: 'Blastoise', level: 80, hp: 100, hpMax: 100,
        status: null, boosts: {}, moves: [],
        item: null, ability: null, teraType: null, terastallized: false,
      },
      bench: [],
    },
    field: {
      weather: null, weatherTurns: 0, terrain: null, terrainTurns: 0,
      playerSide: { spikes: 0, stealthRock: false, toxicSpikes: 0, stickyWeb: false, reflect: 0, lightScreen: 0, auroraVeil: 0, tailwind: 0 },
      opponentSide: { spikes: 0, stealthRock: false, toxicSpikes: 0, stickyWeb: false, reflect: 0, lightScreen: 0, auroraVeil: 0, tailwind: 0 },
    },
    availableActions: [],
    ...overrides,
  };
}

describe('evaluate', () => {
  it('returns 0 for symmetric state', () => {
    const snapshot = makeSnapshot();
    const value = evaluate(snapshot);
    // Both sides have 1 mon at full HP, should be roughly 0
    expect(Math.abs(value)).toBeLessThan(0.1);
  });

  it('returns positive when player has HP advantage', () => {
    const snapshot = makeSnapshot({
      opponent: {
        active: {
          species: 'Blastoise', level: 80, hp: 30, hpMax: 100,
          status: null, boosts: {}, moves: [],
          item: null, ability: null, teraType: null, terastallized: false,
        },
        bench: [],
      },
    });
    expect(evaluate(snapshot)).toBeGreaterThan(0);
  });

  it('returns negative when player is at disadvantage', () => {
    const snapshot = makeSnapshot({
      player: {
        active: {
          species: 'Pikachu', level: 84, hp: 20, hpMax: 100,
          status: 'brn', boosts: {}, moves: ['Thunderbolt'],
          item: null, ability: 'Static', teraType: null, terastallized: false,
        },
        bench: [],
      },
    });
    expect(evaluate(snapshot)).toBeLessThan(0);
  });

  it('values hazards on opponent side positively', () => {
    const base = makeSnapshot();
    const withHazards = makeSnapshot({
      field: {
        ...base.field,
        opponentSide: { ...base.field.opponentSide, stealthRock: true, spikes: 2 },
      },
    });
    expect(evaluate(withHazards)).toBeGreaterThan(evaluate(base));
  });
});

import { evaluateSwitchMatchup } from './scoring';
import type { PokemonState } from '../types';

function makeMon(overrides: Partial<PokemonState> = {}): PokemonState {
  return {
    species: 'Pikachu', level: 80, hp: 100, hpMax: 100,
    status: null, boosts: {}, moves: [],
    item: null, ability: null, teraType: null, terastallized: false,
    ...overrides,
  };
}

describe('evaluateSwitchMatchup', () => {
  it('scores a resistant switch-in higher than a weak one', () => {
    const opponent = makeMon({ species: 'Charizard', moves: ['Flamethrower'] });
    // Water resists Fire
    const goodSwitch = makeMon({ species: 'Blastoise', moves: ['Surf'] });
    // Grass is weak to Fire
    const badSwitch = makeMon({ species: 'Venusaur', moves: ['Giga Drain'] });

    const goodScore = evaluateSwitchMatchup(goodSwitch, opponent);
    const badScore = evaluateSwitchMatchup(badSwitch, opponent);

    expect(goodScore).toBeGreaterThan(badScore);
  });

  it('scores a switch with offensive advantage higher', () => {
    const opponent = makeMon({ species: 'Gyarados', moves: ['Waterfall'] });
    // Electric is SE against Gyarados
    const goodSwitch = makeMon({ species: 'Raichu', moves: ['Thunderbolt'] });
    // Normal has no advantage
    const neutralSwitch = makeMon({ species: 'Snorlax', moves: ['Body Slam'] });

    const goodScore = evaluateSwitchMatchup(goodSwitch, opponent);
    const neutralScore = evaluateSwitchMatchup(neutralSwitch, opponent);

    expect(goodScore).toBeGreaterThan(neutralScore);
  });

  it('returns different scores (not flat 0.5) for varied matchups', () => {
    const opponent = makeMon({ species: 'Garchomp', moves: ['Earthquake', 'Dragon Claw'] });
    const switchA = makeMon({ species: 'Corviknight', moves: ['Brave Bird'] });
    const switchB = makeMon({ species: 'Tyranitar', moves: ['Stone Edge'] });

    const scoreA = evaluateSwitchMatchup(switchA, opponent);
    const scoreB = evaluateSwitchMatchup(switchB, opponent);

    // They should not be identical
    expect(scoreA).not.toEqual(scoreB);
    // Both should be in [0, 1]
    expect(scoreA).toBeGreaterThanOrEqual(0);
    expect(scoreA).toBeLessThanOrEqual(1);
    expect(scoreB).toBeGreaterThanOrEqual(0);
    expect(scoreB).toBeLessThanOrEqual(1);
  });

  it('factors in HP remaining', () => {
    const opponent = makeMon({ species: 'Charizard', moves: ['Flamethrower'] });
    const healthy = makeMon({ species: 'Blastoise', hp: 100, hpMax: 100, moves: ['Surf'] });
    const injured = makeMon({ species: 'Blastoise', hp: 20, hpMax: 100, moves: ['Surf'] });

    expect(evaluateSwitchMatchup(healthy, opponent)).toBeGreaterThan(
      evaluateSwitchMatchup(injured, opponent)
    );
  });
});
