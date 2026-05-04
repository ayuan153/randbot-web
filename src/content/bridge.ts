/**
 * Content script (ISOLATED world).
 * Injects hook.ts into page, relays messages, tracks opponent model, mounts overlay UI.
 */

import type { EvalResult, OpponentModel } from '../types';
import {
  createOpponentModel,
  revealPokemon,
  revealMove,
  revealItem,
  revealAbility,
} from '../eval/opponent-model';
import { mountOverlay } from '../ui/overlay';

const HOOK_SOURCE = 'randbats-bot-hook';

const DEFAULT_CONFIG = {
  depth: 2,
  topN: 5,
  timeLimitMs: 2000,
  evalMode: 'heuristic' as const,
};

/** Per-room opponent model state */
const roomModels = new Map<string, OpponentModel>();

function getModel(roomId: string): OpponentModel {
  if (!roomModels.has(roomId)) {
    roomModels.set(roomId, createOpponentModel(6));
  }
  return roomModels.get(roomId)!;
}

/**
 * Parse raw protocol lines to track opponent reveals.
 * Protocol format: |type|args...
 */
function trackProtocol(roomId: string, raw: string) {
  const lines = raw.split('\n');
  for (const line of lines) {
    const parts = line.split('|');
    if (parts.length < 3) continue;

    const type = parts[1];
    // Pokemon ident format: "p1a: Nickname" or "p2a: Nickname"
    // We track p2 (opponent) reveals
    const ident = parts[2] || '';
    const isOpponent = ident.startsWith('p2');

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
        if (parts[2] === 'p2') {
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

/** Map of ident (e.g. "p2a: Garchomp") to species name, tracked from switch messages */
const identToSpecies = new Map<string, string>();

function extractSpeciesFromIdent(ident: string, _roomId: string): string | null {
  // Ident format: "p2a: Nickname" — the nickname may differ from species
  // We rely on the identToSpecies map populated by switch events
  if (identToSpecies.has(ident)) return identToSpecies.get(ident)!;
  // Fallback: extract from ident (works when nickname = species)
  const match = ident.match(/p2[a-z]: (.+)/);
  return match?.[1] || null;
}

/** Track species from switch events for ident resolution */
function trackSwitch(raw: string) {
  const lines = raw.split('\n');
  for (const line of lines) {
    const parts = line.split('|');
    if (parts.length < 4) continue;
    if (parts[1] !== 'switch' && parts[1] !== 'drag') continue;
    const ident = parts[2] || '';
    if (!ident.startsWith('p2')) continue;
    const details = parts[3] || '';
    const species = details.split(',')[0];
    if (species) identToSpecies.set(ident, species);
  }
}

// ─── Boot ───────────────────────────────────────────────────────

function injectHook() {
  const script = document.createElement('script');
  script.src = chrome.runtime.getURL('src/inject/hook.ts');
  script.type = 'module';
  (document.head || document.documentElement).appendChild(script);
  script.onload = () => script.remove();
}

function handleResult(result: EvalResult, updateOverlay: ReturnType<typeof mountOverlay>) {
  updateOverlay(result.options, result.turn, result.elapsedMs);
}

function listenForHookMessages(updateOverlay: ReturnType<typeof mountOverlay>) {
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    if (event.data?.source !== HOOK_SOURCE) return;

    const msg = event.data;

    if (msg.type === 'PS_PROTOCOL_MSG') {
      trackSwitch(msg.raw);
      trackProtocol(msg.roomId, msg.raw);
    }

    if (msg.type === 'PS_TURN_REQUEST') {
      const roomId = msg.snapshot.roomId;
      const model = getModel(roomId);

      const evalRequest = {
        type: 'EVAL_REQUEST' as const,
        payload: {
          snapshot: msg.snapshot,
          opponentModel: model,
          config: DEFAULT_CONFIG,
        },
      };

      chrome.runtime.sendMessage(evalRequest, (response) => {
        if (response?.type === 'EVAL_RESULT') {
          handleResult(response.payload, updateOverlay);
        }
      });
    }
  });
}

function listenForSwMessages(updateOverlay: ReturnType<typeof mountOverlay>) {
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'EVAL_RESULT') {
      handleResult(msg.payload, updateOverlay);
    }
  });
}

injectHook();
const updateOverlay = mountOverlay();
listenForHookMessages(updateOverlay);
listenForSwMessages(updateOverlay);
console.log('[randbats-bot] Content script loaded');
