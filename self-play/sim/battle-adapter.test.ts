import {describe, it, expect} from 'vitest';
import {Battle, Teams, toID} from '@pkmn/sim';
import {TeamGenerators} from '@pkmn/randoms';
import {BattleAdapter} from './battle-adapter.ts';
import {playGame} from './battle-runner.ts';

Teams.setGeneratorFactory(TeamGenerators);

/** Create a fresh battle with random teams for testing */
function createTestBattle(): Battle {
  const battle = new Battle({formatid: toID('gen9randombattle')});
  battle.setPlayer('p1', {name: 'Bot1'});
  battle.setPlayer('p2', {name: 'Bot2'});
  return battle;
}

describe('BattleAdapter', () => {
  it('clone produces an independent copy (advancing clone does not mutate original)', () => {
    const battle = createTestBattle();
    const adapter = new BattleAdapter(battle, 'p1');
    const cloned = adapter.clone() as BattleAdapter;

    // Record original state
    const originalTurn = adapter.battle.turn;
    const originalEnded = adapter.battle.ended;

    // Advance the clone
    const actions = cloned.getLegalActions();
    if (actions.length > 0 && actions[0] !== 'default') {
      cloned.applyAction(actions[0]);
    }

    // Original should be unchanged
    expect(adapter.battle.turn).toBe(originalTurn);
    expect(adapter.battle.ended).toBe(originalEnded);
  });

  it('getLegalActions returns non-empty actions for a fresh battle', () => {
    const battle = createTestBattle();
    const adapter = new BattleAdapter(battle, 'p1');
    const actions = adapter.getLegalActions();

    expect(actions.length).toBeGreaterThan(0);
    // Should have moves and/or switches
    expect(actions.every(a => a.startsWith('move ') || a.startsWith('switch ') || a === 'default')).toBe(true);
  });

  it('isTerminal returns false for a fresh battle', () => {
    const battle = createTestBattle();
    const adapter = new BattleAdapter(battle, 'p1');
    expect(adapter.isTerminal()).toBe(false);
  });
});

describe('playGame with MCTS policy', () => {
  it('completes a game and produces turn records with policy distributions', async () => {
    const result = await playGame('mcts', {
      numSimulations: 8,
      numDeterminizations: 2,
      explorationConstant: 1.5,
      temperature: 1.0,
    });

    expect(result.winner).toMatch(/^p[12]$/);
    expect(result.turns.length).toBeGreaterThan(0);

    // At least some turns should have policy distributions
    const turnsWithPolicy = result.turns.filter(t => t.p1Policy || t.p2Policy);
    expect(turnsWithPolicy.length).toBeGreaterThan(0);

    // Verify policy distributions sum to ~1
    for (const turn of turnsWithPolicy) {
      if (turn.p1Policy) {
        const sum = Object.values(turn.p1Policy).reduce((s, v) => s + v, 0);
        expect(sum).toBeCloseTo(1.0, 1);
        expect(Object.keys(turn.p1Policy).length).toBeGreaterThan(0);
      }
      if (turn.p2Policy) {
        const sum = Object.values(turn.p2Policy).reduce((s, v) => s + v, 0);
        expect(sum).toBeCloseTo(1.0, 1);
        expect(Object.keys(turn.p2Policy).length).toBeGreaterThan(0);
      }
    }
  }, 60_000); // MCTS games can be slow even with few sims

  it('random policy still works unchanged', async () => {
    const result = await playGame('random');

    expect(result.winner).toMatch(/^p[12]$/);
    expect(result.turns.length).toBeGreaterThan(0);
    // Random policy should NOT have policy distributions
    for (const turn of result.turns) {
      expect(turn.p1Policy).toBeUndefined();
      expect(turn.p2Policy).toBeUndefined();
    }
  }, 30_000);
});
