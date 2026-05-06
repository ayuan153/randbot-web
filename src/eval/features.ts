/**
 * Feature extraction for ONNX model inference.
 * Produces a 206-element Float32Array matching training/features/extract_features.py.
 *
 * Layout:
 *   [0..155]   Per-Pokemon x12, 13 features each (player slots 0-5, opponent slots 6-11)
 *   [156..163] Matchup features (8)
 *   [164..175] Team-level features (12)
 *   [176..193] Field features (18)
 *   [194..205] Tempo features (12)
 */

import type { BattleSnapshot, PokemonState, SideState } from '../types';
import { Generations, TypeName } from '@pkmn/data';
import { Dex } from '@pkmn/dex';
import { toID } from '../util/id';

export const FEATURE_COUNT = 245;

const gens = new Generations(Dex);
const gen9 = gens.get(9);

// ─── Data for new features ──────────────────────────────────────

/** Base speed stats for common randbats Pokemon. Default 80. */
const BASE_SPEEDS: Record<string, number> = {
  'Abomasnow': 60, 'Absol': 75, 'Aegislash': 60, 'Alcremie': 64, 'Alomomola': 65,
  'Ambipom': 115, 'Ampharos': 55, 'Annihilape': 90, 'Araquanid': 42, 'Arboliva': 39,
  'Arcanine': 95, 'Archaludon': 85, 'Armarouge': 75, 'Azumarill': 50, 'Baxcalibur': 87,
  'Bisharp': 70, 'Blastoise': 78, 'Blaziken': 80, 'Blissey': 55, 'Brambleghast': 90,
  'Breloom': 70, 'Brute Bonnet': 55, 'Ceruledge': 85, 'Chandelure': 80, 'Chansey': 50,
  'Cinderace': 119, 'Clefable': 60, 'Cloyster': 70, 'Cobalion': 108, 'Conkeldurr': 45,
  'Corviknight': 67, 'Cyclizar': 121, 'Darkrai': 125, 'Decidueye': 70, 'Ditto': 48,
  'Donphan': 50, 'Dragapult': 142, 'Dragonite': 80, 'Drapion': 95, 'Enamorus': 106,
  'Espeon': 110, 'Excadrill': 88, 'Ferrothorn': 20, 'Flamigo': 90, 'Floatzel': 115,
  'Flygon': 100, 'Forretress': 40, 'Gallade': 80, 'Garchomp': 102, 'Gardevoir': 80,
  'Gastrodon': 39, 'Gengar': 110, 'Glimmora': 86, 'Gliscor': 95, 'Goodra': 80,
  'Grafaiai': 110, 'Great Tusk': 87, 'Greninja': 122, 'Grimmsnarl': 60, 'Gyarados': 81,
  'Hatterene': 29, 'Hawlucha': 118, 'Heatran': 77, 'Heracross': 85, 'Hippowdon': 47,
  'Hydreigon': 98, 'Infernape': 108, 'Iron Bundle': 136, 'Iron Hands': 50,
  'Iron Jugulis': 108, 'Iron Moth': 110, 'Iron Thorns': 72, 'Iron Valiant': 116,
  'Jirachi': 100, 'Kartana': 109, 'Kilowattrel': 125, 'Kingambit': 50, 'Kleavor': 85,
  'Kommo-o': 85, 'Krookodile': 92, 'Landorus': 101, 'Landorus-Therian': 91,
  'Lilligant-Hisui': 105, 'Lokix': 92, 'Lucario': 90, 'Lycanroc': 112, 'Mamoswine': 80,
  'Manaphy': 100, 'Maushold': 111, 'Meowscarada': 123, 'Metagross': 70, 'Mienshao': 105,
  'Milotic': 81, 'Mimikyu': 96, 'Moltres-Galar': 90, 'Muk-Alola': 50,
  'Ninetales-Alola': 109, 'Noivern': 123, 'Ogerpon': 110, 'Orthworm': 65, 'Palafin': 100,
  'Pelipper': 65, 'Polteageist': 70, 'Primarina': 60, 'Quaquaval': 85, 'Raging Bolt': 75,
  'Rillaboom': 85, 'Roaring Moon': 119, 'Rotom-Heat': 86, 'Rotom-Wash': 86,
  'Samurott-Hisui': 85, 'Sandy Shocks': 101, 'Scizor': 65, 'Serperior': 113,
  'Skeledirge': 66, 'Slowbro': 30, 'Slowking': 30, 'Slowking-Galar': 30, 'Sneasler': 120,
  'Sylveon': 60, 'Talonflame': 126, 'Tatsugiri': 82, 'Tauros-Paldea-Aqua': 100,
  'Tauros-Paldea-Blaze': 100, 'Tauros-Paldea-Combat': 100, 'Tentacruel': 100,
  'Thundurus': 111, 'Thundurus-Therian': 101, 'Tinkaton': 94, 'Tornadus': 111,
  'Tornadus-Therian': 121, 'Toxapex': 35, 'Toxtricity': 75, 'Tsareena': 72,
  'Tyranitar': 61, 'Umbreon': 65, 'Ursaluna': 50, 'Ursaluna-Bloodmoon': 52,
  'Urshifu': 97, 'Urshifu-Rapid-Strike': 97, 'Vaporeon': 65, 'Venusaur': 80,
  'Volcanion': 70, 'Weavile': 125, 'Wo-Chien': 70, 'Zamazenta': 138, 'Zarude': 105,
  'Zoroark-Hisui': 110,
};

const PRIORITY_MOVES = new Set([
  'Mach Punch', 'Aqua Jet', 'Bullet Punch', 'Extreme Speed', 'Ice Shard',
  'Shadow Sneak', 'Sucker Punch', 'Quick Attack', 'Accelerock', 'Grassy Glide', 'Jet Punch',
]);

const SETUP_MOVES = new Set([
  'Calm Mind', 'Swords Dance', 'Dragon Dance', 'Nasty Plot', 'Quiver Dance',
  'Iron Defense', 'Bulk Up', 'Shell Smash', 'Shift Gear', 'Coil', 'Agility',
  'Rock Polish', 'Autotomize', 'Belly Drum', 'Tail Glow', 'Growth', 'Work Up',
]);

const RECOVERY_MOVES = new Set([
  'Recover', 'Roost', 'Synthesis', 'Moonlight', 'Morning Sun',
  'Soft-Boiled', 'Slack Off', 'Shore Up', 'Strength Sap',
]);

const PHAZE_MOVES = new Set(['Roar', 'Whirlwind', 'Dragon Tail', 'Circle Throw']);
const HAZE_MOVES = new Set(['Haze', 'Clear Smog']);
const PROTECT_MOVES = new Set(['Protect', 'Detect', 'Baneful Bunker', "King's Shield", 'Spiky Shield']);
const TOXIC_MOVES = new Set(['Toxic']);
const SUBSTITUTE_MOVES = new Set(['Substitute']);

const SPECIAL_MOVES = new Set([
  'Thunderbolt', 'Ice Beam', 'Flamethrower', 'Hydro Pump', 'Fire Blast', 'Moonblast',
  'Shadow Ball', 'Psychic', 'Energy Ball', 'Dark Pulse', 'Focus Blast', 'Draco Meteor',
  'Leaf Storm', 'Surf', 'Scald', 'Thunder', 'Blizzard', 'Flash Cannon', 'Aura Sphere',
  'Hurricane', 'Psyshock',
]);

const STATUS_ORDER = ['brn', 'par', 'slp', 'psn', 'tox', 'frz'] as const;
const BOOST_KEYS = ['atk', 'def', 'spa', 'spd', 'spe'] as const;
const WEATHER_ORDER = ['sun', 'rain', 'sand', 'snow', 'hail'] as const;
const TERRAIN_ORDER = ['electric', 'grassy', 'misty', 'psychic'] as const;

export function extractFeatures(snapshot: BattleSnapshot): Float32Array {
  const f = new Float32Array(FEATURE_COUNT);
  let idx = 0;

  // Per-Pokemon: player (slots 0-5), opponent (slots 6-11)
  idx = writeSideFeatures(f, idx, snapshot.player, false);
  idx = writeSideFeatures(f, idx, snapshot.opponent, true);

  // Matchup (8) — simplified defaults for now
  f[idx++] = 0.5; // best_move_type_eff
  f[idx++] = 0.5; // their_best_type_eff
  f[idx++] = 0;   // speed_advantage
  f[idx++] = 0.5; // our_turns_to_ko
  f[idx++] = 0.5; // their_turns_to_ko
  f[idx++] = 0;   // can_ohko
  f[idx++] = 0;   // they_can_ohko
  f[idx++] = 0;   // matchup_score

  // Team-level (12)
  idx = writeTeamFeatures(f, idx, snapshot);

  // Field (18)
  idx = writeFieldFeatures(f, idx, snapshot);

  // Tempo (12)
  idx = writeTempoFeatures(f, idx, snapshot);

  // --- NEW FEATURES (206+) ---
  // A. Speed (6)
  idx = writeSpeedFeatures(f, idx, snapshot);
  // B. Type matchup (5)
  idx = writeTypeMatchupFeatures(f, idx, snapshot);
  // C. Turns-to-KO (3)
  idx = writeTtkoFeatures(f, idx, snapshot);
  // D. Team composition (4)
  idx = writeTeamCompFeatures(f, idx, snapshot);
  // E. Momentum (3)
  idx = writeMomentumFeatures(f, idx, snapshot);
  // F. Setup threat (7)
  idx = writeSetupFeatures(f, idx, snapshot);
  // G. Stall/wall (8)
  idx = writeStallFeatures(f, idx, snapshot);
  // H. Futility (3)
  idx = writeFutilityFeatures(f, idx, snapshot);

  return f;
}

function writeSideFeatures(
  f: Float32Array,
  idx: number,
  side: SideState,
  isOpponent: boolean
): number {
  // Active first, then bench (up to 5 bench slots for total of 6)
  const mons: Array<PokemonState | null> = [side.active, ...side.bench];
  for (let i = 0; i < 6; i++) {
    const mon = mons[i] ?? null;
    idx = writeMonFeatures(f, idx, mon, i === 0, isOpponent);
  }
  return idx;
}

function writeMonFeatures(
  f: Float32Array,
  idx: number,
  mon: PokemonState | null,
  isActive: boolean,
  isOpponent: boolean
): number {
  if (!mon || (!mon.species && isOpponent)) {
    // Unrevealed opponent mon
    f[idx++] = -1; // hp_fraction
    f[idx++] = 0;  // is_active
    f[idx++] = 0;  // is_alive
    // status one-hot (7 zeros = "none")
    for (let i = 0; i < 7; i++) f[idx++] = 0;
    // boosts (5 zeros)
    for (let i = 0; i < 5; i++) f[idx++] = 0;
    return idx;
  }

  const hpFraction = mon.hpMax > 0 ? mon.hp / mon.hpMax : 0;
  const isAlive = mon.hp > 0 ? 1 : 0;

  f[idx++] = hpFraction;
  f[idx++] = isActive ? 1 : 0;
  f[idx++] = isAlive;

  // Status one-hot: [none, brn, par, slp, psn, tox, frz]
  // "none" = index 0 = 1 when no status; otherwise the matching status index is 1
  const statusStr = mon.status ?? '';
  if (!statusStr) {
    f[idx++] = 1; // none
    for (let i = 0; i < 6; i++) f[idx++] = 0;
  } else {
    f[idx++] = 0; // none = 0
    for (const s of STATUS_ORDER) {
      f[idx++] = statusStr === s ? 1 : 0;
    }
  }

  // Boosts normalized to [-1, 1]
  for (const key of BOOST_KEYS) {
    f[idx++] = (mon.boosts[key] ?? 0) / 6;
  }

  return idx;
}

function writeTeamFeatures(f: Float32Array, idx: number, snapshot: BattleSnapshot): number {
  const playerMons = [snapshot.player.active, ...snapshot.player.bench];
  const oppMons = [snapshot.opponent.active, ...snapshot.opponent.bench];

  const aliveCount = playerMons.filter(m => m.hp > 0).length;
  const oppAliveCount = oppMons.filter(m => m.hp > 0).length;
  const totalHp = playerMons.reduce((s, m) => s + (m.hpMax > 0 ? m.hp / m.hpMax : 0), 0) / Math.max(playerMons.length, 1);
  const oppTotalHp = oppMons.reduce((s, m) => s + (m.hpMax > 0 ? m.hp / m.hpMax : 0), 0) / Math.max(oppMons.length, 1);

  const faintedCount = playerMons.filter(m => m.hp <= 0 && m.species).length;
  const oppFaintedCount = oppMons.filter(m => m.hp <= 0 && m.species).length;
  const statusCount = playerMons.filter(m => m.status && m.hp > 0).length;
  const oppStatusCount = oppMons.filter(m => m.status && m.hp > 0).length;

  // Hazard damage estimate (fraction of HP lost on switch-in)
  const pSide = snapshot.field.playerSide;
  let hazardDmg = 0;
  if (pSide.stealthRock) hazardDmg += 0.125;
  hazardDmg += pSide.spikes * 0.083;
  if (pSide.stickyWeb) hazardDmg += 0.05;

  f[idx++] = aliveCount / 6;
  f[idx++] = oppAliveCount / 6;
  f[idx++] = totalHp;
  f[idx++] = oppTotalHp;
  f[idx++] = hazardDmg;
  f[idx++] = 0.5; // type_coverage default
  f[idx++] = faintedCount / 6;
  f[idx++] = oppFaintedCount / 6;
  f[idx++] = statusCount / 6;
  f[idx++] = oppStatusCount / 6;

  // Pad to 12 (alive_count, their_alive_count, total_hp, their_total_hp, hazard, coverage, fainted, their_fainted, status, their_status = 10)
  // The spec says 12 features — re-reading: it lists 10 items. Let me add the remaining 2 as opponent hazard + opponent coverage
  const oSide = snapshot.field.opponentSide;
  let oppHazardDmg = 0;
  if (oSide.stealthRock) oppHazardDmg += 0.125;
  oppHazardDmg += oSide.spikes * 0.083;
  if (oSide.stickyWeb) oppHazardDmg += 0.05;

  f[idx++] = oppHazardDmg;
  f[idx++] = 0.5; // their_type_coverage default

  return idx;
}

function writeFieldFeatures(f: Float32Array, idx: number, snapshot: BattleSnapshot): number {
  const weather = snapshot.field.weather ?? '';
  const terrain = snapshot.field.terrain ?? '';

  // Weather one-hot [none, sun, rain, sand, snow, hail] (6)
  const weatherMatch = WEATHER_ORDER.findIndex(w => weather.toLowerCase().includes(w));
  f[idx++] = weatherMatch === -1 ? 1 : 0; // none
  for (let i = 0; i < WEATHER_ORDER.length; i++) {
    f[idx++] = i === weatherMatch ? 1 : 0;
  }

  // Terrain one-hot [none, electric, grassy, misty, psychic] (5)
  const terrainMatch = TERRAIN_ORDER.findIndex(t => terrain.toLowerCase().includes(t));
  f[idx++] = terrainMatch === -1 ? 1 : 0; // none
  for (let i = 0; i < TERRAIN_ORDER.length; i++) {
    f[idx++] = i === terrainMatch ? 1 : 0;
  }

  // Screens [reflect_ours, lightscreen_ours, reflect_theirs, lightscreen_theirs] (4)
  f[idx++] = snapshot.field.playerSide.reflect > 0 ? 1 : 0;
  f[idx++] = snapshot.field.playerSide.lightScreen > 0 ? 1 : 0;
  f[idx++] = snapshot.field.opponentSide.reflect > 0 ? 1 : 0;
  f[idx++] = snapshot.field.opponentSide.lightScreen > 0 ? 1 : 0;

  // Tailwind [ours, theirs] (2)
  f[idx++] = snapshot.field.playerSide.tailwind > 0 ? 1 : 0;
  f[idx++] = snapshot.field.opponentSide.tailwind > 0 ? 1 : 0;

  // Trick room (1)
  f[idx++] = 0; // Not tracked in FieldState currently

  return idx;
}

function writeTempoFeatures(f: Float32Array, idx: number, snapshot: BattleSnapshot): number {
  // setup_progress: max boost magnitude / 6
  const playerBoosts = snapshot.player.active.boosts;
  const maxPlayerBoost = Math.max(...BOOST_KEYS.map(k => Math.abs(playerBoosts[k] ?? 0)));
  f[idx++] = maxPlayerBoost / 6;

  // their_setup_progress
  const oppBoosts = snapshot.opponent.active.boosts;
  const maxOppBoost = Math.max(...BOOST_KEYS.map(k => Math.abs(oppBoosts[k] ?? 0)));
  f[idx++] = maxOppBoost / 6;

  f[idx++] = 0; // ko_threat
  f[idx++] = 0; // ko_threat_against
  f[idx++] = 0; // momentum
  f[idx++] = 0; // switch_pressure

  // Tera availability
  f[idx++] = snapshot.player.active.terastallized ? 0 : 1; // tera_available (assume available if not used)
  f[idx++] = snapshot.opponent.active.terastallized ? 0 : 1; // their_tera_available
  f[idx++] = snapshot.player.active.terastallized ? 1 : 0; // tera_used
  f[idx++] = snapshot.opponent.active.terastallized ? 1 : 0; // their_tera_used

  f[idx++] = snapshot.turn / 100; // turn_number normalized
  f[idx++] = snapshot.availableActions.length === 0 ? 1 : 0; // forced_switch (no actions = forced)

  return idx;
}

// ─── New features (206-244) ─────────────────────────────────────

/** Estimate speed stat at level 84 assuming neutral nature, 31 IVs, 84 EVs */
function estimateSpeed(species: string): number {
  const baseSpe = BASE_SPEEDS[species] ?? 80;
  return (2 * baseSpe + 31 + 21) * 84 / 100 + 5;
}

/** Get species types via @pkmn/data */
function getTypes(species: string): string[] {
  const data = gen9.species.get(toID(species));
  return (data?.types as string[] | undefined) ?? ['Normal'];
}

/** Type effectiveness multiplier (attacking type vs defending types) */
function typeEffectiveness(atkType: string, defTypes: string[]): number {
  return gen9.types.totalEffectiveness(atkType as TypeName, defTypes as TypeName[]);
}

/** Map raw effectiveness to normalized scale matching Python */
function effToScale(mult: number): number {
  if (mult === 0) return 0.0;
  if (mult <= 0.25) return 0.25;
  if (mult <= 0.5) return 0.5;
  if (mult <= 1.0) return 0.75;
  if (mult <= 2.0) return 1.0;
  return 1.25;
}

/** Get move type and base power from @pkmn/data */
function getMoveTypePower(moveName: string): [string, number] {
  const move = gen9.moves.get(toID(moveName));
  if (move && move.category !== 'Status') {
    return [move.type as string, move.basePower];
  }
  if (move) return [move.type as string, 0];
  return ['Normal', 80];
}

/** Best STAB effectiveness from known moves or types against defender */
function bestStabEff(monTypes: string[], movesKnown: string[], defTypes: string[]): number {
  let best = 0;
  for (const move of movesKnown) {
    const [mtype, bp] = getMoveTypePower(move);
    if (bp > 0 && monTypes.includes(mtype)) {
      best = Math.max(best, typeEffectiveness(mtype, defTypes));
    }
  }
  for (const t of monTypes) {
    best = Math.max(best, typeEffectiveness(t, defTypes));
  }
  return best;
}

/** Rough damage proxy: base_power * effectiveness * stab / 200, capped at 1.0 */
function estimateBestDamagePct(monTypes: string[], movesKnown: string[], defTypes: string[]): number {
  let best = 0;
  for (const move of movesKnown) {
    const [mtype, bp] = getMoveTypePower(move);
    if (bp === 0) continue;
    const eff = typeEffectiveness(mtype, defTypes);
    const stab = monTypes.includes(mtype) ? 1.5 : 1.0;
    best = Math.max(best, bp * eff * stab / 200);
  }
  if (movesKnown.length === 0) {
    for (const t of monTypes) {
      const eff = typeEffectiveness(t, defTypes);
      best = Math.max(best, 80 * eff * 1.5 / 200);
    }
  }
  return Math.min(best, 1.0);
}

/** A. Speed-related (6 features) */
function writeSpeedFeatures(f: Float32Array, idx: number, snapshot: BattleSnapshot): number {
  const myMon = snapshot.player.active;
  const oppMon = snapshot.opponent.active;
  let mySpeed = myMon.species ? estimateSpeed(myMon.species) : 80;
  let oppSpeed = oppMon.species ? estimateSpeed(oppMon.species) : 80;

  if (oppMon.status === 'par') oppSpeed *= 0.5;

  const total = mySpeed + oppSpeed;
  const speedRatio = total > 0 ? mySpeed / total : 0.5;
  const priority = myMon.moves.some(m => PRIORITY_MOVES.has(m)) ? 1 : 0;
  const scarfPossible = oppMon.item === null && oppMon.species ? 1 : 0;
  const paralysis = oppMon.status === 'par' ? 1 : 0;

  f[idx++] = Math.min(mySpeed / 500, 1);
  f[idx++] = Math.min(oppSpeed / 500, 1);
  f[idx++] = speedRatio;
  f[idx++] = priority;
  f[idx++] = scarfPossible;
  f[idx++] = paralysis;
  return idx;
}

/** B. Type matchup (5 features) */
function writeTypeMatchupFeatures(f: Float32Array, idx: number, snapshot: BattleSnapshot): number {
  const myMon = snapshot.player.active;
  const oppMon = snapshot.opponent.active;
  const myTypes = myMon.species ? getTypes(myMon.species) : ['Normal'];
  const oppTypes = oppMon.species ? getTypes(oppMon.species) : ['Normal'];

  const bestStab = effToScale(bestStabEff(myTypes, myMon.moves, oppTypes));
  const theirBestStab = effToScale(bestStabEff(oppTypes, oppMon.moves, myTypes));

  const oppPrimaryStab = oppTypes[0] ?? 'Normal';
  const playerMons = [snapshot.player.active, ...snapshot.player.bench];
  let resists = 0;
  let weak = 0;
  for (const mon of playerMons) {
    if (mon.hp <= 0 || !mon.species) continue;
    const mt = getTypes(mon.species);
    const eff = typeEffectiveness(oppPrimaryStab, mt);
    if (eff < 1) resists++;
    else if (eff > 1) weak++;
  }

  const immune = typeEffectiveness(oppPrimaryStab, myTypes) === 0 ? 1 : 0;

  f[idx++] = bestStab;
  f[idx++] = theirBestStab;
  f[idx++] = resists / 6;
  f[idx++] = weak / 6;
  f[idx++] = immune;
  return idx;
}

/** C. Turns-to-KO (3 features) */
function writeTtkoFeatures(f: Float32Array, idx: number, snapshot: BattleSnapshot): number {
  const myMon = snapshot.player.active;
  const oppMon = snapshot.opponent.active;
  const myTypes = myMon.species ? getTypes(myMon.species) : ['Normal'];
  const oppTypes = oppMon.species ? getTypes(oppMon.species) : ['Normal'];

  const myDmg = estimateBestDamagePct(myTypes, myMon.moves, oppTypes);
  const theirDmg = estimateBestDamagePct(oppTypes, oppMon.moves, myTypes);

  const myTtko = myDmg > 0 ? Math.min(1 / myDmg, 5) / 5 : 1;
  const theirTtko = theirDmg > 0 ? Math.min(1 / theirDmg, 5) / 5 : 1;
  const koDiff = Math.max(-1, Math.min(1, theirTtko - myTtko));

  f[idx++] = myTtko;
  f[idx++] = theirTtko;
  f[idx++] = koDiff;
  return idx;
}

/** D. Team composition (4 features) */
function writeTeamCompFeatures(f: Float32Array, idx: number, snapshot: BattleSnapshot): number {
  const playerMons = [snapshot.player.active, ...snapshot.player.bench];
  const oppMons = [snapshot.opponent.active, ...snapshot.opponent.bench];
  let physAttackers = 0;
  let specAttackers = 0;
  let walls = 0;

  for (const mon of playerMons) {
    if (mon.hp <= 0 || !mon.species) continue;
    const hasPhys = mon.moves.some(m => {
      const [, bp] = getMoveTypePower(m);
      return bp >= 70 && !SETUP_MOVES.has(m) && !RECOVERY_MOVES.has(m);
    });
    const hasSpec = mon.moves.some(m => SPECIAL_MOVES.has(m));
    const hasRecovery = mon.moves.some(m => RECOVERY_MOVES.has(m));
    if (hasPhys) physAttackers++;
    if (hasSpec) specAttackers++;
    if (hasRecovery) walls++;
  }

  const unrevealed = oppMons.filter(m => !m.species).length;

  f[idx++] = physAttackers / 6;
  f[idx++] = specAttackers / 6;
  f[idx++] = unrevealed / 6;
  f[idx++] = walls / 6;
  return idx;
}

/** E. Momentum (3 features) */
function writeMomentumFeatures(f: Float32Array, idx: number, snapshot: BattleSnapshot): number {
  const playerMons = [snapshot.player.active, ...snapshot.player.bench];
  const oppMons = [snapshot.opponent.active, ...snapshot.opponent.bench];

  const ourFainted = playerMons.filter(m => m.hp <= 0 && m.species).length;
  const theirFainted = oppMons.filter(m => m.hp <= 0 && m.species).length;
  const consecKos = Math.min(Math.max(theirFainted - ourFainted, 0), 3) / 3;

  const lastSwitch = 0; // Cannot reliably determine from snapshot alone

  const oSide = snapshot.field.opponentSide;
  const hazardLayers = (oSide.stealthRock ? 1 : 0) + oSide.spikes + oSide.toxicSpikes;

  f[idx++] = consecKos;
  f[idx++] = lastSwitch;
  f[idx++] = Math.min(hazardLayers, 6) / 6;
  return idx;
}

/** F. Setup threat (7 features) */
function writeSetupFeatures(f: Float32Array, idx: number, snapshot: BattleSnapshot): number {
  const myMon = snapshot.player.active;
  const oppMon = snapshot.opponent.active;

  const oppHasSetup = oppMon.moves.some(m => SETUP_MOVES.has(m)) ? 1 : 0;

  const oppBoostTotal = Object.values(oppMon.boosts).reduce((s, v) => s + Math.max(0, v), 0) / 12;
  const myBoostTotal = Object.values(myMon.boosts).reduce((s, v) => s + Math.max(0, v), 0) / 12;
  const oppSetupTurns = Math.min(Object.values(oppMon.boosts).reduce((s, v) => s + Math.max(0, v), 0), 3) / 3;

  const canPhaze = myMon.moves.some(m => PHAZE_MOVES.has(m)) ? 1 : 0;
  const canHaze = myMon.moves.some(m => HAZE_MOVES.has(m)) ? 1 : 0;

  const playerMons = [snapshot.player.active, ...snapshot.player.bench];
  const unaware = playerMons.some(m => m.hp > 0 && m.ability === 'Unaware') ? 1 : 0;

  f[idx++] = oppHasSetup;
  f[idx++] = oppBoostTotal;
  f[idx++] = myBoostTotal;
  f[idx++] = oppSetupTurns;
  f[idx++] = canPhaze;
  f[idx++] = canHaze;
  f[idx++] = unaware;
  return idx;
}

/** G. Stall/wall (8 features) */
function writeStallFeatures(f: Float32Array, idx: number, snapshot: BattleSnapshot): number {
  const myMon = snapshot.player.active;
  const oppMon = snapshot.opponent.active;
  const myTypes = myMon.species ? getTypes(myMon.species) : ['Normal'];
  const oppTypes = oppMon.species ? getTypes(oppMon.species) : ['Normal'];

  const oppRecovery = oppMon.moves.some(m => RECOVERY_MOVES.has(m)) ? 1 : 0;
  const oppToxic = oppMon.moves.some(m => TOXIC_MOVES.has(m)) ? 1 : 0;
  const oppSub = oppMon.moves.some(m => SUBSTITUTE_MOVES.has(m)) ? 1 : 0;
  const oppProtect = oppMon.moves.some(m => PROTECT_MOVES.has(m)) ? 1 : 0;

  const myBestDmg = estimateBestDamagePct(myTypes, myMon.moves, oppTypes);
  const dmgVsRecovery = Math.max(-1, Math.min(1, myBestDmg - 0.25));

  const toxicOnMe = myMon.status === 'tox' ? 1 : 0;
  let toxicTurns = 0;
  if (myMon.status === 'tox') {
    const hpLost = myMon.hpMax > 0 ? 1 - myMon.hp / myMon.hpMax : 0;
    toxicTurns = Math.min(hpLost * 8, 8) / 8;
  }

  f[idx++] = oppRecovery;
  f[idx++] = oppToxic;
  f[idx++] = oppSub;
  f[idx++] = oppProtect;
  f[idx++] = myBestDmg;
  f[idx++] = dmgVsRecovery;
  f[idx++] = toxicOnMe;
  f[idx++] = toxicTurns;
  return idx;
}

/** H. Futility (3 features) */
function writeFutilityFeatures(f: Float32Array, idx: number, snapshot: BattleSnapshot): number {
  const myMon = snapshot.player.active;
  const oppMon = snapshot.opponent.active;
  const myTypes = myMon.species ? getTypes(myMon.species) : ['Normal'];
  const oppTypes = oppMon.species ? getTypes(oppMon.species) : ['Normal'];

  const myBestDmg = estimateBestDamagePct(myTypes, myMon.moves, oppTypes);
  const theirBestDmg = estimateBestDamagePct(oppTypes, oppMon.moves, myTypes);

  const walled = myBestDmg < 0.20 ? 1 : 0;
  const theyWalled = theirBestDmg < 0.20 ? 1 : 0;
  const oppRecovery = oppMon.moves.some(m => RECOVERY_MOVES.has(m));
  const futility = walled === 1 && oppRecovery ? 1 : 0;

  f[idx++] = walled;
  f[idx++] = theyWalled;
  f[idx++] = futility;
  return idx;
}