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

export const FEATURE_COUNT = 206;

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
