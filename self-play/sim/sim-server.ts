/**
 * sim-server.ts — Orchestrator: runs parallel games, collects results, writes output.
 * Usage: node --import tsx sim/sim-server.ts --games 100 --workers 4 --output results.jsonl --policy random|mcts
 */

import {writeFileSync} from 'node:fs';
import {playGame, playEvalGame, type GameResult, type PolicyType, type EvalPolicy} from './battle-runner.ts';
import {DEFAULT_MCTS_CONFIG, type MCTSConfig} from '../mcts/ismcts.ts';

interface Config {
  numGames: number;
  numWorkers: number;
  output: string;
  policy: PolicyType;
  mctsSims: number;
  mctsDeterminizations: number;
  p1Policy?: EvalPolicy;
  p2Policy?: EvalPolicy;
}

function parseArgs(): Config {
  const args = process.argv.slice(2);
  let numGames = 100;
  let numWorkers = 4;
  let output = 'results.jsonl';
  let policy: PolicyType = 'random';
  let mctsSims = 32;
  let mctsDeterminizations = 5;
  let p1Policy: EvalPolicy | undefined;
  let p2Policy: EvalPolicy | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--games') numGames = parseInt(args[++i]);
    else if (args[i] === '--workers') numWorkers = parseInt(args[++i]);
    else if (args[i] === '--output') output = args[++i];
    else if (args[i] === '--policy') policy = args[++i] as PolicyType;
    else if (args[i] === '--mcts-sims') mctsSims = parseInt(args[++i]);
    else if (args[i] === '--mcts-determinizations') mctsDeterminizations = parseInt(args[++i]);
    else if (args[i] === '--p1-policy') p1Policy = args[++i] as EvalPolicy;
    else if (args[i] === '--p2-policy') p2Policy = args[++i] as EvalPolicy;
  }
  return {numGames, numWorkers, output, policy, mctsSims, mctsDeterminizations, p1Policy, p2Policy};
}

/** Run games concurrently in-process (each game is async, so they interleave) */
async function runGamesInProcess(numGames: number, concurrency: number, policy: PolicyType, mctsConfig?: MCTSConfig): Promise<GameResult[]> {
  const results: GameResult[] = [];
  let started = 0;
  let timeouts = 0;

  async function worker() {
    while (started < numGames) {
      started++;
      try {
        results.push(await playGame(policy, mctsConfig));
      } catch {
        // Game timed out or errored — skip it and try another
        timeouts++;
        started++; // count extra game to compensate
      }
    }
  }

  await Promise.all(Array.from({length: concurrency}, () => worker()));
  if (timeouts > 0) console.log(`(${timeouts} games timed out and were skipped)`);
  return results;
}

async function main() {
  const config = parseArgs();
  const evalMode = config.p1Policy !== undefined && config.p2Policy !== undefined;
  const log = evalMode ? console.error.bind(console) : console.log.bind(console);

  const mctsConfig = {...DEFAULT_MCTS_CONFIG, numSimulations: config.mctsSims, numDeterminizations: config.mctsDeterminizations};

  if (evalMode) {
    log(`Eval: ${config.numGames} games, ${config.p1Policy} vs ${config.p2Policy} (serial, sims: ${config.mctsSims})`);
    const startTime = Date.now();
    const results: GameResult[] = [];

    // Run eval games SERIALLY (ignore --workers). MCTS is CPU-bound and runs
    // synchronously, so concurrency gives no real parallelism (gotcha #4) and
    // only inflates each game's wall-clock past GAME_TIMEOUT_MS — under 4-way
    // contention every game timed out on SageMaker, yielding 0 scored games.
    for (let g = 0; g < config.numGames; g++) {
      try {
        results.push(await playEvalGame(config.p1Policy!, config.p2Policy!, mctsConfig));
      } catch {
        // Game timed out — skip
      }
    }
    const elapsed = (Date.now() - startTime) / 1000;
    log(`Completed ${results.length} games in ${elapsed.toFixed(1)}s`);

    const out = results.map(r => JSON.stringify({winner: r.winner, numTurns: r.numTurns})).join('\n') + '\n';
    // Write fd 1 directly for stdout: re-opening '/dev/stdout' via writeFileSync
    // throws EINVAL when stdout is a pipe on Linux (works on macOS), which
    // crashed eval on SageMaker and yielded 0 parsed games.
    if (config.output === '/dev/stdout' || config.output === '-') {
      process.stdout.write(out);
    } else {
      writeFileSync(config.output, out);
    }
    return;
  }

  log(`Running ${config.numGames} games (concurrency: ${config.numWorkers}, policy: ${config.policy}${config.policy === 'mcts' ? `, sims: ${config.mctsSims}, dets: ${config.mctsDeterminizations}` : ''})...`);
  const startTime = Date.now();

  const selfPlayMctsConfig = config.policy === 'mcts' ? mctsConfig : undefined;

  const results = await runGamesInProcess(config.numGames, config.numWorkers, config.policy, selfPlayMctsConfig);

  const elapsed = (Date.now() - startTime) / 1000;
  const throughput = results.length / elapsed;

  // Stats
  const p1Wins = results.filter(r => r.winner === 'p1').length;
  const avgTurns = results.reduce((s, r) => s + r.numTurns, 0) / results.length;

  console.log(`Completed ${results.length} games in ${elapsed.toFixed(1)}s (${throughput.toFixed(1)} games/sec)`);
  console.log(`P1 wins: ${p1Wins}/${results.length} (${(100 * p1Wins / results.length).toFixed(1)}%)`);
  console.log(`Avg turns: ${avgTurns.toFixed(1)}`);

  // Write JSONL output (omit full log to save space, keep turns + metadata)
  const lines = results.map(r => JSON.stringify({
    winner: r.winner,
    numTurns: r.numTurns,
    turns: r.turns,
  }));
  writeFileSync(config.output, lines.join('\n') + '\n');
  console.log(`Results written to ${config.output}`);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
