/**
 * battle-runner.ts — Runs a single Gen 9 Random Battle to completion.
 * Both sides play random legal moves. Returns the full game trajectory.
 */

import {Battle, BattleStreams, Teams, toID} from '@pkmn/sim';
import {TeamGenerators} from '@pkmn/randoms';
import {runMCTS, uniformPolicy, DEFAULT_MCTS_CONFIG} from '../mcts/ismcts.ts';
import {heuristicValue} from '../mcts/heuristic-value.ts';
import type {MCTSConfig} from '../mcts/ismcts.ts';
import {BattleAdapter} from './battle-adapter.ts';

// Register the random team generator
Teams.setGeneratorFactory(TeamGenerators);

export interface TurnRecord {
  turn: number;
  p1Request: object;
  p2Request: object;
  p1Choice: string;
  p2Choice: string;
  p1Policy?: Record<string, number>;
  p2Policy?: Record<string, number>;
}

export interface GameResult {
  log: string;
  turns: TurnRecord[];
  winner: 'p1' | 'p2';
  numTurns: number;
}

/** Get all legal actions from a request, for recording purposes */
function getLegalActions(request: any): string[] {
  const actions: string[] = [];

  if (request.forceSwitch) {
    const pokemon = request.side.pokemon;
    for (let i = 1; i < pokemon.length; i++) {
      if (!pokemon[i].active && pokemon[i].condition !== '0 fnt') {
        actions.push(`switch ${i + 1}`);
      }
    }
  } else if (request.active) {
    const active = request.active[0];
    for (let i = 0; i < active.moves.length; i++) {
      if (!active.moves[i].disabled) {
        actions.push(`move ${i + 1}`);
      }
    }
    if (!active.trapped && !active.maybeTrapped) {
      const pokemon = request.side.pokemon;
      for (let i = 1; i < pokemon.length; i++) {
        if (!pokemon[i].active && pokemon[i].condition !== '0 fnt') {
          actions.push(`switch ${i + 1}`);
        }
      }
    }
  }

  return actions.length > 0 ? actions : ['default'];
}

/** Pick a random legal action */
function pickRandomAction(request: any): string {
  const actions = getLegalActions(request);
  return actions[Math.floor(Math.random() * actions.length)];
}

const GAME_TIMEOUT_MS = 30_000;

export type PolicyType = 'random' | 'mcts';

/**
 * Run a single game with the specified policy.
 * 'random' uses uniform random moves (fast).
 * 'mcts' uses ISMCTS with uniform policy/neutral value (slower but non-random).
 */
export async function playGame(
  policy: PolicyType = 'random',
  mctsConfig?: MCTSConfig,
): Promise<GameResult> {
  if (policy === 'mcts') {
    return runMCTSGame(mctsConfig ?? DEFAULT_MCTS_CONFIG);
  }
  return runGame();
}

/** Run a single game using ISMCTS for both players' decisions */
async function runMCTSGame(config: MCTSConfig): Promise<GameResult> {
  return Promise.race([
    runMCTSGameInternal(config),
    new Promise<GameResult>((_, reject) =>
      setTimeout(() => reject(new Error('Game timed out')), GAME_TIMEOUT_MS)
    ),
  ]);
}

async function runMCTSGameInternal(config: MCTSConfig): Promise<GameResult> {
  const battle = new Battle({formatid: toID('gen9randombattle')});
  battle.setPlayer('p1', {name: 'Bot1'});
  battle.setPlayer('p2', {name: 'Bot2'});

  const turns: TurnRecord[] = [];
  let turnNum = 0;

  // Guard against pathological non-progressing battles (e.g. a wait request
  // that never clears). The async game timeout cannot fire while this loop
  // runs synchronously, so we need a hard iteration cap to avoid a hang.
  let loopGuard = 0;
  const MAX_LOOP_ITERATIONS = 2000;

  while (!battle.ended) {
    if (++loopGuard > MAX_LOOP_ITERATIONS) break;

    const p1Request = battle.p1.activeRequest;
    const p2Request = battle.p2.activeRequest;

    if (!p1Request && !p2Request) break;

    // Skip wait/teamPreview requests
    const p1NeedsChoice = p1Request && !(p1Request as {wait?: boolean}).wait && !(p1Request as {teamPreview?: boolean}).teamPreview;
    const p2NeedsChoice = p2Request && !(p2Request as {wait?: boolean}).wait && !(p2Request as {teamPreview?: boolean}).teamPreview;

    if (!p1NeedsChoice && !p2NeedsChoice) {
      // Both are wait/teamPreview — send defaults
      if (p1Request) battle.choose('p1', 'default');
      if (p2Request) battle.choose('p2', 'default');
      continue;
    }

    let p1Choice = 'default';
    let p2Choice = 'default';
    let p1Policy: Record<string, number> | undefined;
    let p2Policy: Record<string, number> | undefined;

    if (p1NeedsChoice) {
      const adapter = new BattleAdapter(battle, 'p1');
      const legalActions = adapter.getLegalActions();
      if (legalActions.length > 1 || legalActions[0] !== 'default') {
        const policyFn = () => uniformPolicy(legalActions);
        const result = await runMCTS(adapter, legalActions, policyFn, heuristicValue, config);
        p1Choice = result.bestAction;
        p1Policy = Object.fromEntries(result.actionProbs);
      }
    }

    if (p2NeedsChoice) {
      const adapter = new BattleAdapter(battle, 'p2');
      const legalActions = adapter.getLegalActions();
      if (legalActions.length > 1 || legalActions[0] !== 'default') {
        const policyFn = () => uniformPolicy(legalActions);
        const result = await runMCTS(adapter, legalActions, policyFn, heuristicValue, config);
        p2Choice = result.bestAction;
        p2Policy = Object.fromEntries(result.actionProbs);
      }
    }

    turns.push({
      turn: turnNum,
      p1Request: p1Request ? JSON.parse(JSON.stringify(p1Request)) : {},
      p2Request: p2Request ? JSON.parse(JSON.stringify(p2Request)) : {},
      p1Choice,
      p2Choice,
      ...(p1Policy && {p1Policy}),
      ...(p2Policy && {p2Policy}),
    });

    if (p1NeedsChoice) battle.choose('p1', p1Choice);
    if (p2NeedsChoice) battle.choose('p2', p2Choice);
    if (!p1NeedsChoice && p1Request) battle.choose('p1', 'default');
    if (!p2NeedsChoice && p2Request) battle.choose('p2', 'default');
    turnNum++;
  }

  const winner: 'p1' | 'p2' = battle.winner === 'Bot1' ? 'p1' : 'p2';

  return {
    log: battle.log.join('\n'),
    turns,
    winner,
    numTurns: battle.turn,
  };
}

/** Run a single game to completion with random moves */
export async function runGame(): Promise<GameResult> {
  return Promise.race([
    runGameInternal(),
    new Promise<GameResult>((_, reject) =>
      setTimeout(() => reject(new Error('Game timed out')), GAME_TIMEOUT_MS)
    ),
  ]);
}

async function runGameInternal(): Promise<GameResult> {
  const streams = BattleStreams.getPlayerStreams(new BattleStreams.BattleStream());
  const logChunks: string[] = [];
  const p1Decisions: {request: object; choice: string}[] = [];
  const p2Decisions: {request: object; choice: string}[] = [];
  let winner: 'p1' | 'p2' | null = null;
  let currentTurn = 0;

  void streams.omniscient.write('>start {"formatid":"gen9randombattle"}');
  void streams.omniscient.write('>player p1 {"name":"Bot1"}');
  void streams.omniscient.write('>player p2 {"name":"Bot2"}');

  const logPromise = (async () => {
    for await (const chunk of streams.omniscient) {
      logChunks.push(chunk);
      for (const line of chunk.split('\n')) {
        if (line.startsWith('|turn|')) currentTurn = parseInt(line.split('|')[2]);
        if (line.startsWith('|win|')) winner = line.slice(5) === 'Bot1' ? 'p1' : 'p2';
      }
    }
  })();

  const playerLoop = (stream: any, decisions: {request: object; choice: string}[]) => async () => {
    for await (const chunk of stream) {
      for (const line of chunk.split('\n')) {
        // Handle invalid choice errors by falling back to 'default'
        if (line.startsWith('|error|')) {
          void stream.write('default');
          continue;
        }
        if (!line.startsWith('|request|')) continue;
        const req = JSON.parse(line.slice(9));
        if (req.wait) continue;
        if (req.teamPreview) {
          void stream.write('default');
          continue;
        }
        const choice = pickRandomAction(req);
        decisions.push({request: req, choice});
        void stream.write(choice);
      }
    }
  };

  await Promise.all([logPromise, playerLoop(streams.p1, p1Decisions)(), playerLoop(streams.p2, p2Decisions)()]);

  // Pair decisions into turn records
  const turns: TurnRecord[] = [];
  const maxLen = Math.max(p1Decisions.length, p2Decisions.length);
  for (let i = 0; i < maxLen; i++) {
    turns.push({
      turn: i,
      p1Request: p1Decisions[i]?.request ?? {},
      p2Request: p2Decisions[i]?.request ?? {},
      p1Choice: p1Decisions[i]?.choice ?? '',
      p2Choice: p2Decisions[i]?.choice ?? '',
    });
  }

  return {
    log: logChunks.join('\n'),
    turns,
    winner: winner ?? 'p1',
    numTurns: currentTurn,
  };
}
