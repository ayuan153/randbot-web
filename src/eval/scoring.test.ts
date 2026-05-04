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
