/**
 * Battle session management — opponent model, turn processing, outcome tracking, logging.
 * Extracted from bridge.ts for modularity.
 */

import type { BattleSnapshot, EvalResult, OpponentModel } from '../types';
import { createOpponentModel } from '../eval/opponent-model';
import { mountOverlay } from '../ui/overlay';
import { TurnLogger, OpponentModelSnapshot } from '../logging/turn-logger';
import { roomOpponentPrefix } from './protocol-tracker';

const DEFAULT_CONFIG = {
  depth: 2,
  topN: 5,
  timeLimitMs: 2000,
  evalMode: 'heuristic' as const,
};

/** Per-room opponent model state */
export const roomModels = new Map<string, OpponentModel>();

/** Turn logger instance */
const turnLogger = new TurnLogger();

/** Previous snapshot for outcome tracking */
let prevSnapshot: BattleSnapshot | null = null;

/** Buffered turn requests received before DB was ready */
const pendingTurnRequests: Array<{ snapshot: BattleSnapshot; roomId: string }> = [];

/** Protocol lines accumulated since last turn, keyed by roomId */
const protocolAccumulator = new Map<string, string[]>();

export function getModel(roomId: string): OpponentModel {
  if (!roomModels.has(roomId)) {
    roomModels.set(roomId, createOpponentModel(6));
  }
  return roomModels.get(roomId)!;
}

/** Accumulate protocol lines for turn logging */
export function accumulateProtocol(roomId: string, lines: string[]): void {
  const acc = protocolAccumulator.get(roomId) || [];
  acc.push(...lines);
  protocolAccumulator.set(roomId, acc);
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

export function handleResult(result: EvalResult, updateOverlay: ReturnType<typeof mountOverlay>): void {
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

export function processTurnRequest(snapshot: BattleSnapshot, updateOverlay: ReturnType<typeof mountOverlay>): void {
  const roomId = snapshot.roomId;
  const model = getModel(roomId);

  // Bug 3 fix: if opponent active is 'unknown', fill from model's most recent reveal
  // Only fill if we know which side is the opponent (prefix is set)
  if (snapshot.opponent.active.species === 'unknown' && model.pokemon.length > 0 && roomOpponentPrefix.has(roomId)) {
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

/** Replay any turn requests that were buffered before DB loaded */
export function replayPendingTurnRequests(updateOverlay: ReturnType<typeof mountOverlay>): void {
  for (const { snapshot } of pendingTurnRequests) {
    processTurnRequest(snapshot, updateOverlay);
  }
  pendingTurnRequests.length = 0;
}

/** Buffer a turn request for later processing (before DB is ready) */
export function bufferTurnRequest(snapshot: BattleSnapshot): void {
  pendingTurnRequests.push({ snapshot, roomId: snapshot.roomId });
}
