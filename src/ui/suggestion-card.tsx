/** @jsxImportSource preact */
/**
 * Individual suggestion card — displays one scored option.
 */

import { h } from 'preact';
import type { ScoredOption } from '../types';

interface SuggestionCardProps {
  option: ScoredOption;
  rank: number;
}

export function SuggestionCard({ option, rank }: SuggestionCardProps) {
  const { action, score, breakdown } = option;
  const name = action.type === 'move' ? action.name : `Switch → ${action.species}`;
  const pct = Math.round(score * 100);
  const color = scoreColor(score);

  // Build detail string
  const details: string[] = [];
  if (breakdown.koProbability > 0) {
    details.push(`KO: ${Math.round(breakdown.koProbability * 100)}%`);
  }
  if (breakdown.damage > 0) {
    details.push(`Dmg: ${Math.round(breakdown.damage * 100)}%`);
  }
  if (breakdown.statusValue > 0) details.push('Status');
  if (breakdown.hazardValue > 0) details.push('Hazard');
  if (breakdown.switchInValue > 0) details.push(`HP: ${Math.round(breakdown.switchInValue * 200)}%`);

  return (
    <div class="suggestion-card" style={{ borderLeftColor: color }}>
      <div class="suggestion-header">
        <span class="suggestion-rank">#{rank}</span>
        <span class="suggestion-name">{name}</span>
        <span class="suggestion-score" style={{ color }}>{pct}</span>
      </div>
      <div class="suggestion-bar">
        <div
          class="suggestion-bar-fill"
          style={{ width: `${pct}%`, background: color }}
        />
      </div>
      {details.length > 0 && (
        <div class="suggestion-details">{details.join(' • ')}</div>
      )}
    </div>
  );
}

function scoreColor(score: number): string {
  if (score >= 0.7) return '#4caf50';
  if (score >= 0.4) return '#ff9800';
  return '#f44336';
}
