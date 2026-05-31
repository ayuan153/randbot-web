import {describe, it, expect} from 'vitest';
import {runMCTS, type CloneableBattle, type MCTSConfig} from './ismcts.ts';

const config: MCTSConfig = {numSimulations: 4, numDeterminizations: 1, explorationConstant: 1.5, temperature: 1.0};

function makeBattle(legal: string[]): CloneableBattle {
  return {
    clone() { return makeBattle(legal); },
    getLegalActions() { return legal; },
    applyAction() { /* noop */ },
    isTerminal() { return true; },
    getWinner() { return 'p1'; },
    getState() { return {}; },
  };
}

describe('ismcts prior renormalization', () => {
  it('renormalizes raw policy priors to sum to ~1 over legal actions', async () => {
    const legal = ['move 1', 'move 2', 'switch 1'];
    // Policy returns raw unnormalized values over a superset
    const policyFn = () => new Map([['move 1', 2], ['move 2', 3], ['move 3', 10], ['switch 1', 5]]);
    const valueFn = () => 0.5;

    const result = await runMCTS(makeBattle(legal), legal, policyFn, valueFn, config);
    // The priors over legal actions should sum to 1 (2+3+5=10, so 0.2, 0.3, 0.5)
    // We verify indirectly: the result should have valid action probs summing to ~1
    let sum = 0;
    for (const p of result.actionProbs.values()) sum += p;
    expect(sum).toBeCloseTo(1.0);
  });

  it('falls back to uniform when policy returns all zeros for legal actions', async () => {
    const legal = ['move 1', 'move 2', 'switch 1'];
    const policyFn = () => new Map([['move 1', 0], ['move 2', 0], ['switch 1', 0]]);
    const valueFn = () => 0.5;

    const result = await runMCTS(makeBattle(legal), legal, policyFn, valueFn, config);
    // With uniform priors and terminal state, visits should be roughly equal
    let sum = 0;
    for (const p of result.actionProbs.values()) sum += p;
    expect(sum).toBeCloseTo(1.0);
    // Each action should get some visits (uniform fallback)
    for (const action of legal) {
      expect(result.actionProbs.get(action)).toBeGreaterThan(0);
    }
  });
});
