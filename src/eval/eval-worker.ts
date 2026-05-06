/**
 * Eval Web Worker — receives EvalRequest, runs minimax, returns EvalResult.
 * Runs off the main thread to keep UI responsive.
 *
 * If evalMode is 'ml' and an ONNX model is available, scores each action
 * by running the model on the resulting state. Falls back to heuristic minimax
 * if no model is present or evalMode is 'heuristic'.
 */

import type { EvalRequest, EvalResult, ScoredOption } from '../types';
import { search } from './minimax';
import { loadModel, isModelLoaded, evaluateWithModel } from './learned-eval';
import { extractFeatures } from './features';

// Attempt to load the ONNX model on worker init (graceful if missing)
const MODEL_PATH = 'models/value-net-v1.onnx';

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
    // Use learned evaluation: score the current snapshot directly
    const winProb = await evaluateWithModel(request.snapshot);
    // For ML mode, return a single evaluation of the position
    // The minimax still uses heuristic; ML provides a position score overlay
    options = search(request.snapshot, request.opponentModel, request.config);
    // Attach ML win probability as metadata on the top option
    if (options.length > 0) {
      options[0].breakdown.positionalScore = winProb;
    }
  } else {
    options = search(request.snapshot, request.opponentModel, request.config);
  }

  const result: EvalResult = {
    roomId: request.snapshot.roomId,
    turn: request.snapshot.turn,
    options,
    elapsedMs: Date.now() - startTime,
  };

  self.postMessage(result);
};
