/**
 * Offscreen document script — hosts the eval Web Worker.
 * Receives EVAL_REQUEST from service worker, forwards to worker, relays results back.
 */

import type { EvalRequest, EvalResult } from '../src/types';

const worker = new Worker(chrome.runtime.getURL('eval/eval-worker.js'), { type: 'module' });

chrome.runtime.onMessage.addListener(
  (msg: { type: string; payload: EvalRequest; tabId: number }, _sender, sendResponse) => {
    if (msg.type !== 'OFFSCREEN_EVAL') return false;

    const handler = (e: MessageEvent<EvalResult>) => {
      worker.removeEventListener('message', handler);
      sendResponse({ type: 'EVAL_RESULT', payload: e.data });
    };

    worker.addEventListener('message', handler);
    worker.postMessage(msg.payload);

    return true; // async response
  }
);

console.log('[randbats-bot] Offscreen eval host ready');
