/**
 * sim-server.ts — Orchestrator: runs parallel games, collects results, writes output.
 * Usage: node --import tsx sim/sim-server.ts --games 100 --workers 4 --output results.jsonl --policy random|mcts
 */

import {spawn} from 'node:child_process';
import {readFileSync, existsSync, unlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {playGame, playEvalGame, type GameResult, type PolicyType, type EvalPolicy} from './battle-runner.ts';
import {DEFAULT_MCTS_CONFIG, type MCTSConfig} from '../mcts/ismcts.ts';
import {loadNet} from '../mcts/net-eval.ts';
import type {InferenceSession} from 'onnxruntime-node';

interface Config {
  numGames: number;
  numWorkers: number;
  output: string;
  policy: PolicyType;
  mctsSims: number;
  mctsDeterminizations: number;
  p1Policy?: EvalPolicy;
  p2Policy?: EvalPolicy;
  net?: string;
  shard?: boolean;
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
  let net: string | undefined;
  let shard = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--games') numGames = parseInt(args[++i]);
    else if (args[i] === '--workers') numWorkers = parseInt(args[++i]);
    else if (args[i] === '--output') output = args[++i];
    else if (args[i] === '--policy') policy = args[++i] as PolicyType;
    else if (args[i] === '--mcts-sims') mctsSims = parseInt(args[++i]);
    else if (args[i] === '--mcts-determinizations') mctsDeterminizations = parseInt(args[++i]);
    else if (args[i] === '--p1-policy') p1Policy = args[++i] as EvalPolicy;
    else if (args[i] === '--p2-policy') p2Policy = args[++i] as EvalPolicy;
    else if (args[i] === '--net') net = args[++i];
    else if (args[i] === '--shard') shard = true;
  }
  return {numGames, numWorkers, output, policy, mctsSims, mctsDeterminizations, p1Policy, p2Policy, net, shard};
}

/** Run games concurrently in-process (each game is async, so they interleave) */
async function runGamesInProcess(numGames: number, concurrency: number, policy: PolicyType, mctsConfig?: MCTSConfig, net?: InferenceSession): Promise<GameResult[]> {
  const results: GameResult[] = [];
  let started = 0;
  let timeouts = 0;

  async function worker() {
    while (started < numGames) {
      started++;
      try {
        results.push(await playGame(policy, mctsConfig, net));
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

/** Coordinator: fork N shard processes for true CPU parallelism, merge their JSONL. */
async function runShardedSelfPlay(config: Config): Promise<void> {
  const n = config.numWorkers;
  const per = Math.ceil(config.numGames / n);
  const startTime = Date.now();
  const tmps: string[] = [];
  const procs: Promise<void>[] = [];
  for (let k = 0; k < n; k++) {
    const g = Math.min(per, config.numGames - k * per);
    if (g <= 0) break;
    const tmp = join(tmpdir(), `simshard_${process.pid}_${k}.jsonl`);
    tmps.push(tmp);
    const args = ['--import', 'tsx', fileURLToPath(import.meta.url),
      '--games', String(g), '--workers', '1', '--shard',
      '--output', tmp, '--policy', config.policy,
      '--mcts-sims', String(config.mctsSims),
      '--mcts-determinizations', String(config.mctsDeterminizations)];
    if (config.net) args.push('--net', config.net);
    procs.push(new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, args, {stdio: 'inherit'});
      child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`shard ${k} exited ${code}`)));
      child.on('error', reject);
    }));
  }
  console.log(`Self-play: ${config.numGames} games across ${procs.length} shard processes...`);
  await Promise.all(procs);
  const merged = tmps.filter(t => existsSync(t)).map(t => readFileSync(t, 'utf8').trim()).filter(Boolean).join('\n');
  writeFileSync(config.output, merged + '\n');
  for (const t of tmps) { try { unlinkSync(t); } catch { /* ignore */ } }
  const elapsed = (Date.now() - startTime) / 1000;
  const count = merged ? merged.split('\n').length : 0;
  console.log(`Completed ${count} games in ${elapsed.toFixed(1)}s (${(count / elapsed).toFixed(1)} games/sec) across ${procs.length} processes`);
}

async function main() {
  const config = parseArgs();
  const evalMode = config.p1Policy !== undefined && config.p2Policy !== undefined;
  const isShard = config.shard === true;

  // Coordinator: fork N shard processes for true CPU parallelism
  if (!evalMode && config.numWorkers > 1 && !isShard) {
    await runShardedSelfPlay(config);
    return;
  }

  const log = evalMode ? console.error.bind(console) : console.log.bind(console);

  // Load ONNX net once (non-fatal on failure)
  let net: InferenceSession | undefined;
  if (config.net) {
    try {
      net = await loadNet(config.net);
      log('loaded net: ' + config.net);
    } catch (e) {
      log('WARN net load failed, falling back: ' + e);
      net = undefined;
    }
  }

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
        results.push(await playEvalGame(config.p1Policy!, config.p2Policy!, mctsConfig, net));
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

  const results = await runGamesInProcess(config.numGames, config.numWorkers, config.policy, selfPlayMctsConfig, net);

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
