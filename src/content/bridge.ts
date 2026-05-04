/**
 * Content script (ISOLATED world).
 * Injects hook.ts into page, relays messages, mounts overlay UI.
 */

import type { EvalResult } from '../types';
import { mountOverlay } from '../ui/overlay';

const HOOK_SOURCE = 'randbats-bot-hook';

/** Default eval config */
const DEFAULT_CONFIG = {
  depth: 2,
  topN: 5,
  timeLimitMs: 2000,
  evalMode: 'heuristic' as const,
};

/** Inject the page-world hook script */
function injectHook() {
  const script = document.createElement('script');
  script.src = chrome.runtime.getURL('src/inject/hook.ts');
  script.type = 'module';
  (document.head || document.documentElement).appendChild(script);
  script.onload = () => script.remove();
}

/** Handle eval result — update overlay */
function handleResult(result: EvalResult, updateOverlay: ReturnType<typeof mountOverlay>) {
  updateOverlay(result.options, result.turn, result.elapsedMs);
}

/** Listen for messages from the injected hook */
function listenForHookMessages(updateOverlay: ReturnType<typeof mountOverlay>) {
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    if (event.data?.source !== HOOK_SOURCE) return;

    const msg = event.data;

    if (msg.type === 'PS_TURN_REQUEST') {
      const evalRequest = {
        type: 'EVAL_REQUEST' as const,
        payload: {
          snapshot: msg.snapshot,
          opponentModel: { pokemon: [], unrevealed: 6 },
          config: DEFAULT_CONFIG,
        },
      };

      chrome.runtime.sendMessage(evalRequest, (response) => {
        if (response?.type === 'EVAL_RESULT') {
          handleResult(response.payload, updateOverlay);
        }
      });
    }
  });
}

/** Listen for pushed messages from service worker */
function listenForSwMessages(updateOverlay: ReturnType<typeof mountOverlay>) {
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'EVAL_RESULT') {
      handleResult(msg.payload, updateOverlay);
    }
  });
}

// Boot
injectHook();
const updateOverlay = mountOverlay();
listenForHookMessages(updateOverlay);
listenForSwMessages(updateOverlay);
console.log('[randbats-bot] Content script loaded');
