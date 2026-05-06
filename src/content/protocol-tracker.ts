/**
 * Protocol tracking — parses PS protocol lines to update opponent model.
 * Extracted from bridge.ts for modularity.
 */

import type { OpponentModel } from '../types';
import {
  revealPokemon,
  revealMove,
  revealItem,
  revealAbility,
} from '../eval/opponent-model';
import { isLoaded } from '../state/sets-db';
import { getModel, roomModels } from './battle-session';

/** Per-room opponent side prefix (e.g., 'p2' if we are p1) */
export const roomOpponentPrefix = new Map<string, string>();

/** Buffered protocol messages received before DB was ready */
const protocolBuffer: Array<{ roomId: string; raw: string }> = [];

/** Map of ident (e.g. "p2a: Garchomp") to species name, tracked from switch messages */
const identToSpecies = new Map<string, string>();

export function extractSpeciesFromIdent(ident: string, roomId: string): string | null {
  // Ident format: "p2a: Nickname" — the nickname may differ from species
  // We rely on the identToSpecies map populated by switch events
  if (identToSpecies.has(ident)) return identToSpecies.get(ident)!;
  // Fallback: extract from ident using the dynamic opponent prefix
  const oppPrefix = roomOpponentPrefix.get(roomId);
  if (!oppPrefix) return null;
  const match = ident.match(new RegExp(`${oppPrefix}[a-z]: (.+)`));
  return match?.[1] || null;
}

/** Track species from switch events for ident resolution */
export function trackSwitch(raw: string, roomId: string): void {
  const oppPrefix = roomOpponentPrefix.get(roomId);
  if (!oppPrefix) return; // Can't track until we know which side is ours
  const lines = raw.split('\n');
  for (const line of lines) {
    const parts = line.split('|');
    if (parts.length < 4) continue;
    if (parts[1] !== 'switch' && parts[1] !== 'drag') continue;
    const ident = parts[2] || '';
    if (!ident.startsWith(oppPrefix)) continue;
    const details = parts[3] || '';
    const species = details.split(',')[0];
    if (species) identToSpecies.set(ident, species);
  }
}

/**
 * Parse raw protocol lines to track opponent reveals.
 * Protocol format: |type|args...
 * If DB isn't loaded yet, buffers lines for replay.
 */
export function trackProtocol(roomId: string, raw: string): void {
  if (!isLoaded()) {
    protocolBuffer.push({ roomId, raw });
    return;
  }
  trackProtocolInner(roomId, raw);
}

export function trackProtocolInner(roomId: string, raw: string): void {
  const oppPrefix = roomOpponentPrefix.get(roomId);
  if (!oppPrefix) return; // Can't track until we know which side is ours
  const lines = raw.split('\n');
  for (const line of lines) {
    const parts = line.split('|');
    if (parts.length < 3) continue;

    const type = parts[1];
    // Pokemon ident format: "p1a: Nickname" or "p2a: Nickname"
    // We track opponent reveals
    const ident = parts[2] || '';
    const isOpponent = ident.startsWith(oppPrefix);

    if (!isOpponent) continue;

    switch (type) {
      case 'switch':
      case 'drag': {
        // |switch|p2a: Garchomp|Garchomp, L74, M|100/100
        const details = parts[3] || '';
        const species = details.split(',')[0];
        if (species) {
          let model = getModel(roomId);
          model = revealPokemon(model, species);
          roomModels.set(roomId, model);
        }
        break;
      }
      case 'move': {
        // |move|p2a: Garchomp|Earthquake|p1a: Pikachu
        const move = parts[3] || '';
        const species = extractSpeciesFromIdent(ident, roomId);
        if (species && move) {
          let model = getModel(roomId);
          model = revealMove(model, species, move);
          roomModels.set(roomId, model);
        }
        break;
      }
      case '-item':
      case '-enditem': {
        // |-item|p2a: Garchomp|Rocky Helmet
        const item = parts[3] || '';
        const species = extractSpeciesFromIdent(ident, roomId);
        if (species && item) {
          let model = getModel(roomId);
          model = revealItem(model, species, item);
          roomModels.set(roomId, model);
        }
        break;
      }
      case '-ability': {
        // |-ability|p2a: Garchomp|Rough Skin
        const ability = parts[3] || '';
        const species = extractSpeciesFromIdent(ident, roomId);
        if (species && ability) {
          let model = getModel(roomId);
          model = revealAbility(model, species, ability);
          roomModels.set(roomId, model);
        }
        break;
      }
      case 'teamsize': {
        // |teamsize|p2|6
        if (parts[2] === oppPrefix) {
          const size = parseInt(parts[3] || '6', 10);
          const model = getModel(roomId);
          model.unrevealed = size;
          roomModels.set(roomId, model);
        }
        break;
      }
    }
  }
}

/** Replay all buffered protocol lines (called after DB loads) */
export function replayBufferedProtocol(): void {
  for (const { roomId, raw } of protocolBuffer) {
    trackProtocolInner(roomId, raw);
  }
  protocolBuffer.length = 0;
}
