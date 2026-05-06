/**
 * Learned evaluation using ONNX Runtime Web.
 * Loads a trained value network and returns win probability for a given state.
 */

import * as ort from 'onnxruntime-web';
import type { BattleSnapshot } from '../types';
import { extractFeatures } from './features';

let session: ort.InferenceSession | null = null;

export async function loadModel(modelUrl: string): Promise<void> {
  session = await ort.InferenceSession.create(modelUrl);
}

export function isModelLoaded(): boolean {
  return session !== null;
}

export async function evaluateWithModel(snapshot: BattleSnapshot): Promise<number> {
  if (!session) throw new Error('Model not loaded');
  const features = extractFeatures(snapshot);
  const tensor = new ort.Tensor('float32', features, [1, features.length]);
  const results = await session.run({ state: tensor });
  const output = results['win_probability'];
  return (output.data as Float32Array)[0];
}
