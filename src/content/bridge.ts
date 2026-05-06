/**
 * Content script (ISOLATED world).
 * Injects hook.ts into page, relays messages, tracks opponent model, mounts overlay UI.
 */

import type { BattleSnapshot } from '../types';
import { loadSetsDb, isLoaded } from '../state/sets-db';
import { mountOverlay } from '../ui/overlay';
import {
  trackProtocol,
  trackSwitch,
  roomOpponentPrefix,
  replayBufferedProtocol,
} from './protocol-tracker';
import {
  processTurnRequest,
  handleResult,
  downloadLog,
  replayPendingTurnRequests,
  accumulateProtocol,
  bufferTurnRequest,
} from './battle-session';

const HOOK_SOURCE = 'randbats-bot-hook';

// ─── Boot ───────────────────────────────────────────────────────

function injectHook() {
  const script = document.createElement('script');
  script.src = chrome.runtime.getURL('inject/hook.js');
  script.type = 'module';
  (document.head || document.documentElement).appendChild(script);
  script.onload = () => script.remove();
}

function listenForHookMessages(updateOverlay: ReturnType<typeof mountOverlay>) {
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    if (event.data?.source !== HOOK_SOURCE) return;

    const msg = event.data;

    if (msg.type === 'PS_PROTOCOL_MSG') {
      // Accumulate protocol lines for turn logging
      const lines = msg.raw.split('\n').filter((l: string) => l.length > 0);
      accumulateProtocol(msg.roomId, lines);

      // Parse |request| FIRST to determine which side we are before processing other lines
      if (!roomOpponentPrefix.has(msg.roomId)) {
        const reqLine = msg.raw.split('\n').find((l: string) => l.startsWith('|request|'));
        if (reqLine) {
          try {
            const reqJson = JSON.parse(reqLine.slice('|request|'.length));
            const mySideId = reqJson.side?.id;
            if (mySideId === 'p1') roomOpponentPrefix.set(msg.roomId, 'p2');
            else if (mySideId === 'p2') roomOpponentPrefix.set(msg.roomId, 'p1');
          } catch { /* ignore parse errors */ }
        }
      }
      // Only process protocol if we know which side is the opponent
      // trackSwitch and trackProtocol will early-return if prefix is unknown
      trackSwitch(msg.raw, msg.roomId);
      trackProtocol(msg.roomId, msg.raw);
    }

    if (msg.type === 'PS_TURN_REQUEST') {
      if (!isLoaded()) {
        bufferTurnRequest(msg.snapshot);
        return;
      }
      processTurnRequest(msg.snapshot, updateOverlay);
    }
  });
}

function listenForSwMessages(updateOverlay: ReturnType<typeof mountOverlay>) {
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'EVAL_RESULT') {
      handleResult(msg.payload, updateOverlay);
    }
  });
}

injectHook();
const updateOverlay = mountOverlay(downloadLog);
const setsUrl = chrome.runtime.getURL('data/gen9randombattle.json');
loadSetsDb(setsUrl).then(() => {
  console.log('[randbats-bot] Sets DB loaded');
  // Replay buffered protocol lines that arrived before DB was ready
  replayBufferedProtocol();
  // Process any turn requests that arrived before DB was ready
  replayPendingTurnRequests(updateOverlay);
}).catch((err) => {
  console.error('[randbats-bot] Failed to load sets DB:', err);
});
listenForHookMessages(updateOverlay);
listenForSwMessages(updateOverlay);
console.log('[randbats-bot] Content script loaded');
