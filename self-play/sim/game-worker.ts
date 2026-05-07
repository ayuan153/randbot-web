/**
 * game-worker.ts — Worker thread that runs batches of games.
 * Receives { numGames } from parent, posts back GameResult[] when done.
 *
 * Note: For TypeScript execution, the parent must spawn this worker with
 * execArgv: ['--import', tsxLoaderFileUrl] to enable TS support.
 * For compiled JS (after `npm run build`), no special setup is needed.
 */

import {parentPort, workerData} from 'node:worker_threads';
import {runGame, type GameResult} from './battle-runner.ts';

const {numGames} = workerData as {numGames: number};

async function main() {
  const results: GameResult[] = [];
  for (let i = 0; i < numGames; i++) {
    try {
      results.push(await runGame());
    } catch {
      // Skip timed-out games
    }
  }
  parentPort!.postMessage(results);
}

main().catch(err => {
  console.error('Worker failed:', err);
  parentPort?.postMessage({error: err.message});
});
