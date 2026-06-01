import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';
import {describe, it, expect} from 'vitest';
import {Battle, Teams, toID} from '@pkmn/sim';
import {TeamGenerators} from '@pkmn/randoms';
import {extractFeatures, extractFeatures20, FEATURE_DIM, BattleRequest} from './net-features.ts';

Teams.setGeneratorFactory(TeamGenerators);

// ─── Legacy extractFeatures20 parity tests (preserved) ───────────────────────

const dir = dirname(fileURLToPath(import.meta.url));
const cases = JSON.parse(readFileSync(join(dir, '__fixtures__', 'feature-parity.json'), 'utf8')) as Array<{
  request: BattleRequest;
  oppRequest: BattleRequest;
  turn: number;
  expected: number[];
}>;

describe('extractFeatures20 parity with Python', () => {
  cases.forEach((c, idx) => {
    it(`case ${idx}: turn ${c.turn}`, () => {
      const result = extractFeatures20(c.request, c.oppRequest, c.turn);
      expect(result.length).toBe(20);
      for (let k = 0; k < 20; k++) {
        expect(result[k]).toBeCloseTo(c.expected[k], 5);
      }
    });
  });
});

// ─── extractFeatures (225-dim) tests ──────────────────────────────────────────

function createTestBattle(): Battle {
  const battle = new Battle({formatid: toID('gen9randombattle')});
  battle.setPlayer('p1', {name: 'Bot1'});
  battle.setPlayer('p2', {name: 'Bot2'});
  return battle;
}

describe('extractFeatures (225-dim)', () => {
  it('produces correct length for both sides', () => {
    const battle = createTestBattle();
    const f1 = extractFeatures(battle, 'p1');
    const f2 = extractFeatures(battle, 'p2');
    expect(f1.length).toBe(FEATURE_DIM);
    expect(f2.length).toBe(FEATURE_DIM);
  });

  it('all values are finite and within [-1, 1]', () => {
    const battle = createTestBattle();
    const f = extractFeatures(battle, 'p1');
    for (let i = 0; i < f.length; i++) {
      expect(Number.isFinite(f[i])).toBe(true);
      expect(f[i]).toBeGreaterThanOrEqual(-1);
      expect(f[i]).toBeLessThanOrEqual(1);
    }
  });

  it('is deterministic (same battle => identical vector)', () => {
    const battle = createTestBattle();
    const f1 = extractFeatures(battle, 'p1');
    const f2 = extractFeatures(battle, 'p1');
    expect(f1).toEqual(f2);
  });

  it('weather 1-hot flips when weather is set', () => {
    const battle = createTestBattle();
    // No weather initially — idx 0 (none) should be 1
    const fNone = extractFeatures(battle, 'p1');
    expect(fNone[0]).toBe(1); // none
    expect(fNone[1]).toBe(0); // sun
    expect(fNone[2]).toBe(0); // rain

    // Set sun
    battle.field.weather = 'sunnyday' as Battle['field']['weather'];
    battle.field.weatherState = {id: 'sunnyday', source: null, duration: 5, effectOrder: 0} as Battle['field']['weatherState'];
    const fSun = extractFeatures(battle, 'p1');
    expect(fSun[0]).toBe(0); // none
    expect(fSun[1]).toBe(1); // sun
    expect(fSun[5]).toBeCloseTo(5 / 8); // weather turns/8
  });

  it('stealth rock side condition sets group B bit', () => {
    const battle = createTestBattle();
    // Group B starts at idx 15 (after A=15). My side first.
    const fBefore = extractFeatures(battle, 'p1');
    expect(fBefore[15]).toBe(0); // no SR

    // Set stealth rock on my side
    (battle.p1.sideConditions as Record<string, unknown>)['stealthrock'] = {id: 'stealthrock', level: 1, effectOrder: 0};
    const fAfter = extractFeatures(battle, 'p1');
    expect(fAfter[15]).toBe(1); // SR present
  });

  it('active boost is reflected in the vector', () => {
    const battle = createTestBattle();
    const active = battle.p1.active[0];
    if (!active) return;

    // Group C my active starts at idx 33 (A=15, B=18). HP(1) + status(7) + counter(1) = 9, then boosts start.
    // Boost atk is at offset 33 + 9 = 42
    const boostStart = 15 + 18 + 1 + 7 + 1; // = 42
    const fBefore = extractFeatures(battle, 'p1');
    expect(fBefore[boostStart]).toBe(0); // atk boost = 0

    active.boosts.atk = 2;
    const fAfter = extractFeatures(battle, 'p1');
    expect(fAfter[boostStart]).toBeCloseTo(2 / 6);
  });

  it('HP fraction is correctly encoded', () => {
    const battle = createTestBattle();
    const active = battle.p1.active[0];
    if (!active) return;

    // HP frac is at idx 33 (start of group C my active)
    const hpIdx = 15 + 18; // = 33
    active.hp = active.maxhp; // full HP
    const fFull = extractFeatures(battle, 'p1');
    expect(fFull[hpIdx]).toBeCloseTo(1);

    active.hp = Math.floor(active.maxhp / 2);
    const fHalf = extractFeatures(battle, 'p1');
    expect(fHalf[hpIdx]).toBeCloseTo(0.5, 1);
  });
});

// ─── Regression tests: non-finite features & simulated state robustness ───────

describe('extractFeatures robustness (regression)', () => {
  it('produces all-finite values in [-1,1] across a multi-turn game', () => {
    const battle = createTestBattle();
    // Play several turns with random moves
    for (let turn = 0; turn < 20 && !battle.ended; turn++) {
      const p1Req = battle.p1.activeRequest;
      const p2Req = battle.p2.activeRequest;
      if (!p1Req && !p2Req) break;

      // Extract features at each decision point
      const f1 = extractFeatures(battle, 'p1');
      const f2 = extractFeatures(battle, 'p2');
      for (let i = 0; i < FEATURE_DIM; i++) {
        expect(Number.isFinite(f1[i])).toBe(true);
        expect(f1[i]).toBeGreaterThanOrEqual(-1);
        expect(f1[i]).toBeLessThanOrEqual(1);
        expect(Number.isFinite(f2[i])).toBe(true);
        expect(f2[i]).toBeGreaterThanOrEqual(-1);
        expect(f2[i]).toBeLessThanOrEqual(1);
      }

      // Make random choices to advance the battle
      if (p1Req && !(p1Req as {wait?: boolean}).wait) battle.choose('p1', 'default');
      if (p2Req && !(p2Req as {wait?: boolean}).wait) battle.choose('p2', 'default');
    }
  });

  it('does not throw on a cloned/determinized mid-game state', () => {
    const battle = createTestBattle();
    // Advance a few turns
    for (let turn = 0; turn < 5 && !battle.ended; turn++) {
      const p1Req = battle.p1.activeRequest;
      const p2Req = battle.p2.activeRequest;
      if (!p1Req && !p2Req) break;
      if (p1Req && !(p1Req as {wait?: boolean}).wait) battle.choose('p1', 'default');
      if (p2Req && !(p2Req as {wait?: boolean}).wait) battle.choose('p2', 'default');
    }

    // Clone via JSON (same as BattleAdapter.clone())
    const cloned = Battle.fromJSON(JSON.stringify(battle.toJSON()));

    // extractFeatures must not throw on the cloned state
    const f1 = extractFeatures(cloned, 'p1');
    const f2 = extractFeatures(cloned, 'p2');
    expect(f1.length).toBe(FEATURE_DIM);
    expect(f2.length).toBe(FEATURE_DIM);
    for (let i = 0; i < FEATURE_DIM; i++) {
      expect(Number.isFinite(f1[i])).toBe(true);
      expect(Number.isFinite(f2[i])).toBe(true);
    }
  });

  it('handles fainted active (hp=0) without non-finite values', () => {
    const battle = createTestBattle();
    const active = battle.p1.active[0];
    if (!active) return;
    // Simulate a fainted active mon
    active.hp = 0;
    active.fainted = true;

    const f = extractFeatures(battle, 'p1');
    expect(f.length).toBe(FEATURE_DIM);
    for (let i = 0; i < FEATURE_DIM; i++) {
      expect(Number.isFinite(f[i])).toBe(true);
    }
  });
});
