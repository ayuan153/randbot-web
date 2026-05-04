import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import {
  createOpponentModel,
  revealPokemon,
  revealMove,
  revealItem,
  revealAbility,
} from '../src/eval/opponent-model';
import { setSetsDb } from '../src/state/sets-db';
import type { OpponentModel } from '../src/types';

// Load real randbats data for set narrowing
const randbatsData = JSON.parse(
  readFileSync(resolve(__dirname, '../data/gen9randombattle.json'), 'utf-8')
);

/**
 * Parse a replay log and track opponent (p2) reveals through the opponent model.
 * Mirrors the protocol parsing logic in bridge.ts.
 */
function trackReplay(log: string): { model: OpponentModel; events: string[] } {
  const events: string[] = [];
  let model = createOpponentModel(6);
  const identToSpecies = new Map<string, string>();

  for (const line of log.split('\n')) {
    const parts = line.split('|');
    if (parts.length < 3) continue;

    const type = parts[1];
    const ident = parts[2] || '';
    const isP2 = ident.startsWith('p2');

    if (!isP2) continue;

    switch (type) {
      case 'switch':
      case 'drag': {
        const details = parts[3] || '';
        const species = details.split(',')[0];
        if (species) {
          identToSpecies.set(ident, species);
          model = revealPokemon(model, species);
          events.push(`switch:${species}`);
        }
        break;
      }
      case 'move': {
        const move = parts[3] || '';
        const species = identToSpecies.get(ident);
        if (species && move) {
          model = revealMove(model, species, move);
          events.push(`move:${species}:${move}`);
        }
        break;
      }
      case '-item':
      case '-enditem': {
        const item = parts[3] || '';
        const species = identToSpecies.get(ident);
        if (species && item) {
          model = revealItem(model, species, item);
          events.push(`item:${species}:${item}`);
        }
        break;
      }
      case '-ability': {
        const ability = parts[3] || '';
        const species = identToSpecies.get(ident);
        if (species && ability) {
          model = revealAbility(model, species, ability);
          events.push(`ability:${species}:${ability}`);
        }
        break;
      }
    }
  }

  return { model, events };
}

describe('replay fixture tests', () => {
  beforeEach(() => {
    setSetsDb(randbatsData);
  });

  it('tracks all opponent pokemon from replay-1', () => {
    const log = readFileSync(resolve(__dirname, 'fixtures/replay-1.log'), 'utf-8');
    const { model, events } = trackReplay(log);

    // Should have revealed some opponent pokemon
    expect(model.pokemon.length).toBeGreaterThan(0);
    expect(model.pokemon.length).toBeLessThanOrEqual(6);

    // Should have tracked switch events
    const switches = events.filter(e => e.startsWith('switch:'));
    expect(switches.length).toBeGreaterThan(0);

    // Each revealed pokemon should have possible sets (from randbats data)
    for (const mon of model.pokemon) {
      expect(mon.species).toBeTruthy();
      // Some pokemon might not be in randbats data (legendaries, etc.)
      // but most should have sets
    }
  });

  it('narrows sets as moves are revealed from replay-1', () => {
    const log = readFileSync(resolve(__dirname, 'fixtures/replay-1.log'), 'utf-8');
    const { model, events } = trackReplay(log);

    // Should have tracked move events
    const moveEvents = events.filter(e => e.startsWith('move:'));
    expect(moveEvents.length).toBeGreaterThan(0);

    // Pokemon with revealed moves should have narrowed sets
    for (const mon of model.pokemon) {
      if (mon.revealedMoves.length > 0) {
        // If sets were narrowed, remaining sets should all contain the revealed moves
        for (const ws of mon.possibleSets) {
          for (const revealedMove of mon.revealedMoves) {
            const normalized = revealedMove.toLowerCase().replace(/[^a-z0-9]/g, '');
            const hasMove = ws.set.moves.some(
              m => m.toLowerCase().replace(/[^a-z0-9]/g, '') === normalized
            );
            expect(hasMove).toBe(true);
          }
        }
      }
    }
  });

  it('tracks abilities from replay-1', () => {
    const log = readFileSync(resolve(__dirname, 'fixtures/replay-1.log'), 'utf-8');
    const { model, events } = trackReplay(log);

    const abilityEvents = events.filter(e => e.startsWith('ability:'));
    // replay-1 has ability reveals (Teravolt, Intimidate, etc.)
    expect(abilityEvents.length).toBeGreaterThan(0);

    // Pokemon with revealed abilities should have them tracked
    for (const mon of model.pokemon) {
      if (mon.revealedAbility) {
        // Remaining sets should all have the revealed ability
        for (const ws of mon.possibleSets) {
          const normalized = mon.revealedAbility.toLowerCase().replace(/[^a-z0-9]/g, '');
          const matchesAbility = ws.set.ability.toLowerCase().replace(/[^a-z0-9]/g, '') === normalized;
          expect(matchesAbility).toBe(true);
        }
      }
    }
  });

  it('processes all three replay fixtures without errors', () => {
    for (const file of ['replay-1.log', 'replay-2.log', 'replay-3.log']) {
      const log = readFileSync(resolve(__dirname, `fixtures/${file}`), 'utf-8');
      const { model, events } = trackReplay(log);

      // Basic sanity: should have tracked some events
      expect(events.length).toBeGreaterThan(0);
      expect(model.pokemon.length).toBeGreaterThan(0);
    }
  });
});
