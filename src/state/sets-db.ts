/**
 * Randbats set database.
 * Loads set data and provides lookup by species.
 * Data sourced from https://data.pkmn.cc/randbats/gen9randombattle.json
 */

import type { RandbatsSet } from '../types';

/**
 * Raw data shape from pkmn/randbats JSON.
 * Each species has roles, each role has moves/items/abilities/evs.
 */
interface RawSpeciesData {
  level: number;
  roles: Record<string, {
    moves: string[];
    items: string[];
    abilities: string[];
    evs: Record<string, number>;
    ivs?: Record<string, number>;
    teraTypes: string[];
  }>;
}

type RawDatabase = Record<string, RawSpeciesData>;

let db: RawDatabase | null = null;

/** Load the bundled randbats data. Call once at startup. */
export async function loadSetsDb(jsonUrl: string): Promise<void> {
  const resp = await fetch(jsonUrl);
  db = await resp.json() as RawDatabase;
}

/** Set the database directly (for testing or pre-bundled data) */
export function setSetsDb(data: RawDatabase): void {
  db = data;
}

/**
 * Get all possible sets for a species.
 * Flattens roles into concrete sets (one per role × item × ability combination).
 * For efficiency, we generate one representative set per role (most common item/ability).
 */
export function getSetsForSpecies(species: string): RandbatsSet[] {
  if (!db) return [];

  // Normalize species name (PS uses lowercase no-spaces internally)
  const key = Object.keys(db).find(
    k => k.toLowerCase().replace(/[^a-z0-9]/g, '') === species.toLowerCase().replace(/[^a-z0-9]/g, '')
  );
  if (!key) return [];

  const data = db[key];
  const sets: RandbatsSet[] = [];

  for (const [, role] of Object.entries(data.roles)) {
    // Generate one set per item × ability combination for this role
    // To keep branching manageable, use top item + top ability only
    const item = role.items[0] || '';
    const ability = role.abilities[0] || '';
    const teraType = role.teraTypes?.[0];

    sets.push({
      ability,
      item,
      moves: role.moves.slice(0, 4), // first 4 moves as representative
      evs: role.evs || {},
      ivs: role.ivs || {},
      nature: inferNature(role.evs || {}),
      teraType,
    });
  }

  return sets;
}

/** Get the level for a species in randbats */
export function getLevelForSpecies(species: string): number {
  if (!db) return 80;
  const key = Object.keys(db).find(
    k => k.toLowerCase().replace(/[^a-z0-9]/g, '') === species.toLowerCase().replace(/[^a-z0-9]/g, '')
  );
  if (!key) return 80;
  return db[key].level;
}

/** Infer nature from EV spread (heuristic) */
function inferNature(evs: Record<string, number>): string {
  // Common randbats natures based on EV investment
  const maxStat = Object.entries(evs).reduce(
    (best, [stat, val]) => val > best[1] ? [stat, val] as [string, number] : best,
    ['', 0] as [string, number]
  );

  switch (maxStat[0]) {
    case 'atk': return 'Adamant';
    case 'spa': return 'Modest';
    case 'spe': return 'Jolly'; // could be Timid, but we can't tell without knowing atk vs spa
    case 'hp': case 'def': return 'Bold';
    case 'spd': return 'Calm';
    default: return 'Serious';
  }
}
