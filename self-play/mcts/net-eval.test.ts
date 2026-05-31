import {describe, it, expect} from 'vitest';
import {netValueFn, netPolicyFn} from './net-eval.ts';

/** Minimal stub matching the InferenceSession shape used by infer() */
function makeStubSession() {
  let runCount = 0;
  const session = {
    get runCount() { return runCount; },
    async run(_feeds: Record<string, unknown>) {
      runCount++;
      return {
        policy: {data: new Float32Array([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0])},
        value: {data: new Float32Array([0.5])},
      };
    },
  };
  return session;
}

/** Fake battle state that yields a known feature vector */
function makeState(turn: number) {
  return {
    turn,
    p1: {activeRequest: {pokemon: [{hp: 100, maxhp: 100, moves: ['tackle'], item: 'leftovers', ability: 'overgrow', teraType: 'Normal', status: ''}], active: [{moves: [{id: 'tackle', pp: 35, maxpp: 35}]}]}},
    p2: {activeRequest: {pokemon: [{hp: 80, maxhp: 100, moves: ['ember'], item: 'charcoal', ability: 'blaze', teraType: 'Fire', status: ''}], active: [{moves: [{id: 'ember', pp: 25, maxpp: 25}]}]}},
  };
}

describe('net-eval cache', () => {
  it('deduplicates infer calls for same feature vector across value+policy', async () => {
    const session = makeStubSession();
    // Cast through unknown to satisfy ort.InferenceSession type without `as any`
    const valueFn = netValueFn(session as unknown as Parameters<typeof netValueFn>[0]);
    const policyFn = netPolicyFn(session as unknown as Parameters<typeof netPolicyFn>[0], 'p1');

    const state = makeState(5);
    await valueFn(state);
    await policyFn(state);

    // Same feature vector → only 1 ORT run call
    expect(session.runCount).toBe(1);
  });

  it('calls run again for a different feature vector', async () => {
    const session = makeStubSession();
    const valueFn = netValueFn(session as unknown as Parameters<typeof netValueFn>[0]);

    await valueFn(makeState(5));
    await valueFn(makeState(99)); // different turn → different features

    expect(session.runCount).toBe(2);
  });
});
