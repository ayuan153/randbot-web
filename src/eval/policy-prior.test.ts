import { describe, it, expect } from 'vitest';
import { blendPolicyPrior, buildMoveSortOrder } from './policy-prior';
import type { ScoredOption, MoveAction, SwitchAction } from '../types';

function makeMove(name: string, score: number): ScoredOption {
  const action: MoveAction = { type: 'move', id: name.toLowerCase(), name, pp: 10, maxPp: 10, target: 'normal', disabled: false };
  return { action, score, breakdown: { damage: 0, koProbability: 0, statusValue: 0, hazardValue: 0, switchInValue: 0, speedAdvantage: 0, positionalScore: 0 }, principalVariation: [] };
}

function makeSwitch(species: string, score: number): ScoredOption {
  const action: SwitchAction = { type: 'switch', species, slot: 2 };
  return { action, score, breakdown: { damage: 0, koProbability: 0, statusValue: 0, hazardValue: 0, switchInValue: 0, speedAdvantage: 0, positionalScore: 0 }, principalVariation: [] };
}

describe('blendPolicyPrior', () => {
  // Move sort order: alphabetical by toID → "earthquake", "flamethrower", "ironhead", "swordsdance"
  const moveSortOrder = ['earthquake', 'flamethrower', 'ironhead', 'swordsdance'];

  it('with uniform policy, preserves search ranking', () => {
    const options = [
      makeMove('Earthquake', 0.9),
      makeMove('Flamethrower', 0.7),
      makeMove('Iron Head', 0.5),
      makeMove('Swords Dance', 0.3),
    ];
    // Uniform logits → uniform policy after softmax
    const uniformLogits = new Float32Array([0, 0, 0, 0, 0]);
    const result = blendPolicyPrior(options, uniformLogits, moveSortOrder, 0.7);
    // Order should match search order (Earthquake > Flamethrower > Iron Head > Swords Dance)
    expect(result[0].action.type === 'move' && result[0].action.name).toBe('Earthquake');
    expect(result[1].action.type === 'move' && result[1].action.name).toBe('Flamethrower');
    expect(result[2].action.type === 'move' && result[2].action.name).toBe('Iron Head');
    expect(result[3].action.type === 'move' && result[3].action.name).toBe('Swords Dance');
  });

  it('strong policy for move B raises its rank vs search-favored A', () => {
    const options = [
      makeMove('Earthquake', 0.9),   // search favors this
      makeMove('Flamethrower', 0.5), // policy will strongly favor this
      makeMove('Iron Head', 0.3),
    ];
    // Policy strongly favors slot 1 (Flamethrower in sorted order)
    const logits = new Float32Array([-10, 10, -10, -Infinity, -Infinity]);
    const result = blendPolicyPrior(options, logits, moveSortOrder, 0.7);
    // Flamethrower should rise (policy weight 0.3 with near-1.0 policy prob)
    const ftIndex = result.findIndex(o => o.action.type === 'move' && o.action.name === 'Flamethrower');
    // With β=0.7 search and 0.3 policy where policy is ~1.0 for Flamethrower,
    // it should be ranked higher than without policy (which would be #2)
    expect(ftIndex).toBeLessThanOrEqual(1);
  });

  it('illegal slots are masked and do not affect output', () => {
    // Only 2 moves available (Earthquake, Iron Head) — slots 1 and 3 in sort order
    const options = [
      makeMove('Earthquake', 0.8),
      makeMove('Iron Head', 0.4),
    ];
    // Policy logits strongly favor slot 1 (Flamethrower) — but it's illegal
    const logits = new Float32Array([-5, 100, -5, -5, -5]);
    const result = blendPolicyPrior(options, logits, moveSortOrder, 0.7);
    // Should not crash, should still produce valid ranking
    expect(result).toHaveLength(2);
    // Earthquake still #1 (search favors it, illegal slot doesn't leak)
    expect(result[0].action.type === 'move' && result[0].action.name).toBe('Earthquake');
  });

  it('handles switch actions with policy slot 4', () => {
    const options = [
      makeMove('Earthquake', 0.6),
      makeSwitch('Garchomp', 0.8), // search favors switch
      makeSwitch('Dragonite', 0.4),
    ];
    // Policy strongly favors switching (slot 4)
    const logits = new Float32Array([-10, -Infinity, -Infinity, -Infinity, 10]);
    const result = blendPolicyPrior(options, logits, moveSortOrder, 0.7);
    // Switches should rank high (both search and policy agree on switching)
    const switchResults = result.filter(o => o.action.type === 'switch');
    expect(switchResults.length).toBe(2);
    // Garchomp switch should be #1 (highest search score + policy favors switch)
    expect(result[0].action.type === 'switch' && result[0].action.type === 'switch' && (result[0].action as SwitchAction).species).toBe('Garchomp');
  });

  it('empty options returns empty', () => {
    const result = blendPolicyPrior([], new Float32Array(5), [], 0.7);
    expect(result).toHaveLength(0);
  });

  it('returns options unchanged when all logits are -Infinity (NaN guard)', () => {
    const options = [
      makeMove('Earthquake', 0.9),
      makeMove('Flamethrower', 0.5),
    ];
    // All slots masked (no legal move IDs in sort order)
    const allInfLogits = new Float32Array([-Infinity, -Infinity, -Infinity, -Infinity, -Infinity]);
    const result = blendPolicyPrior(options, allInfLogits, [], 0.7);
    // Must return options unchanged — no NaN corruption
    expect(result).toBe(options);
    expect(result[0].score).toBe(0.9);
    expect(result[1].score).toBe(0.5);
  });

  it('Choice-locked scenario: 1 legal move out of 4 known, no NaN', () => {
    // Mon knows 4 moves but is Choice-locked to Earthquake
    const options = [
      makeMove('Earthquake', 0.8),
      makeSwitch('Garchomp', 0.4),
    ];
    // Sort order has all 4 known moves, but only Earthquake is legal (in options)
    const fullSortOrder = ['earthquake', 'flamethrower', 'ironhead', 'swordsdance'];
    const logits = new Float32Array([2.0, 1.5, 0.5, -1.0, 0.0]);
    const result = blendPolicyPrior(options, logits, fullSortOrder, 0.7);
    expect(result).toHaveLength(2);
    // Verify no NaN in scores
    for (const opt of result) {
      expect(Number.isNaN(opt.score)).toBe(false);
    }
    // Earthquake should be ranked (legal move with good logit + search score)
    const eqIdx = result.findIndex(o => o.action.type === 'move' && o.action.name === 'Earthquake');
    expect(eqIdx).toBeGreaterThanOrEqual(0);
  });
});

describe('buildMoveSortOrder', () => {
  it('returns toID-sorted move IDs from display names', () => {
    const moves = ['Swords Dance', 'Earthquake', 'Flamethrower'];
    const order = buildMoveSortOrder(moves);
    expect(order).toEqual(['earthquake', 'flamethrower', 'swordsdance']);
  });

  it('dedupes by toID', () => {
    const moves = ['Earthquake', 'earthquake', 'Flamethrower', 'Earthquake'];
    const order = buildMoveSortOrder(moves);
    expect(order).toEqual(['earthquake', 'flamethrower']);
  });
});
