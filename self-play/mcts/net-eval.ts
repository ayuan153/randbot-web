import * as ort from 'onnxruntime-node';
import type {PolicyFn, ValueFn} from './ismcts.ts';
import {extractFeatures20, type BattleRequest} from './net-features.ts';

const ACTION_FOR_IDX = ['move 1','move 2','move 3','move 4','switch 1','switch 2','switch 3','switch 4','switch 5','switch 6'];

interface BattleState { turn: number; p1: {activeRequest?: BattleRequest | null}; p2: {activeRequest?: BattleRequest | null}; }

export async function loadNet(path: string): Promise<ort.InferenceSession> {
  return ort.InferenceSession.create(path);
}

async function infer(session: ort.InferenceSession, feats: Float32Array): Promise<{policy: Float32Array; value: number}> {
  const out = await session.run({features: new ort.Tensor('float32', feats, [1, 20])});
  return {policy: out['policy'].data as Float32Array, value: (out['value'].data as Float32Array)[0]};
}

// p1-perspective value in [0,1] (drop-in for heuristicValue)
export function netValueFn(session: ort.InferenceSession): ValueFn {
  return async (state) => {
    const b = state as BattleState;
    const feats = extractFeatures20(b.p1.activeRequest, b.p2.activeRequest, b.turn);
    const {value} = await infer(session, feats);
    return Math.min(0.99, Math.max(0.01, (value + 1) / 2));
  };
}

// priors over the acting side's actions (drop-in for ()=>uniformPolicy)
export function netPolicyFn(session: ort.InferenceSession, perspective: 'p1' | 'p2'): PolicyFn {
  return async (state) => {
    const b = state as BattleState;
    const myReq = perspective === 'p1' ? b.p1.activeRequest : b.p2.activeRequest;
    const oppReq = perspective === 'p1' ? b.p2.activeRequest : b.p1.activeRequest;
    const {policy} = await infer(session, extractFeatures20(myReq, oppReq, b.turn));
    const m = new Map<string, number>();
    for (let i = 0; i < 10; i++) m.set(ACTION_FOR_IDX[i], policy[i]);
    return m;
  };
}
