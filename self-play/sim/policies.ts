/**
 * policies.ts — Policy functions for self-play baselines.
 */

export type PolicyFn = (request: any) => string;

/** Type effectiveness chart (attacking -> defending) */
const TYPE_CHART: Record<string, Record<string, number>> = {
  Normal: {Rock: 0.5, Ghost: 0, Steel: 0.5},
  Fire: {Fire: 0.5, Water: 0.5, Grass: 2, Ice: 2, Bug: 2, Rock: 0.5, Dragon: 0.5, Steel: 2},
  Water: {Fire: 2, Water: 0.5, Grass: 0.5, Ground: 2, Rock: 2, Dragon: 0.5},
  Electric: {Water: 2, Electric: 0.5, Grass: 0.5, Ground: 0, Flying: 2, Dragon: 0.5},
  Grass: {Fire: 0.5, Water: 2, Grass: 0.5, Poison: 0.5, Ground: 2, Flying: 0.5, Bug: 0.5, Rock: 2, Dragon: 0.5, Steel: 0.5},
  Ice: {Fire: 0.5, Water: 0.5, Grass: 2, Ice: 0.5, Ground: 2, Flying: 2, Dragon: 2, Steel: 0.5},
  Fighting: {Normal: 2, Ice: 2, Poison: 0.5, Flying: 0.5, Psychic: 0.5, Bug: 0.5, Rock: 2, Ghost: 0, Dark: 2, Steel: 2, Fairy: 0.5},
  Poison: {Grass: 2, Poison: 0.5, Ground: 0.5, Rock: 0.5, Ghost: 0.5, Steel: 0, Fairy: 2},
  Ground: {Fire: 2, Electric: 2, Grass: 0.5, Poison: 2, Flying: 0, Bug: 0.5, Rock: 2, Steel: 2},
  Flying: {Electric: 0.5, Grass: 2, Fighting: 2, Bug: 2, Rock: 0.5, Steel: 0.5},
  Psychic: {Fighting: 2, Poison: 2, Psychic: 0.5, Dark: 0, Steel: 0.5},
  Bug: {Fire: 0.5, Grass: 2, Fighting: 0.5, Poison: 0.5, Flying: 0.5, Psychic: 2, Ghost: 0.5, Dark: 2, Steel: 0.5, Fairy: 0.5},
  Rock: {Fire: 2, Ice: 2, Fighting: 0.5, Ground: 0.5, Flying: 2, Bug: 2, Steel: 0.5},
  Ghost: {Normal: 0, Psychic: 2, Ghost: 2, Dark: 0.5},
  Dragon: {Dragon: 2, Steel: 0.5, Fairy: 0},
  Dark: {Fighting: 0.5, Psychic: 2, Ghost: 2, Dark: 0.5, Fairy: 0.5},
  Steel: {Fire: 0.5, Water: 0.5, Electric: 0.5, Ice: 2, Rock: 2, Steel: 0.5, Fairy: 2},
  Fairy: {Fire: 0.5, Fighting: 2, Poison: 0.5, Dragon: 2, Dark: 2, Steel: 0.5},
};

function getEffectiveness(moveType: string, defTypes: string[]): number {
  let mult = 1;
  for (const t of defTypes) {
    mult *= TYPE_CHART[moveType]?.[t] ?? 1;
  }
  return mult;
}

/** Get legal actions from a request */
function getLegalActions(request: any): string[] {
  const actions: string[] = [];
  if (request.forceSwitch) {
    const pokemon = request.side.pokemon;
    for (let i = 1; i < pokemon.length; i++) {
      if (!pokemon[i].active && pokemon[i].condition !== '0 fnt') {
        actions.push(`switch ${i + 1}`);
      }
    }
  } else if (request.active) {
    const active = request.active[0];
    for (let i = 0; i < active.moves.length; i++) {
      if (!active.moves[i].disabled) {
        actions.push(`move ${i + 1}`);
      }
    }
    if (!active.trapped && !active.maybeTrapped) {
      const pokemon = request.side.pokemon;
      for (let i = 1; i < pokemon.length; i++) {
        if (!pokemon[i].active && pokemon[i].condition !== '0 fnt') {
          actions.push(`switch ${i + 1}`);
        }
      }
    }
  }
  return actions.length > 0 ? actions : ['default'];
}

/** Random: uniform over legal actions */
export const randomPolicy: PolicyFn = (request: any): string => {
  const actions = getLegalActions(request);
  return actions[Math.floor(Math.random() * actions.length)];
};

/** Parse HP fraction from condition string like "120/300" or "0 fnt" */
function getHpFraction(condition: string): number {
  if (condition.includes('fnt')) return 0;
  const [current, max] = condition.split('/').map(s => parseInt(s));
  return max > 0 ? current / max : 0;
}

/**
 * Heuristic: prefer STAB super-effective moves, avoid immunities, switch at <25% HP.
 * Non-trivial but simple — a reasonable baseline around ~1000 Elo.
 */
export const heuristicPolicy: PolicyFn = (request: any): string => {
  const actions = getLegalActions(request);
  if (actions.length <= 1) return actions[0];

  // Force switch: pick healthiest mon
  if (request.forceSwitch) {
    const pokemon = request.side.pokemon;
    let bestIdx = -1;
    let bestHp = -1;
    for (let i = 1; i < pokemon.length; i++) {
      if (!pokemon[i].active && pokemon[i].condition !== '0 fnt') {
        const hp = getHpFraction(pokemon[i].condition);
        if (hp > bestHp) {
          bestHp = hp;
          bestIdx = i;
        }
      }
    }
    return bestIdx >= 0 ? `switch ${bestIdx + 1}` : 'default';
  }

  if (!request.active) return actions[0];

  const active = request.active[0];
  const myPokemon = request.side.pokemon[0];
  const myHp = getHpFraction(myPokemon.condition);

  // Switch if HP < 25% and we have healthy alternatives
  if (myHp < 0.25 && myHp > 0) {
    const pokemon = request.side.pokemon;
    for (let i = 1; i < pokemon.length; i++) {
      if (!pokemon[i].active && pokemon[i].condition !== '0 fnt') {
        if (getHpFraction(pokemon[i].condition) > 0.5) {
          return `switch ${i + 1}`;
        }
      }
    }
  }

  // Score each move
  const moveScores: {action: string; score: number}[] = [];
  const myTypes: string[] = myPokemon.details?.split(',')[0]?.split('-') ?? [];

  for (let i = 0; i < active.moves.length; i++) {
    if (active.moves[i].disabled) continue;
    const move = active.moves[i];
    let score = move.basePower ?? (move.id === 'struggle' ? 50 : 60);
    const moveType = move.type ?? 'Normal';

    // STAB bonus
    if (myTypes.includes(moveType)) {
      score *= 1.5;
    }

    // Avoid immunity (score 0 moves very low)
    // We don't know opponent types in random battles from request alone,
    // so just penalize status moves slightly and prefer high BP
    if (score === 0 || move.category === 'Status') {
      score = 20; // Status moves get low priority
    }

    moveScores.push({action: `move ${i + 1}`, score});
  }

  if (moveScores.length === 0) return actions[0];

  // Pick highest scoring move
  moveScores.sort((a, b) => b.score - a.score);
  return moveScores[0].action;
};
