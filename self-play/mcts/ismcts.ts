/**
 * ismcts.ts — Information Set Monte Carlo Tree Search (ISMCTS)
 *
 * Uses determinization to handle hidden information:
 * sample possible opponent states, run MCTS on each, aggregate results.
 *
 * Guided by policy/value functions (AlphaZero style — no rollouts).
 */

// ─── Interfaces ───────────────────────────────────────────────────────────────

export interface MCTSConfig {
  numSimulations: number;      // Total simulations (100-400 per move)
  numDeterminizations: number; // Number of opponent info samples (5-10)
  explorationConstant: number; // c_puct for UCB (1.5)
  temperature: number;         // 1.0 early game, 0.3 late game
}

export interface MCTSResult {
  actionProbs: Map<string, number>;  // action → visit probability
  bestAction: string;                 // most visited action
  rootValue: number;                  // average value estimate at root
}

export interface MCTSNode {
  parent: MCTSNode | null;
  children: Map<string, MCTSNode>;  // action → child node
  visitCount: number;
  totalValue: number;
  priorProb: number;  // from policy network
}

/** Function that returns prior probabilities over legal actions */
export type PolicyFn = (state: unknown) => Map<string, number> | Promise<Map<string, number>>;

/** Function that returns a win probability estimate for the current player */
export type ValueFn = (state: unknown) => number | Promise<number>;

/**
 * Interface for a battle state that can be cloned and advanced.
 * The actual implementation will wrap @pkmn/sim's Battle.
 */
export interface CloneableBattle {
  clone(): CloneableBattle;
  getLegalActions(): string[];
  applyAction(action: string): void;
  isTerminal(): boolean;
  getWinner(): 'p1' | 'p2' | null;
  getState(): unknown;  // opaque state for policy/value functions
}

/**
 * Function that fills in opponent's hidden information (moves, items, abilities)
 * by sampling from the randbats data. Returns a determinized (fully observable) clone.
 */
export type DeterminizeFn = (battle: CloneableBattle) => CloneableBattle;

// ─── Default policy/value (uniform + neutral) ────────────────────────────────

/** Uniform policy: equal probability over all legal actions */
export function uniformPolicy(legalActions: string[]): Map<string, number> {
  const prob = 1 / legalActions.length;
  const probs = new Map<string, number>();
  for (const action of legalActions) {
    probs.set(action, prob);
  }
  return probs;
}

/** Neutral value: 0.5 (no opinion on who's winning) */
export function neutralValue(): number {
  return 0.5;
}

// ─── Tree operations ──────────────────────────────────────────────────────────

function createNode(parent: MCTSNode | null, priorProb: number): MCTSNode {
  return {
    parent,
    children: new Map(),
    visitCount: 0,
    totalValue: 0,
    priorProb,
  };
}

/** UCB score: Q(a) + c_puct * P(a) * sqrt(N_parent) / (1 + N(a)) */
function ucbScore(node: MCTSNode, parentVisits: number, cPuct: number): number {
  const q = node.visitCount > 0 ? node.totalValue / node.visitCount : 0;
  const exploration = cPuct * node.priorProb * Math.sqrt(parentVisits) / (1 + node.visitCount);
  return q + exploration;
}

/** Select the child with highest UCB score */
function selectChild(node: MCTSNode, cPuct: number): [string, MCTSNode] {
  let bestScore = -Infinity;
  let bestAction = '';
  let bestChild: MCTSNode | null = null;

  for (const [action, child] of node.children) {
    const score = ucbScore(child, node.visitCount, cPuct);
    if (score > bestScore) {
      bestScore = score;
      bestAction = action;
      bestChild = child;
    }
  }

  return [bestAction, bestChild!];
}

/** Expand a leaf node: create children with policy priors */
function expandNode(
  node: MCTSNode,
  legalActions: string[],
  priors: Map<string, number>,
): void {
  for (const action of legalActions) {
    const prior = priors.get(action) ?? (1 / legalActions.length);
    node.children.set(action, createNode(node, prior));
  }
}

/** Backup: propagate value up the tree */
function backup(node: MCTSNode, value: number): void {
  let current: MCTSNode | null = node;
  let v = value;
  while (current !== null) {
    current.visitCount++;
    current.totalValue += v;
    // Flip value for opponent's perspective at each level
    v = 1 - v;
    current = current.parent;
  }
}

// ─── Single-tree MCTS iteration ──────────────────────────────────────────────

/**
 * Run one MCTS iteration on a determinized battle state.
 * Select → Expand → Evaluate → Backup
 */
async function mctsIteration(
  root: MCTSNode,
  battle: CloneableBattle,
  policyFn: PolicyFn,
  valueFn: ValueFn,
  cPuct: number,
): Promise<void> {
  let node = root;
  const sim = battle.clone();

  // SELECT: walk down tree until we hit a leaf or terminal
  while (node.children.size > 0 && !sim.isTerminal()) {
    const [action, child] = selectChild(node, cPuct);
    sim.applyAction(action);
    node = child;
  }

  // If terminal, backup the actual result
  if (sim.isTerminal()) {
    const winner = sim.getWinner();
    // Value from p1's perspective (root player)
    const value = winner === 'p1' ? 1.0 : winner === 'p2' ? 0.0 : 0.5;
    backup(node, value);
    return;
  }

  // EXPAND: create children with policy priors
  const legalActions = sim.getLegalActions();
  const priors = await policyFn(sim.getState());
  expandNode(node, legalActions, priors);

  // EVALUATE: get value estimate from value function
  const value = await valueFn(sim.getState());

  // BACKUP
  backup(node, value);
}

// ─── Main ISMCTS entry point ─────────────────────────────────────────────────

/**
 * Run Information Set MCTS.
 *
 * Performs multiple determinizations of the opponent's hidden info,
 * runs MCTS on each, and aggregates visit counts across all trees.
 */
export async function runMCTS(
  battle: CloneableBattle,
  legalActions: string[],
  policyFn: PolicyFn,
  valueFn: ValueFn,
  config: MCTSConfig,
  determinizeFn?: DeterminizeFn,
): Promise<MCTSResult> {
  const {numSimulations, numDeterminizations, explorationConstant, temperature} = config;
  const simsPerDeterminization = Math.floor(numSimulations / numDeterminizations);

  // Aggregate visit counts across all determinizations
  const totalVisits = new Map<string, number>();
  for (const action of legalActions) {
    totalVisits.set(action, 0);
  }

  let rootValueSum = 0;

  for (let d = 0; d < numDeterminizations; d++) {
    // Determinize: sample opponent's hidden info
    const determinized = determinizeFn ? determinizeFn(battle) : battle.clone();

    // Create a fresh root for this determinization
    const priors = await policyFn(determinized.getState());
    const root = createNode(null, 0);
    expandNode(root, legalActions, priors);

    // Run MCTS iterations
    for (let i = 0; i < simsPerDeterminization; i++) {
      await mctsIteration(root, determinized, policyFn, valueFn, explorationConstant);
    }

    // Accumulate visit counts
    for (const [action, child] of root.children) {
      totalVisits.set(action, (totalVisits.get(action) ?? 0) + child.visitCount);
    }

    // Track root value
    if (root.visitCount > 0) {
      rootValueSum += root.totalValue / root.visitCount;
    }
  }

  // Convert visit counts to probabilities using temperature
  const actionProbs = applyTemperature(totalVisits, temperature);

  // Best action = most visited
  let bestAction = legalActions[0];
  let maxVisits = 0;
  for (const [action, visits] of totalVisits) {
    if (visits > maxVisits) {
      maxVisits = visits;
      bestAction = action;
    }
  }

  return {
    actionProbs,
    bestAction,
    rootValue: rootValueSum / numDeterminizations,
  };
}

/** Convert visit counts to probabilities with temperature */
function applyTemperature(
  visits: Map<string, number>,
  temperature: number,
): Map<string, number> {
  const probs = new Map<string, number>();

  if (temperature < 0.01) {
    // Temperature → 0: deterministic (pick max)
    let maxVisits = 0;
    let maxAction = '';
    for (const [action, count] of visits) {
      if (count > maxVisits) {
        maxVisits = count;
        maxAction = action;
      }
    }
    for (const [action] of visits) {
      probs.set(action, action === maxAction ? 1.0 : 0.0);
    }
    return probs;
  }

  // Apply temperature: p(a) ∝ N(a)^(1/τ)
  let sum = 0;
  const powered = new Map<string, number>();
  for (const [action, count] of visits) {
    const val = Math.pow(count, 1 / temperature);
    powered.set(action, val);
    sum += val;
  }

  for (const [action, val] of powered) {
    probs.set(action, sum > 0 ? val / sum : 1 / powered.size);
  }

  return probs;
}

// ─── Default config ──────────────────────────────────────────────────────────

export const DEFAULT_MCTS_CONFIG: MCTSConfig = {
  numSimulations: 200,
  numDeterminizations: 5,
  explorationConstant: 1.5,
  temperature: 1.0,
};
