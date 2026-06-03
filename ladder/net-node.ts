/**
 * Node.js ONNX wrapper for imitation-dual-v2 model.
 * Uses onnxruntime-node (not web) for server-side inference.
 */
import * as ort from 'onnxruntime-node';

let session: ort.InferenceSession | null = null;

/** Load the ONNX model once at startup. */
export async function loadNet(path: string): Promise<void> {
  session = await ort.InferenceSession.create(path);
}

/** Run inference: input 'state' [1,265] → 'win_probability' scalar + 'policy_logits' [5]. */
export async function evalNet(features: Float32Array): Promise<{ winProb: number; policy: Float32Array }> {
  if (!session) throw new Error('Net not loaded');
  const tensor = new ort.Tensor('float32', features, [1, features.length]);
  const results = await session.run({ state: tensor });
  const winProb = (results['win_probability'].data as Float32Array)[0];
  const policy = new Float32Array(results['policy_logits'].data as Float32Array);
  return { winProb, policy };
}
