/**
 * battle-runner.ts — Runs a single Gen 9 Random Battle to completion.
 * Both sides play random legal moves. Returns the full game trajectory.
 */

import {BattleStreams, Teams} from '@pkmn/sim';
import {TeamGenerators} from '@pkmn/randoms';

// Register the random team generator
Teams.setGeneratorFactory(TeamGenerators);

export interface TurnRecord {
  turn: number;
  p1Request: object;
  p2Request: object;
  p1Choice: string;
  p2Choice: string;
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
