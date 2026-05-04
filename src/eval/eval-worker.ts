/**
 * Eval Web Worker — receives EvalRequest, runs minimax, returns EvalResult.
 * Runs off the main thread to keep UI responsive.
 */

import type { EvalRequest, EvalResult } from '../types';
import { search } from './minimax';

self.onmessage = (event: MessageEvent<EvalRequest>) => {
  const request = event.data;
  const startTime = Date.now();

  const options = search(request.snapshot, request.opponentModel, request.config);

  const result: EvalResult = {
    roomId: request.snapshot.roomId,
    turn: request.snapshot.turn,
    options,
    elapsedMs: Date.now() - startTime,
  };

  self.postMessage(result);
};
