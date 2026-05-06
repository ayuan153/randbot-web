import { describe, it, expect } from 'vitest';
import { search } from './minimax';
import type { BattleSnapshot, PokemonState, FieldState, OpponentModel, EvalConfig, RandbatsSet } from '../types';

function makeMon(overrides: Partial<PokemonState> = {}): PokemonState {
  return {
    species: 'Pikachu', level: 80, hp: 100, hpMax: 100,
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

const defaultConfig: EvalConfig = {
  depth: 2,
  topN: 5,
  timeLimitMs: 5000,
  evalMode: 'heuristic',
};

function makeOpponentModel(species: string, set: RandbatsSet): OpponentModel {
  return {
    pokemon: [{
      species,
      possibleSets: [{ set, probability: 1.0 }],
      revealedMoves: [],
      revealedItem: null,
      revealedAbility: null,
    }],
    unrevealed: 5,
  };
}

const blastoiseSet: RandbatsSet = {
  ability: 'Torrent',
  item: 'Leftovers',
  moves: ['Surf', 'Ice Beam', 'Rapid Spin', 'Flip Turn'],
  evs: { hp: 252, def: 252, spd: 4 },
  ivs: {},
  nature: 'Bold',
};

function makeSnapshot(overrides?: Partial<BattleSnapshot>): BattleSnapshot {
  return {
    roomId: 'test', turn: 1, format: 'gen9randombattle',
    player: {
      active: makeMon({ species: 'Pikachu', level: 80, hp: 200, hpMax: 200, moves: ['Thunderbolt', 'Surf'] }),
      bench: [],
    },
    opponent: {
      active: makeMon({ species: 'Blastoise', level: 80, hp: 100, hpMax: 100 }),
      bench: [],
    },
    field: emptyField,
    availableActions: [
      { type: 'move', id: 'thunderbolt', name: 'Thunderbolt', pp: 24, maxPp: 24, target: 'normal', disabled: false },
      { type: 'move', id: 'surf', name: 'Surf', pp: 24, maxPp: 24, target: 'normal', disabled: false },
    ],
    ...overrides,
  };
}

describe('search', () => {
  it('returns scored options for available moves', () => {
    const snapshot = makeSnapshot();
    const model = makeOpponentModel('Blastoise', blastoiseSet);

    const results = search(snapshot, model, defaultConfig);

    expect(results.length).toBeGreaterThan(0);
    expect(results.length).toBeLessThanOrEqual(2);
    for (const r of results) {
      expect(r.score).toBeGreaterThanOrEqual(0);
      expect(r.score).toBeLessThanOrEqual(1);
      expect(r.action).toBeDefined();
      expect(r.breakdown).toBeDefined();
      expect(r.principalVariation.length).toBeGreaterThan(0);
    }
  });

  it('scores super-effective move higher than not-very-effective move', () => {
    // Pikachu vs Blastoise: Thunderbolt is SE (Electric vs Water), Surf is NVE (Water vs Water)
    const snapshot = makeSnapshot();
    const model = makeOpponentModel('Blastoise', blastoiseSet);

    const results = search(snapshot, model, defaultConfig);

    const tboltResult = results.find(r => r.action.type === 'move' && r.action.id === 'thunderbolt');
    const surfResult = results.find(r => r.action.type === 'move' && r.action.id === 'surf');

    expect(tboltResult).toBeDefined();
    expect(surfResult).toBeDefined();
    expect(tboltResult!.score).toBeGreaterThan(surfResult!.score);
  });

  it('normalizes scores: best=1.0, worst=0.0 when options differ', () => {
    // Pikachu vs Blastoise: Thunderbolt (SE) vs Surf (NVE) should produce different values
    const snapshot = makeSnapshot();
    const model = makeOpponentModel('Blastoise', blastoiseSet);

    const results = search(snapshot, model, defaultConfig);

    if (results.length >= 2) {
      const scores = results.map(r => r.score);
      const maxScore = Math.max(...scores);
      const minScore = Math.min(...scores);
      // If scores differ, they should be normalized to 1.0 and 0.0
      if (maxScore !== minScore) {
        expect(maxScore).toBeCloseTo(1.0);
        expect(minScore).toBeCloseTo(0.0);
      }
    }
  });

  it('assigns 0.5 to all options when scores are equal', () => {
    // Use same move twice — both should produce identical minimax values
    const snapshot = makeSnapshot({
      player: {
        active: makeMon({ species: 'Pikachu', level: 80, hp: 200, hpMax: 200, moves: ['Thunderbolt'] }),
        bench: [],
      },
      availableActions: [
        { type: 'move', id: 'thunderbolt', name: 'Thunderbolt', pp: 24, maxPp: 24, target: 'normal', disabled: false },
        { type: 'move', id: 'thunderbolt', name: 'Thunderbolt', pp: 24, maxPp: 24, target: 'normal', disabled: false },
      ],
    });
    const model = makeOpponentModel('Blastoise', blastoiseSet);

    const results = search(snapshot, model, defaultConfig);

    for (const r of results) {
      expect(r.score).toBeCloseTo(0.5);
    }
  });

  it('scores switches differently based on matchup', () => {
    const snapshot = makeSnapshot({
      player: {
        active: makeMon({ species: 'Pikachu', level: 80, hp: 200, hpMax: 200, moves: ['Thunderbolt'] }),
        bench: [
          makeMon({ species: 'Ferrothorn', level: 75, hp: 250, hpMax: 250, moves: ['Power Whip'] }),
          makeMon({ species: 'Magikarp', level: 90, hp: 80, hpMax: 80, moves: ['Splash'] }),
        ],
      },
      availableActions: [
        { type: 'switch', species: 'Ferrothorn', slot: 2 },
        { type: 'switch', species: 'Magikarp', slot: 3 },
      ],
    });
    const model = makeOpponentModel('Blastoise', blastoiseSet);

    const results = search(snapshot, model, defaultConfig);

    expect(results.length).toBe(2);
    const ferroResult = results.find(r => r.action.type === 'switch' && r.action.species === 'Ferrothorn');
    const magResult = results.find(r => r.action.type === 'switch' && r.action.species === 'Magikarp');

    expect(ferroResult).toBeDefined();
    expect(magResult).toBeDefined();
    // Ferrothorn resists Water and has high bulk; Magikarp is frail
    expect(ferroResult!.score).toBeGreaterThan(magResult!.score);
  });

  it('returns empty array when no actions available', () => {
    const snapshot = makeSnapshot({ availableActions: [] });
    const model = makeOpponentModel('Blastoise', blastoiseSet);

    const results = search(snapshot, model, defaultConfig);

    expect(results).toHaveLength(0);
  });

  it('respects topN config', () => {
    const snapshot = makeSnapshot({
      availableActions: [
        { type: 'move', id: 'thunderbolt', name: 'Thunderbolt', pp: 24, maxPp: 24, target: 'normal', disabled: false },
        { type: 'move', id: 'surf', name: 'Surf', pp: 24, maxPp: 24, target: 'normal', disabled: false },
        { type: 'move', id: 'icebeam', name: 'Ice Beam', pp: 16, maxPp: 16, target: 'normal', disabled: false },
      ],
    });
    const model = makeOpponentModel('Blastoise', blastoiseSet);

    const results = search(snapshot, model, { ...defaultConfig, topN: 2 });

    expect(results.length).toBeLessThanOrEqual(2);
  });
});
