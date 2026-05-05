/**
 * Turn logging system — captures per-turn state + bot recommendations
 * for post-battle review and accuracy analysis.
 */

import type { BattleSnapshot, ScoredOption } from '../types';

export interface TurnOutcome {
  moveUsed: string;
  damageDealt?: number;
  ko?: boolean;
}

export interface OpponentModelSnapshot {
  species: string;
  remainingSetCount: number;
  topSetProbability: number;
  revealedMoves: string[];
  revealedAbility: string | null;
  revealedItem: string | null;
}

export interface TurnLog {
  turn: number;
  timestamp: number;
  snapshot: BattleSnapshot;
  recommendations: ScoredOption[];
  actualOutcome?: TurnOutcome;
  opponentModelState?: OpponentModelSnapshot[];
}

export interface BattleLog {
  battleId: string;
  format: string;
  startTime: number;
  turns: TurnLog[];
}

export class TurnLogger {
  private log: BattleLog | null = null;

  startBattle(battleId: string, format: string): void {
    this.log = {
      battleId,
      format,
      startTime: Date.now(),
      turns: [],
    };
  }

  logTurn(turn: number, snapshot: BattleSnapshot, recommendations: ScoredOption[], opponentModelState?: OpponentModelSnapshot[]): void {
    if (!this.log) return;
    // Replace existing entry for same turn (in case of re-eval)
    const idx = this.log.turns.findIndex((t) => t.turn === turn);
    const entry: TurnLog = {
      turn,
      timestamp: Date.now(),
      snapshot,
      recommendations,
      opponentModelState,
    };
    if (idx >= 0) {
      entry.actualOutcome = this.log.turns[idx].actualOutcome;
      this.log.turns[idx] = entry;
    } else {
      this.log.turns.push(entry);
    }
  }

  recordOutcome(turn: number, outcome: TurnOutcome): void {
    if (!this.log) return;
    const entry = this.log.turns.find((t) => t.turn === turn);
    if (entry) {
      entry.actualOutcome = outcome;
    }
  }

  export(): BattleLog | null {
    return this.log;
  }

  toJSON(): string {
    return JSON.stringify(this.log, null, 2);
  }

  get active(): boolean {
    return this.log !== null;
  }

  get battleId(): string {
    return this.log?.battleId ?? '';
  }
}
