/**
 * Content script (ISOLATED world).
 * Injects hook.ts into page, relays messages, tracks opponent model, mounts overlay UI.
 */

import type { BattleSnapshot, EvalResult, OpponentModel } from '../types';
import {
  createOpponentModel,
  revealPokemon,
  revealMove,
  revealItem,
  revealAbility,
} from '../eval/opponent-model';
import { loadSetsDb, isLoaded } from '../state/sets-db';
import { mountOverlay } from '../ui/overlay';
import { TurnLogger, OpponentModelSnapshot } from '../logging/turn-logger';

const HOOK_SOURCE = 'randbats-bot-hook';

const DEFAULT_CONFIG = {
  depth: 2,
  topN: 5,
  timeLimitMs: 2000,
  evalMode: 'heuristic' as const,
};

/** Per-room opponent model state */
const roomModels = new Map<string, OpponentModel>();

/** Per-room opponent side prefix (e.g., 'p2' if we are p1) */
const roomOpponentPrefix = new Map<string, string>();

/** Turn logger instance */
const turnLogger = new TurnLogger();

/** Previous snapshot for outcome tracking */
let prevSnapshot: BattleSnapshot | null = null;

/** Promise that resolves when the sets DB is loaded */
let dbReadyResolve: () => void;
const dbReady = new Promise<void>((resolve) => { dbReadyResolve = resolve; });

/** Buffered protocol messages received before DB was ready */
const protocolBuffer: Array<{ roomId: string; raw: string }> = [];

/** Protocol lines accumulated since last turn, keyed by roomId */
const protocolAccumulator = new Map<string, string[]>();

function getModel(roomId: string): OpponentModel {
  if (!roomModels.has(roomId)) {
    roomModels.set(roomId, createOpponentModel(6));
  }
  return roomModels.get(roomId)!;
}

/** Extract a snapshot of the opponent model state for turn logging */
function getOpponentModelSnapshot(model: OpponentModel): OpponentModelSnapshot[] {
  return model.pokemon.map(p => ({
    species: p.species,
    remainingSetCount: p.possibleSets.length,
    topSetProbability: p.possibleSets.length > 0
      ? Math.max(...p.possibleSets.map(ws => ws.probability))
      : 0,
    revealedMoves: p.revealedMoves,
    revealedAbility: p.revealedAbility,
    revealedItem: p.revealedItem,
  }));
}

/**
 * Parse raw protocol lines to track opponent reveals.
 * Protocol format: |type|args...
 * If DB isn't loaded yet, buffers lines for replay.
 */
function trackProtocol(roomId: string, raw: string) {
  if (!isLoaded()) {
    protocolBuffer.push({ roomId, raw });
    return;
  }
  trackProtocolInner(roomId, raw);
}

function trackProtocolInner(roomId: string, raw: string) {
  const oppPrefix = roomOpponentPrefix.get(roomId) || 'p2';
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

/** Map of ident (e.g. "p2a: Garchomp") to species name, tracked from switch messages */
const identToSpecies = new Map<string, string>();

function extractSpeciesFromIdent(ident: string, roomId: string): string | null {
  // Ident format: "p2a: Nickname" — the nickname may differ from species
  // We rely on the identToSpecies map populated by switch events
  if (identToSpecies.has(ident)) return identToSpecies.get(ident)!;
  // Fallback: extract from ident using the dynamic opponent prefix
  const oppPrefix = roomOpponentPrefix.get(roomId) || 'p2';
  const match = ident.match(new RegExp(`${oppPrefix}[a-z]: (.+)`));
  return match?.[1] || null;
}

/** Track species from switch events for ident resolution */
function trackSwitch(raw: string, roomId: string) {
  const oppPrefix = roomOpponentPrefix.get(roomId) || 'p2';
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
 * Derive what happened last turn by comparing snapshots.
 * HP delta on opponent's active tells us damage dealt; faint = KO.
 */
function recordOutcomeFromDelta(prev: BattleSnapshot, curr: BattleSnapshot): void {
  const prevOppHp = prev.opponent.active.hp;
  const currOppActive = curr.opponent.active;
  const sameSpecies = prev.opponent.active.species === currOppActive.species;

  // Determine what move was likely used (top recommendation from that turn)
  const turnEntry = turnLogger.export()?.turns.find((t) => t.turn === prev.turn);
  const topRec = turnEntry?.recommendations[0];
  const moveUsed = topRec?.action.type === 'move' ? topRec.action.name : topRec?.action.type === 'switch' ? `switch:${topRec.action.species}` : 'unknown';

  if (sameSpecies) {
    const damageDealt = prevOppHp - currOppActive.hp;
    const ko = currOppActive.hp <= 0;
    turnLogger.recordOutcome(prev.turn, { moveUsed, damageDealt, ko });
  } else {
    // Opponent switched or fainted — record as KO if HP was low or they're gone
    const ko = prevOppHp > 0 && !curr.opponent.bench.some((p) => p.species === prev.opponent.active.species && p.hp > 0);
    turnLogger.recordOutcome(prev.turn, { moveUsed, ko });
  }
}

/** Trigger a JSON file download of the battle log */
export function downloadLog(): void {
  const log = turnLogger.export();
  if (!log) return;
  const json = turnLogger.toJSON();
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `randbats-log-${log.battleId}-${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

// ─── Boot ───────────────────────────────────────────────────────

function injectHook() {
  const script = document.createElement('script');
  script.src = chrome.runtime.getURL('inject/hook.js');
  script.type = 'module';
  (document.head || document.documentElement).appendChild(script);
  script.onload = () => script.remove();
}

function handleResult(result: EvalResult, updateOverlay: ReturnType<typeof mountOverlay>) {
  const snapshot = prevSnapshot ?? null;
  const model = snapshot ? getModel(snapshot.roomId) : null;
  updateOverlay(result.options, result.turn, result.elapsedMs, snapshot, model);
  // Log turn with the snapshot we stored, including opponent model state and protocol
  if (prevSnapshot && prevSnapshot.turn === result.turn) {
    const modelState = model ? getOpponentModelSnapshot(model) : undefined;
    const protocol = protocolAccumulator.get(prevSnapshot.roomId);
    turnLogger.logTurn(result.turn, prevSnapshot, result.options, modelState, protocol);
    // Flush protocol accumulator for this room after logging
    protocolAccumulator.set(prevSnapshot.roomId, []);
  }
}

function listenForHookMessages(updateOverlay: ReturnType<typeof mountOverlay>) {
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    if (event.data?.source !== HOOK_SOURCE) return;

    const msg = event.data;

    if (msg.type === 'PS_PROTOCOL_MSG') {
      // Accumulate protocol lines for turn logging
      const acc = protocolAccumulator.get(msg.roomId) || [];
      acc.push(...msg.raw.split('\n').filter((l: string) => l.length > 0));
      protocolAccumulator.set(msg.roomId, acc);

      // Detect which side we are from |request| JSON (contains side.id)
      if (!roomOpponentPrefix.has(msg.roomId)) {
        const reqLine = msg.raw.split('\n').find((l: string) => l.startsWith('|request|'));
        if (reqLine) {
          try {
            const reqJson = JSON.parse(reqLine.slice('|request|'.length));
            const mySideId = reqJson.side?.id;
            if (mySideId === 'p1') roomOpponentPrefix.set(msg.roomId, 'p2');
            else if (mySideId === 'p2') roomOpponentPrefix.set(msg.roomId, 'p1');
          } catch { /* ignore parse errors */ }
        }
      }
      trackSwitch(msg.raw, msg.roomId);
      trackProtocol(msg.roomId, msg.raw);
    }

    if (msg.type === 'PS_TURN_REQUEST') {
      const snapshot: BattleSnapshot = msg.snapshot;
      const roomId = snapshot.roomId;
      const model = getModel(roomId);

      // Bug 3 fix: if opponent active is 'unknown', fill from model's most recent reveal
      if (snapshot.opponent.active.species === 'unknown' && model.pokemon.length > 0) {
        // The last revealed pokemon in the model is the current active (from trackProtocol processing |switch|)
        const lastRevealed = model.pokemon[model.pokemon.length - 1];
        if (lastRevealed) {
          snapshot.opponent.active.species = lastRevealed.species;
          if (!snapshot.opponent.active.ability && lastRevealed.revealedAbility) {
            snapshot.opponent.active.ability = lastRevealed.revealedAbility;
          }
        }
      }

      // Start logging if this is a new battle
      if (!turnLogger.active || turnLogger.battleId !== roomId) {
        turnLogger.startBattle(roomId, snapshot.format);
      }

      // Record outcome for previous turn by comparing HP deltas
      if (prevSnapshot && prevSnapshot.turn < snapshot.turn) {
        recordOutcomeFromDelta(prevSnapshot, snapshot);
      }
      prevSnapshot = snapshot;

      const evalRequest = {
        type: 'EVAL_REQUEST' as const,
        payload: {
          snapshot,
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
const setsUrl = chrome.runtime.getURL('data/gen9randombattle.json');
loadSetsDb(setsUrl).then(() => {
  console.log('[randbats-bot] Sets DB loaded');
  // Replay buffered protocol lines that arrived before DB was ready
  for (const { roomId, raw } of protocolBuffer) {
    trackProtocolInner(roomId, raw);
  }
  protocolBuffer.length = 0;
  dbReadyResolve();
}).catch((err) => {
  console.error('[randbats-bot] Failed to load sets DB:', err);
});
const updateOverlay = mountOverlay(downloadLog);
listenForHookMessages(updateOverlay);
listenForSwMessages(updateOverlay);
console.log('[randbats-bot] Content script loaded');
