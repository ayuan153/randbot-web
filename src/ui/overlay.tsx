/** @jsxImportSource preact */
/**
 * Preact overlay root — mounted in Shadow DOM for style isolation.
 * Renders the suggestion panel near the battle controls.
 */

import { h, render } from 'preact';
import { useState } from 'preact/hooks';
import type { BattleSnapshot, OpponentModel, ScoredOption } from '../types';
import { SuggestionCard } from './suggestion-card';
import { DevPanel } from './dev-panel';

interface OverlayProps {
  options: ScoredOption[];
  turn: number;
  elapsedMs: number;
  snapshot: BattleSnapshot | null;
  opponentModel: OpponentModel | null;
  onDownload: () => void;
}

function Overlay({ options, turn, elapsedMs, snapshot, opponentModel, onDownload }: OverlayProps) {
  const [collapsed, setCollapsed] = useState(false);
  const [devMode, setDevMode] = useState(false);

  return (
    <div class="randbats-overlay">
      <div class="overlay-header" onClick={() => setCollapsed(!collapsed)}>
        <span class="overlay-title">⚔️ randbats-bot</span>
        <span class="overlay-meta">Turn {turn} • {elapsedMs}ms</span>
        <button
          class="overlay-download"
          onClick={(e) => {
            e.stopPropagation();
            onDownload();
          }}
          title="Download battle log"
          aria-label="Download battle log"
        >
          📥
        </button>
        <button
          class={`dev-toggle ${devMode ? 'dev-toggle-active' : ''}`}
          onClick={(e) => {
            e.stopPropagation();
            setDevMode(!devMode);
          }}
          aria-label="Toggle dev mode"
          aria-pressed={devMode}
        >
          DEV
        </button>
        <span class="overlay-toggle">{collapsed ? '▶' : '▼'}</span>
      </div>
      {!collapsed && (
        <div class="overlay-body">
          {options.length === 0 && <div class="overlay-empty">Waiting for turn...</div>}
          {options.map((opt, i) => (
            <SuggestionCard key={i} option={opt} rank={i + 1} />
          ))}
          {devMode && (
            <DevPanel snapshot={snapshot} options={options} opponentModel={opponentModel} />
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Mount the overlay into a Shadow DOM container on the page.
 * Returns an update function to re-render with new data.
 */
export function mountOverlay(onDownload: () => void): (
  options: ScoredOption[],
  turn: number,
  elapsedMs: number,
  snapshot?: BattleSnapshot | null,
  opponentModel?: OpponentModel | null,
) => void {
  // Create host element
  const host = document.createElement('div');
  host.id = 'randbats-bot-overlay';
  document.body.appendChild(host);

  // Attach shadow DOM
  const shadow = host.attachShadow({ mode: 'open' });

  // Inject styles
  const style = document.createElement('style');
  style.textContent = getStyles();
  shadow.appendChild(style);

  // Mount point
  const mountPoint = document.createElement('div');
  shadow.appendChild(mountPoint);

  // Return updater function
  return (
    options: ScoredOption[],
    turn: number,
    elapsedMs: number,
    snapshot: BattleSnapshot | null = null,
    opponentModel: OpponentModel | null = null,
  ) => {
    render(h(Overlay, { options, turn, elapsedMs, snapshot, opponentModel, onDownload }), mountPoint);
  };
}

function getStyles(): string {
  return `
    .randbats-overlay {
      position: fixed;
      bottom: 20px;
      right: 20px;
      z-index: 99999;
      width: 280px;
      background: #1a1a2e;
      border: 1px solid #16213e;
      border-radius: 8px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.4);
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      font-size: 13px;
      color: #e0e0e0;
      overflow: hidden;
    }
    .overlay-header {
      display: flex;
      align-items: center;
      padding: 8px 12px;
      background: #16213e;
      cursor: pointer;
      user-select: none;
    }
    .overlay-title {
      font-weight: 600;
      flex: 1;
    }
    .overlay-meta {
      font-size: 11px;
      color: #888;
      margin-right: 8px;
    }
    .overlay-toggle {
      font-size: 10px;
      color: #888;
    }
    .overlay-download {
      background: none;
      border: none;
      cursor: pointer;
      font-size: 14px;
      padding: 0 4px;
      line-height: 1;
      opacity: 0.7;
      transition: opacity 0.2s;
    }
    .overlay-download:hover {
      opacity: 1;
    }
    .overlay-body {
      padding: 8px;
      max-height: 400px;
      overflow-y: auto;
    }
    .overlay-empty {
      text-align: center;
      color: #666;
      padding: 12px;
    }
    .suggestion-card {
      padding: 6px 8px;
      margin-bottom: 4px;
      border-radius: 4px;
      background: #0f3460;
      border-left: 3px solid;
    }
    .suggestion-card:last-child {
      margin-bottom: 0;
    }
    .suggestion-header {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .suggestion-rank {
      font-weight: 700;
      font-size: 11px;
      color: #888;
      min-width: 16px;
    }
    .suggestion-name {
      font-weight: 600;
      flex: 1;
    }
    .suggestion-score {
      font-size: 12px;
      font-weight: 700;
    }
    .suggestion-bar {
      height: 3px;
      margin-top: 4px;
      border-radius: 2px;
      background: #1a1a2e;
    }
    .suggestion-bar-fill {
      height: 100%;
      border-radius: 2px;
      transition: width 0.3s ease;
    }
    .suggestion-details {
      font-size: 11px;
      color: #aaa;
      margin-top: 3px;
    }
    .dev-toggle {
      font-size: 9px;
      font-weight: 700;
      padding: 2px 5px;
      margin-right: 6px;
      border: 1px solid #444;
      border-radius: 3px;
      background: transparent;
      color: #666;
      cursor: pointer;
      line-height: 1;
    }
    .dev-toggle:hover {
      color: #aaa;
      border-color: #666;
    }
    .dev-toggle-active {
      color: #4caf50;
      border-color: #4caf50;
      background: rgba(76, 175, 80, 0.1);
    }
    .dev-panel {
      margin-top: 8px;
      padding-top: 8px;
      border-top: 1px solid #333;
      font-family: 'SF Mono', 'Fira Code', 'Consolas', monospace;
      font-size: 10px;
      line-height: 1.4;
    }
    .dev-section {
      margin-bottom: 6px;
      padding: 4px 6px;
      background: rgba(0, 0, 0, 0.2);
      border-radius: 3px;
    }
    .dev-section:last-child {
      margin-bottom: 0;
    }
    .dev-section-title {
      font-weight: 700;
      color: #7faaff;
      margin-bottom: 2px;
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .dev-row {
      color: #ccc;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .dev-label {
      color: #888;
    }
    .dev-indent {
      padding-left: 8px;
    }
    .dev-opponent-mon {
      margin-bottom: 3px;
      padding-bottom: 3px;
      border-bottom: 1px solid rgba(255,255,255,0.05);
    }
    .dev-opponent-mon:last-child {
      margin-bottom: 0;
      padding-bottom: 0;
      border-bottom: none;
    }
  `;
}
