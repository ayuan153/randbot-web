/**
 * Unit test for BattleStateTracker: verifies protocol parsing and snapshot emission.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { BattleStateTracker } from './battle-state';
import { setSetsDb } from '../src/state/sets-db';
import { extractFeatures, FEATURE_COUNT } from '../src/eval/features';
import type { BattleRequest } from './protocol';
import { readFileSync } from 'fs';
import { resolve } from 'path';

// Load real sets DB for realistic feature extraction
beforeAll(() => {
  const data = JSON.parse(readFileSync(resolve(__dirname, '../data/gen9randombattle.json'), 'utf-8'));
  setSetsDb(data);
});

const PROTOCOL_LINES = [
  '|player|p1|BotUser|1|',
  '|player|p2|Opponent|2|',
  '|switch|p1a: Garchomp|Garchomp, L78|100/100',
  '|switch|p2a: Ferrothorn|Ferrothorn, L84|100/100',
  '|turn|1',
  '|move|p2a: Ferrothorn|Stealth Rock|p1a: Garchomp',
  '|-sidestart|p1: BotUser|move: Stealth Rock',
  '|-boost|p1a: Garchomp|atk|2',
  '|-damage|p2a: Ferrothorn|68/100',
  '|-weather|Sandstorm',
  '|turn|2',
];

function sampleRequest(): BattleRequest {
  return {
    active: [{
      moves: [
        { move: 'Earthquake', id: 'earthquake', pp: 16 },
        { move: 'Dragon Claw', id: 'dragonclaw', pp: 24 },
        { move: 'Swords Dance', id: 'swordsdance', pp: 32 },
        { move: 'Iron Head', id: 'ironhead', pp: 24 },
      ],
    }],
    side: {
      name: 'BotUser',
      id: 'p1',
      pokemon: [
        { ident: 'p1: Garchomp', details: 'Garchomp, L78', condition: '88/100', active: true,
          moves: ['earthquake', 'dragonclaw', 'swordsdance', 'ironhead'],
          item: 'Rocky Helmet', ability: 'Rough Skin',
          stats: { atk: 243, def: 186, spa: 160, spd: 166, spe: 206 } },
        { ident: 'p1: Slowbro', details: 'Slowbro, L82', condition: '100/100', active: false,
          moves: ['scald', 'psychic', 'slackoff', 'thunderwave'],
          item: 'Heavy-Duty Boots', ability: 'Regenerator',
          stats: { atk: 133, def: 222, spa: 189, spd: 148, spe: 86 } },
        { ident: 'p1: Talonflame', details: 'Talonflame, L84', condition: '0 fnt', active: false },
      ],
    },
    rqid: 3,
  };
}

describe('BattleStateTracker', () => {
  it('tracks protocol state correctly', () => {
    const tracker = new BattleStateTracker('BotUser');
    for (const line of PROTOCOL_LINES) tracker.ingest(line);

    const snapshot = tracker.buildSnapshot(sampleRequest());

    // Our side from request
    expect(snapshot.player.active.species).toBe('Garchomp');
    expect(snapshot.player.active.hp).toBe(88);
    // Boosts tracked from protocol
    expect(snapshot.player.active.boosts.atk).toBe(2);

    // Opponent tracked from protocol
    expect(snapshot.opponent.active.species).toBe('Ferrothorn');
    expect(snapshot.opponent.active.hp).toBe(68);
    expect(snapshot.opponent.active.hpMax).toBe(100);
    // Revealed move
    expect(snapshot.opponent.active.moves).toContain('Stealth Rock');

    // Field state
    expect(snapshot.field.weather).toBe('sandstorm');
    expect(snapshot.field.playerSide.stealthRock).toBe(true);
    expect(snapshot.field.opponentSide.stealthRock).toBe(false);

    // Turn
    expect(snapshot.turn).toBe(2);

    // Bench
    expect(snapshot.player.bench.length).toBe(1); // Slowbro (Talonflame fainted)
    expect(snapshot.player.bench[0].species).toBe('Slowbro');
  });

  it('buildSnapshot produces features of length 265 with all finite values', () => {
    const tracker = new BattleStateTracker('BotUser');
    for (const line of PROTOCOL_LINES) tracker.ingest(line);

    const snapshot = tracker.buildSnapshot(sampleRequest());
    const features = extractFeatures(snapshot);

    expect(features.length).toBe(FEATURE_COUNT);
    for (let i = 0; i < features.length; i++) {
      expect(isFinite(features[i])).toBe(true);
    }
  });

  it('opponent model narrows on revealed move', () => {
    const tracker = new BattleStateTracker('BotUser');
    for (const line of PROTOCOL_LINES) tracker.ingest(line);

    const oppMon = tracker.opponentModel.pokemon.find(p => p.species === 'Ferrothorn');
    expect(oppMon).toBeDefined();
    expect(oppMon!.revealedMoves).toContain('Stealth Rock');
  });
});
