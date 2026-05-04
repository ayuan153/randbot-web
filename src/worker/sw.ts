/**
 * Service worker — routes messages between content script and eval worker.
 * Manages eval worker lifecycle.
 */

import type { ExtensionMessage, EvalRequest, EvalResult, ScoredOption } from '../types';

/** Placeholder scoring (used when eval worker isn't available) */
function placeholderEval(request: EvalRequest): EvalResult {
  const options: ScoredOption[] = request.snapshot.availableActions.map((action, i) => ({
    action,
    score: 1 / (i + 1),
    breakdown: {
      damage: 0, koProbability: 0, statusValue: 0,
      hazardValue: 0, switchInValue: 0, speedAdvantage: 0, positionalScore: 0,
    },
    principalVariation: [],
  }));

  return {
    roomId: request.snapshot.roomId,
    turn: request.snapshot.turn,
    options,
    elapsedMs: 0,
  };
}

/**
 * Attempt to run eval in a Web Worker.
 * Falls back to placeholder if worker creation fails (MV3 service worker limitation).
 */
async function runEval(request: EvalRequest): Promise<EvalResult> {
  try {
    // In MV3 service workers, we can't use `new Worker()` directly.
    // Use offscreen document or fall back to synchronous eval.
    // For now, use placeholder until offscreen document is wired.
    // TODO: Create offscreen document with eval worker for real computation
    return placeholderEval(request);
  } catch {
    return placeholderEval(request);
  }
}

chrome.runtime.onMessage.addListener(
  (msg: ExtensionMessage, _sender, sendResponse) => {
    if (msg.type === 'EVAL_REQUEST') {
      runEval(msg.payload).then((result) => {
        sendResponse({ type: 'EVAL_RESULT', payload: result });
      });
      // Return true for async sendResponse
      return true;
    }
    return false;
  }
);

console.log('[randbats-bot] Service worker loaded');
