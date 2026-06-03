/**
 * Eval Web Worker — receives EvalRequest, runs minimax, returns EvalResult.
 * Runs off the main thread to keep UI responsive.
 *
 * If evalMode is 'ml' and an ONNX model is available, scores each action
 * by running the model on the resulting state. Falls back to heuristic minimax
 * if no model is present or evalMode is 'heuristic'.
 */

import type { EvalRequest, EvalResult, ScoredOption, BattleSnapshot } from '../types';
import { search } from './minimax';
import { evaluate } from './scoring';
import { loadModel, isModelLoaded, evaluateWithModel, evaluateWithPolicy } from './learned-eval';
import { blendPolicyPrior, buildMoveSortOrder } from './policy-prior';

// Attempt to load the ONNX model on worker init (graceful if missing)
const MODEL_PATH = 'models/imitation-dual-v2.onnx';
// ML leaf eval blends the net (rescaled win-prob) with the heuristic. The net is
// trained on real game states; minimax leaves are approximate (avg-damage) sims,
// so blending guards against the net being out-of-distribution on them.
const ML_BLEND = 0.5;
// Policy prior blend weight: β=0.7 means 70% search, 30% policy head.
const POLICY_BLEND = 0.7;

async function initModel(): Promise<void> {
  try {
    // In extension context, resolve relative to extension root
    const url = typeof globalThis !== 'undefined' && 'chrome' in globalThis
      ? (globalThis as unknown as { chrome: typeof chrome }).chrome.runtime.getURL(MODEL_PATH)
      : MODEL_PATH;
    await loadModel(url);
    console.log('[randbats-bot] ONNX model loaded successfully');
  } catch {
    console.log('[randbats-bot] No ONNX model found, using heuristic eval');
  }
}

const modelReady = initModel();

self.onmessage = async (event: MessageEvent<EvalRequest>) => {
  await modelReady;

  const request = event.data;
  const startTime = Date.now();

  let options: ScoredOption[];

  if (request.config.evalMode === 'ml' && isModelLoaded()) {
    // Net now DRIVES the search: each leaf is scored by a blend of the learned
    // value net (win-prob rescaled to [-1,1]) and the heuristic.
    const leafEval = async (s: BattleSnapshot): Promise<number> => {
      const winProb = await evaluateWithModel(s);
      return ML_BLEND * (winProb * 2 - 1) + (1 - ML_BLEND) * evaluate(s);
    };
    options = await search(request.snapshot, request.opponentModel, request.config, leafEval);
    // Single root inference: get both win-prob and policy logits
    const { winProb, policy } = await evaluateWithPolicy(request.snapshot);
    // Surface root win-prob on the top option for the dev overlay.
    if (options.length > 0) {
      options[0].breakdown.positionalScore = winProb;
    }
    // Blend policy prior into the ranking
    const moveSortOrder = buildMoveSortOrder(request.snapshot.player.active.moves);
    options = blendPolicyPrior(options, policy, moveSortOrder, POLICY_BLEND);
  } else {
    options = await search(request.snapshot, request.opponentModel, request.config);
  }

  const result: EvalResult = {
    roomId: request.snapshot.roomId,
    turn: request.snapshot.turn,
    options,
    elapsedMs: Date.now() - startTime,
  };

  self.postMessage(result);
};
