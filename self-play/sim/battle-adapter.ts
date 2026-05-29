/**
 * battle-adapter.ts — Adapts @pkmn/sim Battle to the CloneableBattle interface for ISMCTS.
 *
 * Clone approach: Battle.toJSON() + Battle.fromJSON().
 * @pkmn/sim's Battle supports full JSON serialization/deserialization, which produces
 * an independent deep copy. This is simpler and more reliable than replaying inputLog,
 * since fromJSON restores the complete internal state (PRNG, queue, effects, etc.)
 * without needing to re-execute game logic.
 */

import {Battle} from '@pkmn/sim';
import type {CloneableBattle} from '../mcts/ismcts.ts';

/** Extract legal actions from a @pkmn/sim Side's activeRequest */
function getLegalActionsFromRequest(request: unknown): string[] {
  const req = request as Record<string, unknown>;
  if (!req) return [];
  const actions: string[] = [];

  if (req.forceSwitch) {
    const side = req.side as {pokemon: Array<{active?: boolean; condition: string}>};
    for (let i = 1; i < side.pokemon.length; i++) {
      if (!side.pokemon[i].active && side.pokemon[i].condition !== '0 fnt') {
        actions.push(`switch ${i + 1}`);
      }
    }
  } else if (req.active) {
    const active = (req.active as Array<{moves: Array<{disabled?: boolean}>}>)[0];
    for (let i = 0; i < active.moves.length; i++) {
      if (!active.moves[i].disabled) {
        actions.push(`move ${i + 1}`);
      }
    }
    if (!(req as {trapped?: boolean}).trapped) {
      const side = req.side as {pokemon: Array<{active?: boolean; condition: string}>};
      for (let i = 1; i < side.pokemon.length; i++) {
        if (!side.pokemon[i].active && side.pokemon[i].condition !== '0 fnt') {
          actions.push(`switch ${i + 1}`);
        }
      }
    }
  }

  return actions.length > 0 ? actions : ['default'];
}

/**
 * Wraps a @pkmn/sim Battle for use with ISMCTS.
 * The `perspective` field indicates whose turn it is to act.
 */
export class BattleAdapter implements CloneableBattle {
  readonly battle: Battle;
  readonly perspective: 'p1' | 'p2';

  constructor(battle: Battle, perspective: 'p1' | 'p2') {
    this.battle = battle;
    this.perspective = perspective;
  }

  clone(): CloneableBattle {
    const json = this.battle.toJSON();
    const cloned = Battle.fromJSON(JSON.stringify(json));
    return new BattleAdapter(cloned, this.perspective);
  }

  getLegalActions(): string[] {
    const side = this.perspective === 'p1' ? this.battle.p1 : this.battle.p2;
    return getLegalActionsFromRequest(side.activeRequest);
  }

  applyAction(action: string): void {
    // Apply the chosen action for the perspective player.
    // The opponent plays a random legal action if they also need to choose.
    // @pkmn/sim requires both sides to submit choices before a turn advances.
    const oppSide: 'p1' | 'p2' = this.perspective === 'p1' ? 'p2' : 'p1';
    const oppRequest = this.battle[oppSide].activeRequest;

    this.battle.choose(this.perspective, action);

    // If opponent has a pending request that isn't wait, choose for them
    if (oppRequest && !(oppRequest as {wait?: boolean}).wait) {
      if ((oppRequest as {teamPreview?: boolean}).teamPreview) {
        this.battle.choose(oppSide, 'default');
      } else {
        const oppActions = getLegalActionsFromRequest(oppRequest);
        const oppAction = oppActions[Math.floor(Math.random() * oppActions.length)];
        this.battle.choose(oppSide, oppAction);
      }
    }
  }

  isTerminal(): boolean {
    return this.battle.ended;
  }

  getWinner(): 'p1' | 'p2' | null {
    if (!this.battle.ended) return null;
    if (this.battle.winner === this.battle.p1.name) return 'p1';
    if (this.battle.winner === this.battle.p2.name) return 'p2';
    return null;
  }

  getState(): unknown {
    return this.battle;
  }
}
