import { describe, it, expect, beforeEach } from 'vitest';
import { createOpponentModel, revealPokemon, revealMove, revealItem, revealAbility, getLikelyMoves } from './opponent-model';
import { setSetsDb } from '../state/sets-db';

// Mock randbats data for testing
const MOCK_DB = {
  'Pikachu': {
    level: 84,
    roles: {
      'Fast Attacker': {
        moves: ['Thunderbolt', 'Volt Switch', 'Surf', 'Grass Knot'],
        items: ['Light Ball'],
        abilities: ['Lightning Rod'],
        evs: { spa: 252, spe: 252, hp: 4 },
        teraTypes: ['Electric'],
      },
      'Tera Blast': {
        moves: ['Thunderbolt', 'Tera Blast', 'Nasty Plot', 'Encore'],
        items: ['Light Ball'],
        abilities: ['Static'],
        evs: { spa: 252, spe: 252, hp: 4 },
        teraTypes: ['Ice'],
      },
    },
  },
};

describe('opponent-model', () => {
  beforeEach(() => {
    setSetsDb(MOCK_DB as any);
  });

  it('creates empty model', () => {
    const model = createOpponentModel(6);
    expect(model.pokemon).toHaveLength(0);
    expect(model.unrevealed).toBe(6);
  });

  it('reveals a pokemon with uniform prior', () => {
    let model = createOpponentModel(6);
    model = revealPokemon(model, 'Pikachu');

    expect(model.pokemon).toHaveLength(1);
    expect(model.unrevealed).toBe(5);
    expect(model.pokemon[0].species).toBe('Pikachu');
    expect(model.pokemon[0].possibleSets).toHaveLength(2);
    // Uniform prior
    expect(model.pokemon[0].possibleSets[0].probability).toBeCloseTo(0.5);
    expect(model.pokemon[0].possibleSets[1].probability).toBeCloseTo(0.5);
  });

  it('does not add duplicate pokemon', () => {
    let model = createOpponentModel(6);
    model = revealPokemon(model, 'Pikachu');
    model = revealPokemon(model, 'Pikachu');
    expect(model.pokemon).toHaveLength(1);
  });

  it('narrows sets when move is revealed', () => {
    let model = createOpponentModel(6);
    model = revealPokemon(model, 'Pikachu');
    // Surf is only in 'Fast Attacker' role
    model = revealMove(model, 'Pikachu', 'Surf');

    const pika = model.pokemon[0];
    expect(pika.revealedMoves).toContain('Surf');
    // Only Fast Attacker set has Surf
    expect(pika.possibleSets).toHaveLength(1);
    expect(pika.possibleSets[0].probability).toBeCloseTo(1.0);
    expect(pika.possibleSets[0].set.moves).toContain('Surf');
  });

  it('narrows sets when ability is revealed', () => {
    let model = createOpponentModel(6);
    model = revealPokemon(model, 'Pikachu');
    model = revealAbility(model, 'Pikachu', 'Static');

    const pika = model.pokemon[0];
    expect(pika.possibleSets).toHaveLength(1);
    expect(pika.possibleSets[0].set.ability).toBe('Static');
  });

  it('gets likely moves weighted by set probability', () => {
    let model = createOpponentModel(6);
    model = revealPokemon(model, 'Pikachu');

    const moves = getLikelyMoves(model, 'Pikachu');
    // Thunderbolt is in both sets, should have highest probability
    const tbolt = moves.find(m => m.move === 'Thunderbolt');
    expect(tbolt).toBeDefined();
    expect(tbolt!.probability).toBeGreaterThan(0);
  });
});
