/** @jsxImportSource preact */
/**
 * Dev panel — shows internal bot state for debugging.
 * Collapsed by default, toggled via DEV button in overlay header.
 */

import { h } from 'preact';
import type {
  BattleSnapshot,
  ScoredOption,
  OpponentModel,
  PokemonState,
  SideFieldState,
  OpponentPokemonModel,
} from '../types';

interface DevPanelProps {
  snapshot: BattleSnapshot | null;
  options: ScoredOption[];
  opponentModel: OpponentModel | null;
}

/** If all remaining sets for a species agree on ability or item, return it; else null */
function getInferredValue(species: string, model: OpponentModel | null, field: 'ability' | 'item'): string | null {
  if (!model) return null;
  const mon = model.pokemon.find(p => p.species === species);
  if (!mon || mon.possibleSets.length === 0) return null;
  const values = mon.possibleSets.map(ws => ws.set[field]);
  const allSame = values.every(v => v === values[0]);
  return allSame ? values[0] : null;
}

export function DevPanel({ snapshot, options, opponentModel }: DevPanelProps) {
  if (!snapshot) {
    return <div class="dev-panel"><div class="dev-section">No snapshot available</div></div>;
  }

  const oppActive = snapshot.opponent.active;
  const inferredAbility = getInferredValue(oppActive.species, opponentModel, 'ability');
  const inferredItem = getInferredValue(oppActive.species, opponentModel, 'item');

  return (
    <div class="dev-panel">
      <ActiveSection label="My Active" pokemon={snapshot.player.active} />
      <ActiveSection label="Opp Active" pokemon={oppActive} inferredAbility={inferredAbility} inferredItem={inferredItem} />
      {opponentModel && <OpponentModelSection model={opponentModel} />}
      {options.length > 0 && options[0].debugInfo && (
        <DamageCalcSection debugInfo={options[0].debugInfo} />
      )}
      <FieldSection field={snapshot.field} />
    </div>
  );
}

function ActiveSection({ label, pokemon, inferredAbility, inferredItem }: { label: string; pokemon: PokemonState; inferredAbility?: string | null; inferredItem?: string | null }) {
  const boostStr = Object.entries(pokemon.boosts)
    .filter(([, v]) => v !== 0)
    .map(([k, v]) => `${k}${v > 0 ? '+' : ''}${v}`)
    .join(' ');

  const abilityDisplay = pokemon.ability || (inferredAbility ? `${inferredAbility} (inferred)` : '???');
  const itemDisplay = pokemon.item || (inferredItem ? `${inferredItem} (inferred)` : '???');

  return (
    <div class="dev-section">
      <div class="dev-section-title">{label}</div>
      <div class="dev-row">
        <span class="dev-label">Species:</span> {pokemon.species} L{pokemon.level}
      </div>
      <div class="dev-row">
        <span class="dev-label">HP:</span> {pokemon.hp}/{pokemon.hpMax} ({Math.round((pokemon.hp / pokemon.hpMax) * 100)}%)
      </div>
      <div class="dev-row">
        <span class="dev-label">Ability:</span> {abilityDisplay}
      </div>
      <div class="dev-row">
        <span class="dev-label">Item:</span> {itemDisplay}
      </div>
      <div class="dev-row">
        <span class="dev-label">Moves:</span> {pokemon.moves.length > 0 ? pokemon.moves.join(', ') : 'none revealed'}
      </div>
      {boostStr && (
        <div class="dev-row">
          <span class="dev-label">Boosts:</span> {boostStr}
        </div>
      )}
      {pokemon.status && (
        <div class="dev-row">
          <span class="dev-label">Status:</span> {pokemon.status}
        </div>
      )}
      {pokemon.terastallized && (
        <div class="dev-row">
          <span class="dev-label">Tera:</span> {pokemon.teraType}
        </div>
      )}
    </div>
  );
}

function OpponentModelSection({ model }: { model: OpponentModel }) {
  return (
    <div class="dev-section">
      <div class="dev-section-title">Opponent Model ({model.unrevealed} unrevealed)</div>
      {model.pokemon.map((mon) => (
        <OpponentMonRow key={mon.species} mon={mon} />
      ))}
    </div>
  );
}

function OpponentMonRow({ mon }: { mon: OpponentPokemonModel }) {
  const topSet = mon.possibleSets.length > 0 ? mon.possibleSets[0] : null;

  return (
    <div class="dev-opponent-mon">
      <div class="dev-row">
        <strong>{mon.species}</strong> — {mon.possibleSets.length} set{mon.possibleSets.length !== 1 ? 's' : ''} remaining
      </div>
      {mon.revealedMoves.length > 0 && (
        <div class="dev-row dev-indent">Moves: {mon.revealedMoves.join(', ')}</div>
      )}
      {mon.revealedAbility && (
        <div class="dev-row dev-indent">Ability: {mon.revealedAbility}</div>
      )}
      {mon.revealedItem && (
        <div class="dev-row dev-indent">Item: {mon.revealedItem}</div>
      )}
      {topSet && (
        <div class="dev-row dev-indent">
          Top set: {topSet.set.nature} | {formatEvs(topSet.set.evs)} ({Math.round(topSet.probability * 100)}%)
        </div>
      )}
    </div>
  );
}

function DamageCalcSection({ debugInfo }: { debugInfo: NonNullable<ScoredOption['debugInfo']> }) {
  return (
    <div class="dev-section">
      <div class="dev-section-title">Damage Calc (Top Move)</div>
      <div class="dev-row">
        <span class="dev-label">Move:</span> {debugInfo.move}
      </div>
      <div class="dev-row">
        <span class="dev-label">Atk:</span> {debugInfo.attacker.species} {formatStats(debugInfo.attacker.stats)}
      </div>
      <div class="dev-row">
        <span class="dev-label">Def:</span> {debugInfo.defender.species} {formatStats(debugInfo.defender.stats)}
      </div>
      {debugInfo.weather && (
        <div class="dev-row"><span class="dev-label">Weather:</span> {debugInfo.weather}</div>
      )}
      {debugInfo.terrain && (
        <div class="dev-row"><span class="dev-label">Terrain:</span> {debugInfo.terrain}</div>
      )}
    </div>
  );
}

function FieldSection({ field }: { field: BattleSnapshot['field'] }) {
  return (
    <div class="dev-section">
      <div class="dev-section-title">Field</div>
      {field.weather && (
        <div class="dev-row"><span class="dev-label">Weather:</span> {field.weather} ({field.weatherTurns}t)</div>
      )}
      {field.terrain && (
        <div class="dev-row"><span class="dev-label">Terrain:</span> {field.terrain} ({field.terrainTurns}t)</div>
      )}
      <div class="dev-row"><span class="dev-label">My side:</span> {formatSideField(field.playerSide)}</div>
      <div class="dev-row"><span class="dev-label">Opp side:</span> {formatSideField(field.opponentSide)}</div>
    </div>
  );
}

function formatEvs(evs: Record<string, number>): string {
  return Object.entries(evs)
    .filter(([, v]) => v > 0)
    .map(([k, v]) => `${v} ${k}`)
    .join(' / ');
}

function formatStats(stats: Record<string, number>): string {
  return Object.entries(stats)
    .map(([k, v]) => `${k}:${v}`)
    .join(' ');
}

function formatSideField(side: SideFieldState): string {
  const parts: string[] = [];
  if (side.stealthRock) parts.push('SR');
  if (side.spikes > 0) parts.push(`Spikes×${side.spikes}`);
  if (side.toxicSpikes > 0) parts.push(`TSpikes×${side.toxicSpikes}`);
  if (side.stickyWeb) parts.push('Web');
  if (side.reflect > 0) parts.push(`Reflect(${side.reflect})`);
  if (side.lightScreen > 0) parts.push(`LScreen(${side.lightScreen})`);
  if (side.auroraVeil > 0) parts.push(`Veil(${side.auroraVeil})`);
  if (side.tailwind > 0) parts.push(`TW(${side.tailwind})`);
  return parts.length > 0 ? parts.join(', ') : 'clear';
}
