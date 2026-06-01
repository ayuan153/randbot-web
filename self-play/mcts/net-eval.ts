import * as ort from 'onnxruntime-node';
import type {PolicyFn, ValueFn} from './ismcts.ts';
import {extractFeatures, FEATURE_DIM} from './net-features.ts';
import type {Battle} from '@pkmn/sim';

const ACTION_FOR_IDX = ['move 1','move 2','move 3','move 4','switch 1','switch 2','switch 3','switch 4','switch 5','switch 6'];

export async function loadNet(path: string): Promise<ort.InferenceSession> {
  return ort.InferenceSession.create(path);
}

/** Session-scoped cache: the net is deterministic so identical feature vectors always produce identical outputs. */
const NET_CACHE = new WeakMap<ort.InferenceSession, Map<string, {policy: Float32Array; value: number}>>();

async function infer(session: ort.InferenceSession, feats: Float32Array): Promise<{policy: Float32Array; value: number}> {
  const key = feats.join(',');
  let cache = NET_CACHE.get(session);
  if (!cache) { cache = new Map(); NET_CACHE.set(session, cache); }
  const hit = cache.get(key);
  if (hit) return hit;
  const out = await session.run({features: new ort.Tensor('float32', feats, [1, FEATURE_DIM])});
  const result = {policy: out['policy'].data as Float32Array, value: (out['value'].data as Float32Array)[0]};
  cache.set(key, result);
  return result;
}

// p1-perspective value in [0,1] (drop-in for heuristicValue)
export function netValueFn(session: ort.InferenceSession): ValueFn {
  return async (state) => {
    const b = state as Battle;
    const feats = extractFeatures(b, 'p1');
    const {value} = await infer(session, feats);
    return Math.min(0.99, Math.max(0.01, (value + 1) / 2));
  };
}

// priors over the acting side's actions (drop-in for ()=>uniformPolicy)
export function netPolicyFn(session: ort.InferenceSession, perspective: 'p1' | 'p2'): PolicyFn {
  return async (state) => {
    const b = state as Battle;
    const feats = extractFeatures(b, perspective);
    const {policy} = await infer(session, feats);
    const m = new Map<string, number>();
    for (let i = 0; i < 10; i++) m.set(ACTION_FOR_IDX[i], policy[i]);
    return m;
  };
}
