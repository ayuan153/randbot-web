/**
 * Service worker — routes eval requests through offscreen document.
 * MV3 service workers can't use new Worker(), so we delegate to an offscreen doc.
 */

import type { ExtensionMessage, EvalRequest, EvalResult, ScoredOption } from '../types';

const OFFSCREEN_URL = 'offscreen/eval.html';
let creating: Promise<void> | null = null;

/** Ensure the offscreen document exists (creates it if needed) */
async function ensureOffscreen(): Promise<void> {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)],
  });
  if (contexts.length > 0) return;

  if (!creating) {
    creating = chrome.offscreen.createDocument({
      url: OFFSCREEN_URL,
      reasons: [chrome.offscreen.Reason.WORKERS],
      justification: 'Spawn eval Web Worker for minimax search',
    });
  }
  await creating;
  creating = null;
}

/** Run eval through the offscreen document's worker */
async function runEval(request: EvalRequest, tabId: number): Promise<EvalResult> {
  try {
    await ensureOffscreen();
    const response = await chrome.runtime.sendMessage({
      type: 'OFFSCREEN_EVAL',
      payload: request,
      tabId,
    });
    if (response?.type === 'EVAL_RESULT') {
      return response.payload as EvalResult;
    }
    return placeholderEval(request);
  } catch {
    return placeholderEval(request);
  }
}

/** Fallback placeholder scoring */
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

chrome.runtime.onMessage.addListener(
  (msg: ExtensionMessage, sender, sendResponse) => {
    if (msg.type === 'EVAL_REQUEST') {
      const tabId = sender.tab?.id ?? 0;
      runEval(msg.payload, tabId).then((result) => {
        sendResponse({ type: 'EVAL_RESULT', payload: result });
      });
      return true;
    }
    return false;
  }
);

console.log('[randbats-bot] Service worker loaded');
