/**
 * sim-server.ts — Orchestrator: runs parallel games, collects results, writes output.
 * Usage: node --import tsx sim/sim-server.ts --games 100 --workers 4 --output results.jsonl --policy random|mcts
 */

import {writeFileSync} from 'node:fs';
import {playGame, type GameResult, type PolicyType} from './battle-runner.ts';
import {DEFAULT_MCTS_CONFIG, type MCTSConfig} from '../mcts/ismcts.ts';

interface Config {
  numGames: number;
  numWorkers: number;
  output: string;
  policy: PolicyType;
  mctsSims: number;
  mctsDeterminizations: number;
}

function parseArgs(): Config {
  const args = process.argv.slice(2);
  let numGames = 100;
  let numWorkers = 4;
  let output = 'results.jsonl';
  let policy: PolicyType = 'random';
  let mctsSims = 32;
  let mctsDeterminizations = 5;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--games') numGames = parseInt(args[++i]);
    else if (args[i] === '--workers') numWorkers = parseInt(args[++i]);
    else if (args[i] === '--output') output = args[++i];
    else if (args[i] === '--policy') policy = args[++i] as PolicyType;
    else if (args[i] === '--mcts-sims') mctsSims = parseInt(args[++i]);
    else if (args[i] === '--mcts-determinizations') mctsDeterminizations = parseInt(args[++i]);
  }
  return {numGames, numWorkers, output, policy, mctsSims, mctsDeterminizations};
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

  console.log(`Running ${config.numGames} games (concurrency: ${config.numWorkers}, policy: ${config.policy}${config.policy === 'mcts' ? `, sims: ${config.mctsSims}, dets: ${config.mctsDeterminizations}` : ''})...`);
  const startTime = Date.now();

  const mctsConfig = config.policy === 'mcts'
    ? {...DEFAULT_MCTS_CONFIG, numSimulations: config.mctsSims, numDeterminizations: config.mctsDeterminizations}
    : undefined;

  const results = await runGamesInProcess(config.numGames, config.numWorkers, config.policy, mctsConfig);

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
