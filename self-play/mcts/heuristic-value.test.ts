import {describe, it, expect} from 'vitest';
import {heuristicValue} from './heuristic-value.ts';

const mk = (p1hp: number[], p2hp: number[]) =>
  ({p1: {pokemon: p1hp.map(h => ({hp: h, maxhp: 100}))}, p2: {pokemon: p2hp.map(h => ({hp: h, maxhp: 100}))}}) as unknown;

describe('heuristicValue', () => {
  it('returns > 0.5 when p1 is ahead', () => {
    expect(heuristicValue(mk([100, 100, 100], [1, 1, 1]))).toBeGreaterThan(0.5);
  });

  it('returns ~0.5 when symmetric', () => {
    expect(heuristicValue(mk([80, 80], [80, 80]))).toBeCloseTo(0.5);
  });

  it('returns clamped low value when p1 is wiped', () => {
    const v = heuristicValue(mk([0, 0, 0], [100, 100, 100]));
    expect(v).toBeLessThan(0.5);
    expect(v).toBeLessThanOrEqual(0.99);
  });

  it('clamps upper bound when p2 is wiped', () => {
    const v = heuristicValue(mk([100, 100, 100], [0, 0, 0]));
    expect(v).toBeLessThanOrEqual(0.99);
    expect(v).toBeGreaterThan(0.5);
  });
});
