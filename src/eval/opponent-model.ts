/**
 * Opponent model — Bayesian narrowing of possible sets.
 * Starts with uniform prior over all possible sets for a species.
 * Updates as information is revealed.
 */

import type { OpponentModel, OpponentPokemonModel, WeightedSet, RandbatsSet } from '../types';
import { getSetsForSpecies } from '../state/sets-db';

/** Create a fresh opponent model for a battle */
export function createOpponentModel(teamSize: number): OpponentModel {
  return { pokemon: [], unrevealed: teamSize };
}

/** Add a newly revealed opponent Pokemon with uniform prior over its sets */
export function revealPokemon(model: OpponentModel, species: string): OpponentModel {
  // Don't add duplicates
  if (model.pokemon.some(p => p.species === species)) return model;

  const sets = getSetsForSpecies(species);
  const uniform = 1 / Math.max(sets.length, 1);
  const possibleSets: WeightedSet[] = sets.map(set => ({ set, probability: uniform }));

  const newMon: OpponentPokemonModel = {
    species,
    possibleSets,
    revealedMoves: [],
    revealedItem: null,
    revealedAbility: null,
  };

  return {
    pokemon: [...model.pokemon, newMon],
    unrevealed: Math.max(0, model.unrevealed - 1),
  };
}

/** Narrow sets after a move is revealed — eliminate sets that don't have this move */
export function revealMove(model: OpponentModel, species: string, move: string): OpponentModel {
  return updatePokemon(model, species, (mon) => {
    if (mon.revealedMoves.includes(move)) return mon;

    const normalizedMove = move.toLowerCase().replace(/[^a-z0-9]/g, '');
    const filtered = mon.possibleSets.filter(ws =>
      ws.set.moves.some(m => m.toLowerCase().replace(/[^a-z0-9]/g, '') === normalizedMove)
    );

    return {
      ...mon,
      revealedMoves: [...mon.revealedMoves, move],
      possibleSets: renormalize(filtered.length > 0 ? filtered : mon.possibleSets),
    };
  });
}

/** Narrow sets after item is revealed */
export function revealItem(model: OpponentModel, species: string, item: string): OpponentModel {
  return updatePokemon(model, species, (mon) => {
    if (mon.revealedItem === item) return mon;

    const normalizedItem = item.toLowerCase().replace(/[^a-z0-9]/g, '');
    const filtered = mon.possibleSets.filter(ws =>
      ws.set.item.toLowerCase().replace(/[^a-z0-9]/g, '') === normalizedItem
    );

    return {
      ...mon,
      revealedItem: item,
      possibleSets: renormalize(filtered.length > 0 ? filtered : mon.possibleSets),
    };
  });
}

/** Narrow sets after ability is revealed */
export function revealAbility(model: OpponentModel, species: string, ability: string): OpponentModel {
  return updatePokemon(model, species, (mon) => {
    if (mon.revealedAbility === ability) return mon;

    const normalizedAbility = ability.toLowerCase().replace(/[^a-z0-9]/g, '');
    const filtered = mon.possibleSets.filter(ws =>
      ws.set.ability.toLowerCase().replace(/[^a-z0-9]/g, '') === normalizedAbility
    );

    return {
      ...mon,
      revealedAbility: ability,
      possibleSets: renormalize(filtered.length > 0 ? filtered : mon.possibleSets),
    };
  });
}

/**
 * Get the most likely moves the opponent could use.
 * Returns moves weighted by probability across all possible sets.
 */
export function getLikelyMoves(model: OpponentModel, species: string): Array<{ move: string; probability: number }> {
  const mon = model.pokemon.find(p => p.species === species);
  if (!mon) return [];

  const moveProbs = new Map<string, number>();

  for (const ws of mon.possibleSets) {
    for (const move of ws.set.moves) {
      const current = moveProbs.get(move) || 0;
      // Each move in a 4-move set has 1/4 chance of being chosen (uniform)
      moveProbs.set(move, current + ws.probability / ws.set.moves.length);
    }
  }

  return Array.from(moveProbs.entries())
    .map(([move, probability]) => ({ move, probability }))
    .sort((a, b) => b.probability - a.probability);
}

// ─── Helpers ────────────────────────────────────────────────────

function updatePokemon(
  model: OpponentModel,
  species: string,
  updater: (mon: OpponentPokemonModel) => OpponentPokemonModel,
): OpponentModel {
  return {
    ...model,
    pokemon: model.pokemon.map(p => p.species === species ? updater(p) : p),
  };
}

function renormalize(sets: WeightedSet[]): WeightedSet[] {
  if (sets.length === 0) return [];
  const total = sets.reduce((sum, ws) => sum + ws.probability, 0);
  if (total === 0) return sets;
  return sets.map(ws => ({ ...ws, probability: ws.probability / total }));
}
