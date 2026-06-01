import {describe, it, expect, vi} from 'vitest';

// Mock extractFeatures to return a deterministic vector based on the battle state
vi.mock('./net-features.ts', () => ({
  FEATURE_DIM: 225,
  extractFeatures: (battle: {turn: number}, _side: string) => {
    // Return a unique vector per turn number so cache tests work
    const f = new Float32Array(225);
    f[0] = battle.turn;
    return f;
  },
}));

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

/** Fake battle state — extractFeatures is mocked so only `turn` matters */
function makeState(turn: number) {
  return {turn};
}

describe('net-eval cache', () => {
  it('deduplicates infer calls for same feature vector across value+policy', async () => {
    const session = makeStubSession();
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
