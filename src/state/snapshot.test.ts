import { describe, it, expect } from 'vitest';
import { parseCondition, parseDetails, extractSideField, extractActions, deriveFormat } from './snapshot';

describe('parseCondition', () => {
  it('parses hp/max format', () => {
    expect(parseCondition('267/300')).toEqual({ hp: 267, hpMax: 300, status: null });
  });

  it('parses hp/max with status', () => {
    expect(parseCondition('150/300 brn')).toEqual({ hp: 150, hpMax: 300, status: 'brn' });
  });

  it('handles fainted', () => {
    expect(parseCondition('0 fnt')).toEqual({ hp: 0, hpMax: 0, status: 'fnt' });
  });

  it('handles empty string', () => {
    expect(parseCondition('')).toEqual({ hp: 0, hpMax: 0, status: 'fnt' });
  });
});

describe('parseDetails', () => {
  it('parses species and level', () => {
    expect(parseDetails('Pikachu, L84, M')).toEqual({ species: 'Pikachu', level: 84 });
  });

  it('defaults to level 100', () => {
    expect(parseDetails('Arceus')).toEqual({ species: 'Arceus', level: 100 });
  });

  it('handles forme', () => {
    expect(parseDetails('Rotom-Wash, L82, F')).toEqual({ species: 'Rotom-Wash', level: 82 });
  });
});

describe('extractSideField', () => {
  it('extracts hazards from sideConditions', () => {
    const conditions = {
      stealthrock: [1],
      spikes: [1, 2],
      toxicspikes: [1, 1],
    } as unknown as Record<string, unknown[]>;

    const result = extractSideField(conditions);
    expect(result.stealthRock).toBe(true);
    expect(result.spikes).toBe(2);
    expect(result.toxicSpikes).toBe(1);
    expect(result.stickyWeb).toBe(false);
  });

  it('handles empty conditions', () => {
    const result = extractSideField({});
    expect(result.stealthRock).toBe(false);
    expect(result.spikes).toBe(0);
    expect(result.reflect).toBe(0);
  });
});

describe('extractActions', () => {
  it('extracts moves from request', () => {
    const request = {
      active: [{
        moves: [
          { id: 'thunderbolt', move: 'Thunderbolt', pp: 15, maxpp: 15, target: 'normal' },
          { id: 'icebeam', move: 'Ice Beam', pp: 10, maxpp: 10, target: 'normal', disabled: false },
          { id: 'voltswitch', move: 'Volt Switch', pp: 20, maxpp: 20, target: 'normal', disabled: true },
        ],
      }],
      side: { pokemon: [] },
    };

    const actions = extractActions(request);
    expect(actions).toHaveLength(2); // voltswitch is disabled
    expect(actions[0]).toEqual({
      type: 'move', id: 'thunderbolt', name: 'Thunderbolt',
      pp: 15, maxPp: 15, target: 'normal', disabled: false,
    });
  });

  it('extracts switches from bench', () => {
    const request = {
      active: [{ moves: [] }],
      side: {
        pokemon: [
          { active: true, details: 'Pikachu, L84, M', condition: '100/100' },
          { active: false, details: 'Charizard, L78, M', condition: '200/300' },
          { active: false, details: 'Blastoise, L80, F', condition: '0 fnt' },
        ],
      },
    };

    const actions = extractActions(request);
    expect(actions).toHaveLength(1); // only Charizard (Blastoise fainted)
    expect(actions[0]).toEqual({ type: 'switch', species: 'Charizard', slot: 2 });
  });
});

describe('deriveFormat', () => {
  it('extracts format from roomId', () => {
    expect(deriveFormat('battle-gen9randombattle-12345')).toBe('gen9randombattle');
  });

  it('defaults to gen9randombattle', () => {
    expect(deriveFormat('unknown')).toBe('gen9randombattle');
  });
});
