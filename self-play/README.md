# Self-Play Training Server

Runs Gen 9 Random Battles bot-vs-bot using `@pkmn/sim` to generate training data.

## Usage

```bash
npm install
npm run play                          # 100 games, 4 workers (default)
npx tsx sim/sim-server.ts --games 1000 --workers 8 --output data.jsonl
```

## Output

JSONL file with one game per line containing:
- `winner`: 'p1' or 'p2'
- `numTurns`: total turns played
- `turns[]`: per-turn requests and choices made

The Python training pipeline processes these the same way it processes replays.

## Architecture

- `sim/battle-runner.ts` — Runs a single game with random policy
- `sim/game-worker.ts` — Worker thread wrapper
- `sim/sim-server.ts` — Orchestrator (spawns workers, writes results)
- `mcts/` — Placeholder for Week 2 (MCTS policy)
