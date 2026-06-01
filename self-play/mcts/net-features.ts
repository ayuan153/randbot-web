/**
 * net-features.ts — Feature extractors for self-play neural network.
 *
 * extractFeatures20: Legacy 20-feature extractor (request-based, used by net-eval.ts).
 * extractFeatures: Rich 225-feature extractor reading full @pkmn/sim Battle state.
 */

import {Battle, Pokemon as SimPokemon} from '@pkmn/sim';
import {Generations} from '@pkmn/data';
import {Dex} from '@pkmn/dex';
import {calculate, Generations as CalcGenerations, Pokemon as CalcPokemon, Move as CalcMove, Field as CalcField} from '@smogon/calc';
import type {StatusName, Weather, Terrain} from '@smogon/calc/dist/data/interface';

import type {TypeName} from '@pkmn/data';

// ─── Shared data ──────────────────────────────────────────────────────────────

const gens = new Generations(Dex);
const gen9 = gens.get(9);
const calcGen = CalcGenerations.get(9);

export const FEATURE_DIM = 225;

/** Fixed type order for 1-hot encoding (18 types in Gen 9) */
const TYPE_LIST = [
  'Normal', 'Fire', 'Water', 'Electric', 'Grass', 'Ice',
  'Fighting', 'Poison', 'Ground', 'Flying', 'Psychic', 'Bug',
  'Rock', 'Ghost', 'Dragon', 'Dark', 'Steel', 'Fairy',
] as const;

const WEATHER_LIST = ['', 'sunnyday', 'raindance', 'sandstorm', 'snow'] as const;
const TERRAIN_LIST = ['', 'electricterrain', 'grassyterrain', 'psychicterrain', 'mistyterrain'] as const;

const STATUS_LIST = ['', 'brn', 'par', 'slp', 'frz', 'psn', 'tox'] as const;

const VOLATILE_LIST = ['substitute', 'leechseed', 'taunt', 'encore', 'confusion', 'yawn', 'disable', 'curse'] as const;

const CHOICE_ITEMS = new Set(['choiceband', 'choicespecs', 'choicescarf']);
const HAZARD_REMOVAL_MOVES = new Set(['rapidspin', 'defog', 'tidyup', 'mortalspin']);

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Get type effectiveness multiplier for moveType vs defender types */
function getTypeEffectiveness(moveType: string, defenderTypes: string[]): number {
  const typeData = gen9.types.get(moveType);
  if (!typeData) return 1;
  let mult = 1;
  for (const dt of defenderTypes) {
    const eff = typeData.effectiveness[dt as TypeName];
    if (eff !== undefined) mult *= eff;
  }
  return mult;
}

/** Stat boost multiplier: +1 = 1.5, +2 = 2, etc. */
function boostMultiplier(stage: number): number {
  if (stage >= 0) return (2 + stage) / 2;
  return 2 / (2 - stage);
}

/** Compute effective speed for a pokemon */
function effectiveSpeed(
  mon: SimPokemon,
  sideConditions: Record<string, unknown>,
): number {
  const baseSpe = mon.storedStats?.spe ?? 100;
  let speed = baseSpe * boostMultiplier(mon.boosts?.spe ?? 0);
  if (mon.status === 'par') speed *= 0.5;
  if (mon.item === 'choicescarf') speed *= 1.5;
  if (sideConditions['tailwind']) speed *= 2;
  return speed;
}

/** Estimate damage fraction using @smogon/calc. Returns max roll / opp current HP, capped at 1. */
function estimateDamageFrac(
  battle: Battle,
  attackerSide: 'p1' | 'p2',
  moveSlotIdx: number,
): number {
  const side = battle[attackerSide];
  const oppSide = battle[attackerSide === 'p1' ? 'p2' : 'p1'];
  const attacker = side.active[0];
  const defender = oppSide.active[0];
  if (!attacker || !defender || !attacker.species || !defender.species) return 0;

  const moveSlot = attacker.moveSlots?.[moveSlotIdx];
  if (!moveSlot) return 0;

  const moveData = gen9.moves.get(moveSlot.id);
  if (!moveData || moveData.category === 'Status') return 0;
  if (defender.hp <= 0) return 0;

  try {
    const atkMon = new CalcPokemon(calcGen, attacker.species.name, {
      level: attacker.level,
      item: attacker.item || undefined,
      ability: attacker.ability || undefined,
      boosts: attacker.boosts ? {...attacker.boosts} : undefined,
      curHP: attacker.hp,
      status: (attacker.status || undefined) as StatusName | undefined,
      teraType: (attacker.terastallized || undefined) as import('@smogon/calc/dist/data/interface').TypeName | undefined,
    });
    const defMon = new CalcPokemon(calcGen, defender.species.name, {
      level: defender.level,
      item: defender.item || undefined,
      ability: defender.ability || undefined,
      boosts: defender.boosts ? {...defender.boosts} : undefined,
      curHP: defender.hp,
      status: (defender.status || undefined) as StatusName | undefined,
      teraType: (defender.terastallized || undefined) as import('@smogon/calc/dist/data/interface').TypeName | undefined,
    });

    // Build field
    const mySideConds = side.sideConditions;
    const oppSideConds = oppSide.sideConditions;
    const field = new CalcField({
      weather: (battle.field.weather || undefined) as Weather | undefined,
      terrain: (battle.field.terrain || undefined) as Terrain | undefined,
      attackerSide: {
        isReflect: !!mySideConds['reflect'],
        isLightScreen: !!mySideConds['lightscreen'],
        isAuroraVeil: !!mySideConds['auroraveil'],
        isTailwind: !!mySideConds['tailwind'],
      },
      defenderSide: {
        isReflect: !!oppSideConds['reflect'],
        isLightScreen: !!oppSideConds['lightscreen'],
        isAuroraVeil: !!oppSideConds['auroraveil'],
        spikes: (oppSideConds['spikes'] as {layers?: number} | undefined)?.layers ?? 0,
        isSR: !!oppSideConds['stealthrock'],
      },
    });

    const move = new CalcMove(calcGen, moveSlot.id, {ability: attacker.ability || undefined});
    const result = calculate(calcGen, atkMon, defMon, move, field);

    let rolls: number[];
    if (Array.isArray(result.damage) && Array.isArray(result.damage[0])) {
      rolls = (result.damage as number[][])[0];
    } else if (Array.isArray(result.damage)) {
      rolls = result.damage as number[];
    } else {
      rolls = [result.damage as number];
    }

    if (rolls.length === 0 || defender.hp <= 0) return 0;
    const hitMultiplier = move.hits;
    const maxDmg = Math.max(...rolls) * hitMultiplier;
    const frac = maxDmg / defender.hp;
    return Number.isFinite(frac) ? Math.min(1, Math.max(0, frac)) : 0;
  } catch {
    return 0;
  }
}

// ─── Main 225-feature extractor ───────────────────────────────────────────────

/**
 * Extract a 225-dimensional feature vector from a @pkmn/sim Battle.
 * "me" = side, "opp" = the other side. All values normalized to [-1,1].
 */
export function extractFeatures(battle: Battle, side: 'p1' | 'p2'): Float32Array {
  const f = new Float32Array(FEATURE_DIM);
  let idx = 0;

  const mySide = battle[side];
  const oppSideId: 'p1' | 'p2' = side === 'p1' ? 'p2' : 'p1';
  const oppSide = battle[oppSideId];
  const myActive = mySide.active[0];
  const oppActive = oppSide.active[0];

  // ─── A. Global field (15) ───────────────────────────────────────────────────
  // Weather 1-hot (5)
  const weatherIdx = WEATHER_LIST.indexOf(battle.field.weather as typeof WEATHER_LIST[number]);
  for (let i = 0; i < 5; i++) f[idx++] = (i === (weatherIdx >= 0 ? weatherIdx : 0)) ? 1 : 0;
  // Weather turns/8
  const weatherDuration = (battle.field.weatherState as {duration?: number})?.duration ?? 0;
  f[idx++] = Math.min(weatherDuration / 8, 1);
  // Terrain 1-hot (5)
  const terrainIdx = TERRAIN_LIST.indexOf(battle.field.terrain as typeof TERRAIN_LIST[number]);
  for (let i = 0; i < 5; i++) f[idx++] = (i === (terrainIdx >= 0 ? terrainIdx : 0)) ? 1 : 0;
  // Terrain turns/8
  const terrainDuration = (battle.field.terrainState as {duration?: number})?.duration ?? 0;
  f[idx++] = Math.min(terrainDuration / 8, 1);
  // Trick room active + turns/5
  const trPW = battle.field.pseudoWeather['trickroom'] as {duration?: number} | undefined;
  f[idx++] = trPW ? 1 : 0;
  f[idx++] = trPW ? Math.min((trPW.duration ?? 0) / 5, 1) : 0;
  // Gravity active
  const gravPW = battle.field.pseudoWeather['gravity'] as {duration?: number} | undefined;
  f[idx++] = gravPW ? 1 : 0;

  // ─── B. Side conditions (9 per side × 2 = 18) ──────────────────────────────
  for (const s of [mySide, oppSide]) {
    const sc = s.sideConditions as Record<string, {layers?: number; duration?: number; [k: string]: unknown}>;
    f[idx++] = sc['stealthrock'] ? 1 : 0;
    f[idx++] = (sc['spikes']?.layers ?? 0) / 3;
    f[idx++] = (sc['toxicspikes']?.layers ?? 0) / 2;
    f[idx++] = sc['stickyweb'] ? 1 : 0;
    f[idx++] = sc['reflect'] ? 1 : 0;
    f[idx++] = sc['lightscreen'] ? 1 : 0;
    f[idx++] = sc['auroraveil'] ? 1 : 0;
    f[idx++] = sc['tailwind'] ? 1 : 0;
    // Max screen turns / 8
    const screenTurns = Math.max(
      sc['reflect']?.duration ?? 0,
      sc['lightscreen']?.duration ?? 0,
      sc['auroraveil']?.duration ?? 0,
    );
    f[idx++] = Math.min(screenTurns / 8, 1);
  }

  // ─── C. Active blocks (44 per active × 2 = 88) ─────────────────────────────
  for (const [activeIdx, active] of ([myActive, oppActive] as (SimPokemon | null)[]).entries()) {
    if (!active) {
      idx += 44;
      continue;
    }
    // HP fraction
    f[idx++] = active.maxhp > 0 ? active.hp / active.maxhp : 0;
    // Status 1-hot (7)
    const statusIdx = STATUS_LIST.indexOf(active.status as typeof STATUS_LIST[number]);
    for (let i = 0; i < 7; i++) f[idx++] = (i === (statusIdx >= 0 ? statusIdx : 0)) ? 1 : 0;
    // Status counter / 15
    const statusState = (active.statusState ?? {}) as {toxicTurns?: number; sleepTurns?: number; [k: string]: unknown};
    const counter = active.status === 'tox' ? (statusState.toxicTurns ?? 0) :
                    active.status === 'slp' ? (statusState.sleepTurns ?? 0) : 0;
    f[idx++] = Math.min(counter / 15, 1);
    // Boosts / 6 (7 stats)
    const boosts = active.boosts ?? {atk: 0, def: 0, spa: 0, spd: 0, spe: 0, accuracy: 0, evasion: 0};
    f[idx++] = (boosts.atk ?? 0) / 6;
    f[idx++] = (boosts.def ?? 0) / 6;
    f[idx++] = (boosts.spa ?? 0) / 6;
    f[idx++] = (boosts.spd ?? 0) / 6;
    f[idx++] = (boosts.spe ?? 0) / 6;
    f[idx++] = (boosts.accuracy ?? 0) / 6;
    f[idx++] = (boosts.evasion ?? 0) / 6;
    // Type membership 1-hot (18)
    const types = active.types ?? [];
    for (let i = 0; i < 18; i++) {
      f[idx++] = types.includes(TYPE_LIST[i]) ? 1 : 0;
    }
    // Volatiles (8)
    const volatiles = active.volatiles ?? {};
    for (const vol of VOLATILE_LIST) {
      f[idx++] = volatiles[vol] ? 1 : 0;
    }
    // Tera available (can still tera)
    // canTerastallize is truthy (the tera type string) if not yet used
    f[idx++] = (activeIdx === 0 ? myActive?.canTerastallize : oppActive?.canTerastallize) ? 1 : 0;
    // Terastallized
    f[idx++] = active.terastallized ? 1 : 0;
  }

  // ─── D. My 4 move slots (10 each = 40) ─────────────────────────────────────
  const myMoveSlots = myActive?.moveSlots ?? [];
  for (let i = 0; i < 4; i++) {
    if (!myActive || i >= myMoveSlots.length) {
      idx += 10;
      continue;
    }
    const slot = myMoveSlots[i];
    const moveData = gen9.moves.get(slot.id);
    // Base power / 150
    f[idx++] = Math.min((moveData?.basePower ?? 0) / 150, 1);
    // Category 1-hot [physical, special, status]
    const cat = moveData?.category ?? 'Status';
    f[idx++] = cat === 'Physical' ? 1 : 0;
    f[idx++] = cat === 'Special' ? 1 : 0;
    f[idx++] = cat === 'Status' ? 1 : 0;
    // Type effectiveness vs opp active / 4
    const moveType = moveData?.type ?? 'Normal';
    const oppTypes = oppActive?.types ?? [];
    const eff = getTypeEffectiveness(moveType, oppTypes);
    f[idx++] = Math.min(eff / 4, 1);
    // Priority (clamp [-7,5], (p+7)/12)
    const priority = Math.max(-7, Math.min(5, moveData?.priority ?? 0));
    f[idx++] = (priority + 7) / 12;
    // Disabled
    f[idx++] = slot.disabled ? 1 : 0;
    // PP fraction
    f[idx++] = slot.maxpp > 0 ? slot.pp / slot.maxpp : 0;
    // Est damage frac (via @smogon/calc)
    const dmgFrac = estimateDamageFrac(battle, side, i);
    f[idx++] = dmgFrac;
    // KO flag
    f[idx++] = dmgFrac >= 1 ? 1 : 0;
  }

  // ─── E. Team reserve (6 mons × 3 per side × 2 = 36) ────────────────────────
  for (const s of [mySide, oppSide]) {
    const team = s.pokemon;
    for (let i = 0; i < 6; i++) {
      if (i < team.length) {
        const mon = team[i];
        f[idx++] = mon.maxhp > 0 ? mon.hp / mon.maxhp : 0;
        f[idx++] = mon.fainted ? 1 : 0;
        f[idx++] = mon.status ? 1 : 0;
      } else {
        idx += 3;
      }
    }
  }

  // ─── F. Team aggregates (12) ────────────────────────────────────────────────
  // Helper: count alive, hp sum, healthy, resist opp STAB, threaten opp, hazard removal
  for (const [sIdx, s] of [mySide, oppSide].entries()) {
    const opp = sIdx === 0 ? oppSide : mySide;
    const oppAct = sIdx === 0 ? oppActive : myActive;
    const team = s.pokemon;

    let alive = 0, hpSum = 0, healthy = 0, resistOppStab = 0, threatenOpp = 0, hasRemoval = 0;
    // Opp active STAB types
    const oppStabTypes = oppAct?.types ?? [];

    for (const mon of team) {
      if (mon.fainted) continue;
      alive++;
      hpSum += mon.maxhp > 0 ? mon.hp / mon.maxhp : 0;
      if (!mon.status) healthy++;

      // Resist or immune to opp active's STAB type(s)
      const monTypes = mon.types ?? [];
      let resists = true;
      if (oppStabTypes.length === 0 || monTypes.length === 0) {
        resists = false;
      } else {
        for (const stabType of oppStabTypes) {
          const eff = getTypeEffectiveness(stabType, monTypes);
          if (eff > 1) { resists = false; break; }
        }
        // Must resist ALL stab types (eff <= 1 for each)
        if (resists) {
          // Check at least one is actually resisted (< 1) or immune (0)
          let anyResist = false;
          for (const stabType of oppStabTypes) {
            if (getTypeEffectiveness(stabType, monTypes) < 1) { anyResist = true; break; }
          }
          resists = anyResist;
        }
      }
      if (resists) resistOppStab++;

      // Has a super-effective damaging move vs opp active
      if (oppAct) {
        const oppActTypes = oppAct.types ?? [];
        for (const ms of (mon.moveSlots ?? [])) {
          const md = gen9.moves.get(ms.id);
          if (md && md.category !== 'Status' && md.basePower > 0) {
            if (getTypeEffectiveness(md.type, oppActTypes) > 1) {
              threatenOpp++;
              break;
            }
          }
        }
      }

      // Hazard removal
      for (const ms of (mon.moveSlots ?? [])) {
        if (HAZARD_REMOVAL_MOVES.has(ms.id)) { hasRemoval = 1; break; }
      }
    }

    f[idx++] = alive / 6;
    f[idx++] = hpSum / 6;
    f[idx++] = healthy / 6;
    f[idx++] = resistOppStab / 6;
    f[idx++] = threatenOpp / 6;
    f[idx++] = hasRemoval;
  }

  // ─── G. Speed/priority (6) ─────────────────────────────────────────────────
  const mySideConds = mySide.sideConditions as Record<string, unknown>;
  const oppSideConds = oppSide.sideConditions as Record<string, unknown>;
  const mySpeed = myActive ? effectiveSpeed(myActive, mySideConds) : 0;
  const oppSpeed = oppActive ? effectiveSpeed(oppActive, oppSideConds) : 0;
  const trActive = !!battle.field.pseudoWeather['trickroom'];

  // I outspeed (considering trick room)
  let iOutspeed: boolean;
  if (trActive) {
    iOutspeed = mySpeed < oppSpeed; // In TR, slower wins
  } else {
    iOutspeed = mySpeed > oppSpeed;
  }
  f[idx++] = iOutspeed ? 1 : 0;

  // Speed ratio capped [0,2] / 2
  const speedRatio = oppSpeed > 0 ? Math.min(mySpeed / oppSpeed, 2) : 1;
  f[idx++] = speedRatio / 2;

  // I have a priority damaging move
  let myHasPriority = 0;
  if (myActive) {
    for (const ms of (myActive.moveSlots ?? [])) {
      const md = gen9.moves.get(ms.id);
      if (md && md.priority > 0 && md.category !== 'Status') { myHasPriority = 1; break; }
    }
  }
  f[idx++] = myHasPriority;

  // Opp has a priority damaging move
  let oppHasPriority = 0;
  if (oppActive) {
    for (const ms of (oppActive.moveSlots ?? [])) {
      const md = gen9.moves.get(ms.id);
      if (md && md.priority > 0 && md.category !== 'Status') { oppHasPriority = 1; break; }
    }
  }
  f[idx++] = oppHasPriority;

  // Trick room favors me (TR active AND I am slower)
  f[idx++] = (trActive && mySpeed < oppSpeed) ? 1 : 0;

  // My tailwind active
  f[idx++] = mySideConds['tailwind'] ? 1 : 0;

  // ─── H. Item/ability flags (5 per active × 2 = 10) ─────────────────────────
  for (const active of [myActive, oppActive]) {
    if (!active) {
      idx += 5;
      continue;
    }
    const item = active.item ?? '';
    f[idx++] = CHOICE_ITEMS.has(item) ? 1 : 0;
    f[idx++] = item === 'heavydutyboots' ? 1 : 0;
    f[idx++] = item === 'leftovers' ? 1 : 0;
    f[idx++] = item === 'lifeorb' ? 1 : 0;
    f[idx++] = item === '' ? 1 : 0; // item absent/consumed
  }

  // ─── Final safety: clamp any non-finite values ───────────────────────────────
  for (let i = 0; i < idx; i++) {
    if (!Number.isFinite(f[i])) f[i] = 0;
  }

  // ─── Assert dimension ───────────────────────────────────────────────────────
  if (idx !== FEATURE_DIM) {
    throw new Error(`extractFeatures produced ${idx} features, expected ${FEATURE_DIM}`);
  }

  return f;
}

// ─── Legacy 20-feature extractor (used by net-eval.ts) ────────────────────────

export interface PokemonInfo {
  condition?: string;
  active?: boolean;
}

export interface MoveInfo {
  disabled?: boolean;
}

export interface BattleRequest {
  side?: { pokemon?: PokemonInfo[] };
  active?: Array<{ moves?: MoveInfo[] }>;
  forceSwitch?: unknown;
}

export function parseHpFraction(condition: string | undefined): number {
  if (!condition || condition.includes('fnt')) return 0;
  const parts = condition.split('/');
  if (parts.length < 2) return 0;
  const hp = parseInt(parts[0], 10);
  const maxhp = parseInt(parts[1].trim().split(/\s+/)[0], 10); // '100 brn' -> 100
  if (!Number.isFinite(hp) || !Number.isFinite(maxhp) || maxhp <= 0) return 0;
  return hp / maxhp;
}

export function extractFeatures20(
  myReq: BattleRequest | null | undefined,
  oppReq: BattleRequest | null | undefined,
  turnNum: number,
): Float32Array {
  const f = new Float32Array(20);

  const myMons = myReq?.side?.pokemon ?? [];
  const oppMons = oppReq?.side?.pokemon ?? [];

  // 0-5: my HP fractions
  for (let i = 0; i < 6; i++) {
    f[i] = i < myMons.length ? parseHpFraction(myMons[i].condition) : 0;
  }
  // 6-11: opp HP fractions
  for (let i = 0; i < 6; i++) {
    f[6 + i] = i < oppMons.length ? parseHpFraction(oppMons[i].condition) : 0;
  }

  // 12: my alive count / 6
  let myAlive = 0;
  for (let i = 0; i < 6; i++) { if (f[i] > 0) myAlive++; }
  f[12] = myAlive / 6;

  // 13: opp alive count / 6
  let oppAlive = 0;
  for (let i = 0; i < 6; i++) { if (f[6 + i] > 0) oppAlive++; }
  f[13] = oppAlive / 6;

  // 14: my active HP (default to feature[0], override with active mon's slot)
  f[14] = f[0];
  for (let i = 0; i < myMons.length && i < 6; i++) {
    if (myMons[i].active === true) { f[14] = f[i]; break; }
  }

  // 15: opp active HP (default to feature[6], override with active mon's slot)
  f[15] = f[6];
  for (let i = 0; i < oppMons.length && i < 6; i++) {
    if (oppMons[i].active === true) { f[15] = f[6 + i]; break; }
  }

  // 16: usable moves fraction
  const moves = myReq?.active?.[0]?.moves ?? [];
  let usable = 0;
  for (const m of moves) { if (!m.disabled) usable++; }
  f[16] = moves.length > 0 ? usable / 4 : 0;

  // 17: turn progress
  f[17] = Math.min(turnNum / 100, 1);

  // 18: forceSwitch
  f[18] = myReq?.forceSwitch ? 1 : 0;

  // 19: reserved
  f[19] = 0;

  return f;
}
