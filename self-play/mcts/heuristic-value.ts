/** Heuristic value: HP fraction ratio, 0..1 from p1's perspective. */
import type {ValueFn} from './ismcts.ts';
import type {Battle} from '@pkmn/sim';

export const heuristicValue: ValueFn = (state: unknown): number => {
  const battle = state as Battle;
  let p1Total = 0;
  let p2Total = 0;
  for (const mon of battle.p1.pokemon) {
    p1Total += mon.maxhp > 0 ? mon.hp / mon.maxhp : 0;
  }
  for (const mon of battle.p2.pokemon) {
    p2Total += mon.maxhp > 0 ? mon.hp / mon.maxhp : 0;
  }
  const denom = p1Total + p2Total;
  if (denom === 0) return 0.5;
  return Math.min(0.99, Math.max(0.01, p1Total / denom));
};
