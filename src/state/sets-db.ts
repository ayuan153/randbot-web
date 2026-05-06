/**
 * Randbats set database.
 * Loads set data from bundled gen9randombattle.json.
 *
 * Data structure (from data.pkmn.cc):
 *   { [species]: { level, abilities, items, evs?, roles: { [roleName]: { abilities, items, teraTypes, moves } } } }
 *
 * Note: each role's `moves` is a POOL (5-8 moves), not a fixed 4-move set.
 * The actual set picks 4 from the pool. We treat the full pool as possible moves.
 */

import type { RandbatsSet } from '../types';
import { toID } from '../util/id';

interface RawRole {
  abilities: string[];
  items: string[];
  teraTypes: string[];
  moves: string[];
}

interface RawSpeciesData {
  level: number;
  abilities: string[];
  items: string[];
  evs?: Record<string, number>;
  roles: Record<string, RawRole>;
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

/** Check if the database is loaded */
export function isLoaded(): boolean {
  return db !== null;
}

/**
 * Get all possible sets for a species — one per role.
 * Each set uses the role's first item/ability as representative.
 * The moves array is the full pool (not just 4).
 */
export function getSetsForSpecies(species: string): RandbatsSet[] {
  if (!db) return [];

  const key = findSpeciesKey(species);
  if (!key) return [];

  const data = db[key];
  const sets: RandbatsSet[] = [];

  for (const [, role] of Object.entries(data.roles)) {
    sets.push({
      ability: role.abilities[0] || data.abilities[0] || '',
      item: role.items[0] || data.items[0] || '',
      moves: role.moves,
      evs: data.evs || {},
      ivs: {},
      nature: inferNature(data.evs || {}),
      teraType: role.teraTypes?.[0],
    });
  }

  return sets;
}

/** Get all possible items for a species across all roles */
export function getItemsForSpecies(species: string): string[] {
  if (!db) return [];
  const key = findSpeciesKey(species);
  if (!key) return [];
  return db[key].items;
}

/** Get all possible abilities for a species */
export function getAbilitiesForSpecies(species: string): string[] {
  if (!db) return [];
  const key = findSpeciesKey(species);
  if (!key) return [];
  return db[key].abilities;
}

/** Get the level for a species in randbats */
export function getLevelForSpecies(species: string): number {
  if (!db) return 80;
  const key = findSpeciesKey(species);
  if (!key) return 80;
  return db[key].level;
}

// ─── Helpers ────────────────────────────────────────────────────

/** Find the key in the DB matching a species name (case-insensitive, stripped) */
function findSpeciesKey(species: string): string | undefined {
  if (!db) return undefined;
  const normalized = toID(species);
  return Object.keys(db).find(
    k => toID(k) === normalized
  );
}

/** Infer nature from EV spread (heuristic) */
function inferNature(evs: Record<string, number>): string {
  const maxStat = Object.entries(evs).reduce(
    (best, [stat, val]) => val > best[1] ? [stat, val] as [string, number] : best,
    ['', 0] as [string, number]
  );

  switch (maxStat[0]) {
    case 'atk': return 'Adamant';
    case 'spa': return 'Modest';
    case 'spe': return 'Jolly';
    case 'hp': case 'def': return 'Bold';
    case 'spd': return 'Calm';
    default: return 'Serious';
  }
}
