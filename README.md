# randbats-bot

Chrome extension that suggests optimal moves for Pokémon Showdown Random Battles, powered by a neural network trained on 500K+ games.

## Quick Start

```bash
npm install
npm run dev:launch   # builds + launches Chrome with extension loaded
```

Navigate to [play.pokemonshowdown.com](https://play.pokemonshowdown.com/), start a Gen 9 Random Battle, and the overlay appears on turn 1.

## How It Works

1. **Hooks** into Pokémon Showdown's `app.receive()` to intercept battle protocol
2. **Extracts** full battle state (team, field, opponent reveals)
3. **Models** the opponent via Bayesian set narrowing (eliminates impossible sets as info is revealed)
4. **Searches** via depth-2 expectiminimax with alpha-beta pruning
5. **Evaluates** leaf nodes with an ONNX neural network (MLP, 65% win prediction accuracy)
6. **Displays** ranked suggestions in a Shadow DOM overlay

## Architecture

```
hook.ts (PAGE) → bridge.ts (CONTENT) → sw.ts (SERVICE WORKER) → eval-worker.ts
                                                                    ├── minimax.ts
                                                                    ├── learned-eval.ts (ONNX)
                                                                    ├── features.ts (206 features)
                                                                    ├── damage.ts (@smogon/calc)
                                                                    └── opponent-model.ts
                                                                          ↓
                                                                  overlay (Preact, Shadow DOM)
```

## Training the Model

```bash
cd training && pip install -r requirements.txt
python -m scraper.download_replays --count 100000
python -m features.extract_features --input data/replays --output data/training_data.npz
python -m train.train_model --data data/training_data.npz
python -m export.export_onnx --model models/value-net-v1.pt --output ../models/value-net-v1.onnx
npm run build  # picks up the new model
```

Data source: HuggingFace dataset (31.7M replays), filtered for gen9randombattle rated 1400+.

## Dev Mode

When loaded as an unpacked extension, the overlay shows:
- Bot's internal evaluation scores and search tree stats
- Opponent model state (revealed moves/items/abilities, remaining possible sets)
- Feature vector values feeding the neural network

## Turn Logging

Each turn's evaluation is logged internally. Click the download icon in the overlay to export JSON logs containing:
- Snapshot state, feature vectors, model outputs, search results
- Useful for debugging predictions and identifying model weaknesses

## Testing

```bash
npm test          # 48 unit tests (Vitest)
npm run lint      # ESLint + type checking
npm run test:watch
```

Tests cover: snapshot parsing, opponent model narrowing, scoring heuristics, feature extraction, minimax correctness.

## Project Structure

```
src/
├── inject/hook.ts           # PAGE world: patches app.receive()
├── content/bridge.ts        # Relays state, mounts overlay
├── worker/sw.ts             # Service worker: routes messages
├── eval/
│   ├── eval-worker.ts       # Web Worker: runs search
│   ├── minimax.ts           # Expectiminimax + alpha-beta
│   ├── scoring.ts           # Heuristic fallback evaluator
│   ├── learned-eval.ts      # ONNX inference wrapper
│   ├── features.ts          # 206-feature extraction
│   ├── damage.ts            # @smogon/calc wrapper
│   └── opponent-model.ts    # Bayesian set narrowing
├── ui/overlay.tsx           # Preact overlay (Shadow DOM)
└── types.ts                 # Shared interfaces
training/
├── scraper/                 # Replay download + filtering
├── features/                # Feature extraction (Python)
├── train/                   # PyTorch training
└── export/                  # ONNX export
models/
└── value-net-v1.onnx        # Trained model
```

## Key Dependencies

| Package | Purpose |
|---------|---------|
| `@smogon/calc` | Damage calculation |
| `@pkmn/data` | Pokemon/move/ability data |
| `onnxruntime-web` | Neural network inference in browser |
| `preact` | Lightweight overlay UI |
| `vite` | Multi-entry extension build |

## Roadmap

See [docs/intelligence/implementation-plan.md](docs/intelligence/implementation-plan.md) for the full phased plan:
- Phase 1 ✅ Learned evaluation (ONNX neural net)
- Phase 2: Search improvements (move ordering, iterative deepening, depth 3-4)
- Phase 3: ISMCTS + policy network
- Phase 4: Self-play RL
