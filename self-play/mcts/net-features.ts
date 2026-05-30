/**
 * net-features.ts — 20-feature extractor mirroring Python training code.
 * Reads from Showdown request objects (not Battle).
 */

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
