/**
 * Snapshot extraction logic.
 * This module provides typed helpers for extracting BattleSnapshot.
 * The actual extraction in hook.ts is inlined (page world can't import),
 * but this module is used for testing and type validation.
 */

import type { BattleSnapshot, PokemonState, SideFieldState, Action } from '../types';
import { getSetsForSpecies } from './sets-db';

/** Parse PS condition string like "267/300 brn" or "0 fnt" */
export function parseCondition(cond: string): { hp: number; hpMax: number; status: string | null } {
  if (!cond || cond === '0 fnt') return { hp: 0, hpMax: 0, status: 'fnt' };
  const parts = cond.split(' ');
  const hpParts = parts[0].split('/');
  return {
    hp: parseInt(hpParts[0], 10),
    hpMax: parseInt(hpParts[1], 10) || 100,
    status: parts[1] || null,
  };
}

/** Parse details string like "Pikachu, L84, M" */
export function parseDetails(details: string): { species: string; level: number } {
  const parts = details.split(', ');
  const species = parts[0];
  let level = 100;
  for (const p of parts) {
    if (p.startsWith('L')) level = parseInt(p.slice(1), 10);
  }
  return { species, level };
}

/** Extract side field conditions from PS sideConditions object */
export function extractSideField(sideConditions: Record<string, unknown[]>): SideFieldState {
  return {
    spikes: (sideConditions['spikes']?.[1] as number) ?? 0,
    stealthRock: 'stealthrock' in sideConditions,
    toxicSpikes: (sideConditions['toxicspikes']?.[1] as number) ?? 0,
    stickyWeb: 'stickyweb' in sideConditions,
    reflect: (sideConditions['reflect']?.[1] as number) ?? 0,
    lightScreen: (sideConditions['lightscreen']?.[1] as number) ?? 0,
    auroraVeil: (sideConditions['auroraveil']?.[1] as number) ?? 0,
    tailwind: (sideConditions['tailwind']?.[1] as number) ?? 0,
  };
}

/** Extract PokemonState from a PS battle pokemon object */
export function extractPokemonState(mon: {
  speciesForme?: string;
  species?: string;
  level?: number;
  hp?: number;
  maxhp?: number;
  status?: string;
  boosts?: Record<string, number>;
  moveTrack?: Array<string | string[]>;
  item?: string;
  ability?: string;
  teraType?: string;
  terastallized?: boolean;
} | null): PokemonState {
  if (!mon) {
    return {
      species: 'unknown', level: 100, hp: 0, hpMax: 0,
      status: 'fnt', boosts: {}, moves: [],
      item: null, ability: null, teraType: null, terastallized: false,
    };
  }
  return {
    species: mon.speciesForme || mon.species || 'unknown',
    level: mon.level ?? 100,
    hp: mon.hp ?? 0,
    hpMax: mon.maxhp ?? 100,
    status: mon.status || null,
    boosts: mon.boosts ? { ...mon.boosts } : {},
    moves: (mon.moveTrack || []).map((m) => (Array.isArray(m) ? m[0] : m)),
    item: mon.item || null,
    ability: mon.ability || null,
    teraType: mon.teraType || null,
    terastallized: mon.terastallized || false,
  };
}

/** Build available actions from a PS request object */
export function extractActions(request: {
  active?: Array<{ moves?: Array<{ id: string; move: string; pp: number; maxpp: number; target?: string; disabled?: boolean }> }>;
  side?: { pokemon?: Array<{ active?: boolean; condition?: string; details: string }> };
}): Action[] {
  const actions: Action[] = [];

  if (request.active?.[0]?.moves) {
    for (const m of request.active[0].moves) {
      if (m.disabled) continue;
      actions.push({
        type: 'move',
        id: m.id,
        name: m.move,
        pp: m.pp,
        maxPp: m.maxpp,
        target: m.target || 'normal',
        disabled: false,
      });
    }
  }

  if (request.side?.pokemon) {
    request.side.pokemon.forEach((p, i) => {
      if (p.active || p.condition === '0 fnt' || p.condition?.startsWith('0')) return;
      const { species } = parseDetails(p.details);
      actions.push({ type: 'switch', species, slot: i + 1 });
    });
  }

  return actions;
}

/** Derive format string from roomId */
export function deriveFormat(roomId: string): string {
  const match = roomId.match(/battle-([a-z0-9]+)-/);
  return match?.[1] || 'gen9randombattle';
}

/**
 * Infer EVs/IVs/nature for a player's Pokemon by matching against randbats set data.
 * Uses known moves/ability/item to narrow to the best-matching set.
 */
function inferSetData(species: string, moves: string[], ability: string | null, item: string | null): { evs?: Record<string, number>; ivs?: Record<string, number>; nature?: string } {
  const sets = getSetsForSpecies(species);
  if (sets.length === 0) return {};

  const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

  // Score each set by how many known attributes match
  let bestSet = sets[0];
  let bestScore = -1;

  for (const set of sets) {
    let score = 0;
    if (ability && normalize(set.ability) === normalize(ability)) score += 2;
    if (item && normalize(set.item) === normalize(item)) score += 2;
    for (const move of moves) {
      if (set.moves.some(m => normalize(m) === normalize(move))) score += 1;
    }
    if (score > bestScore) {
      bestScore = score;
      bestSet = set;
    }
  }

  return {
    evs: Object.keys(bestSet.evs).length > 0 ? bestSet.evs : undefined,
    ivs: Object.keys(bestSet.ivs).length > 0 ? bestSet.ivs : undefined,
    nature: bestSet.nature || undefined,
  };
}

/**
 * Extract a full BattleSnapshot from PS page objects.
 * This is the reference implementation — hook.ts inlines equivalent logic.
 */
export function extractSnapshot(
  roomId: string,
  battle: {
    turn?: number;
    weather?: string;
    weatherTimeLeft?: number;
    terrain?: string;
    terrainTimeLeft?: number;
    mySide?: { active?: unknown[]; pokemon?: unknown[]; sideConditions?: Record<string, unknown[]> };
    nearSide?: { active?: unknown[]; pokemon?: unknown[]; sideConditions?: Record<string, unknown[]> };
    farSide?: { active?: unknown[]; pokemon?: unknown[]; sideConditions?: Record<string, unknown[]> };
  },
  request: {
    active?: Array<{ moves?: Array<{ id: string; move: string; pp: number; maxpp: number; target?: string; disabled?: boolean }> }>;
    side?: { pokemon?: Array<{ active?: boolean; condition?: string; details: string; moves?: string[]; item?: string; ability?: string; baseAbility?: string; stats?: Record<string, number> }> };
  },
): BattleSnapshot | null {
  const mySide = battle.mySide || battle.nearSide;
  const oppSide = battle.farSide;
  if (!mySide || !oppSide) return null;

  let myActive = extractPokemonState(mySide.active?.[0] as Parameters<typeof extractPokemonState>[0]);
  const oppActive = extractPokemonState(oppSide.active?.[0] as Parameters<typeof extractPokemonState>[0]);

  // Fallback: if active mon is not populated from battle state, use request.side.pokemon
  const activeReqMon = request.side?.pokemon?.find(p => p.active);
  if ((myActive.species === 'unknown' || myActive.hp === 0) && activeReqMon) {
    const { species, level } = parseDetails(activeReqMon.details);
    const { hp, hpMax, status } = parseCondition(activeReqMon.condition || '');
    const setData = inferSetData(species, activeReqMon.moves || [], activeReqMon.ability || activeReqMon.baseAbility || null, activeReqMon.item || null);
    myActive = {
      species, level, hp, hpMax, status,
      boosts: {},
      moves: activeReqMon.moves || [],
      item: activeReqMon.item || null,
      ability: activeReqMon.ability || activeReqMon.baseAbility || null,
      teraType: null,
      terastallized: false,
      stats: activeReqMon.stats ? { ...activeReqMon.stats } : undefined,
      evs: setData.evs,
      ivs: setData.ivs,
      nature: setData.nature,
    };
  }

  // Enrich active ability/item from request (request is source of truth for player's own mons)
  if (activeReqMon) {
    if (!myActive.ability) {
      myActive.ability = activeReqMon.ability || activeReqMon.baseAbility || null;
    }
    if (!myActive.item) {
      myActive.item = activeReqMon.item || null;
    }
  }

  // Enrich active moves from request
  if (request.active?.[0]?.moves) {
    myActive.moves = request.active[0].moves.map(m => m.move || m.id);
  }

  // Enrich active stats from request (player's active is first in request.side.pokemon)
  if (activeReqMon?.stats && !myActive.stats) {
    myActive.stats = { ...activeReqMon.stats };
  }

  // Enrich active EVs/IVs/nature from randbats data if not already set
  if (!myActive.evs) {
    const setData = inferSetData(myActive.species, myActive.moves, myActive.ability, myActive.item);
    myActive.evs = setData.evs;
    myActive.ivs = setData.ivs;
    myActive.nature = setData.nature;
  }

  // Bench from request (our team, full info)
  const myBench: PokemonState[] = (request.side?.pokemon || [])
    .filter(p => !p.active && !p.condition?.startsWith('0'))
    .map(p => {
      const { species, level } = parseDetails(p.details);
      const { hp, hpMax, status } = parseCondition(p.condition || '');
      const setData = inferSetData(species, p.moves || [], p.ability || p.baseAbility || null, p.item || null);
      return {
        species, level, hp, hpMax, status,
        boosts: {},
        moves: p.moves || [],
        item: p.item || null,
        ability: p.ability || p.baseAbility || null,
        teraType: null,
        terastallized: false,
        stats: p.stats ? { ...p.stats } : undefined,
        evs: setData.evs,
        ivs: setData.ivs,
        nature: setData.nature,
      };
    });

  // Opponent bench (only revealed)
  const oppBench: PokemonState[] = ((oppSide.pokemon || []) as Array<Parameters<typeof extractPokemonState>[0]>)
    .filter(p => p && p !== (oppSide.active?.[0] as unknown) && (p?.hp ?? 0) > 0)
    .map(p => extractPokemonState(p));

  const field = {
    weather: battle.weather || null,
    weatherTurns: battle.weatherTimeLeft ?? 0,
    terrain: battle.terrain || null,
    terrainTurns: battle.terrainTimeLeft ?? 0,
    playerSide: extractSideField((mySide.sideConditions || {}) as Record<string, unknown[]>),
    opponentSide: extractSideField((oppSide.sideConditions || {}) as Record<string, unknown[]>),
  };

  return {
    roomId,
    turn: battle.turn || 0,
    format: deriveFormat(roomId),
    player: { active: myActive, bench: myBench },
    opponent: { active: oppActive, bench: oppBench },
    field,
    availableActions: extractActions(request),
  };
}
