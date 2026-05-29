# Randbot — Living Design Doc

Current system state and design decisions for randbats-bot.

## Current State

- Chrome extension for Pokémon Showdown Gen 9 Random Battles
- Neural network evaluation: MLP (245→512→256→128→1) trained on 500K games, 65.5% win prediction accuracy
- 245 features including speed, type matchup, turns-to-KO, setup/stall detection, futility
- Depth-2 expectiminimax search with alpha-beta pruning
- Bayesian opponent model (narrows possible sets as moves/items/abilities revealed)
- Dev mode overlay + turn logging for observability
- Self-play training infrastructure built (Docker, ISMCTS, AlphaZero loop) — ready for GPU training

## Architecture

```
PAGE WORLD (hook.ts)
  ↓ postMessage(snapshot)
CONTENT SCRIPT (bridge.ts → protocol-tracker.ts, battle-session.ts)
  ↓ chrome.runtime.sendMessage
SERVICE WORKER (sw.ts)
  ↓ worker.postMessage
EVAL WORKER (eval-worker.ts)
  ├── minimax.ts (expectiminimax search)
  ├── scoring.ts (heuristic + switch evaluation)
  ├── damage.ts (@smogon/calc wrapper)
  ├── learned-eval.ts (ONNX Runtime Web inference)
  ├── features.ts (206-feature extraction)
  └── opponent-model.ts (Bayesian set narrowing)
```

## Evaluation Function

- **Primary**: ONNX neural network (MLP 206→256→128→64→1, predicts win probability)
- **Fallback**: Handcrafted heuristic (HP%, type matchup, hazards, boosts)
- **Features** (206 total):
  - Per-pokemon state ×12: HP%, active, alive, status, boosts, has_item
  - Matchup: type effectiveness, speed advantage, turns-to-KO, OHKO flags
  - Team-level: alive counts, total HP, hazard damage, type coverage
  - Field: weather, terrain, screens, tailwind
  - Tempo: setup progress, KO threats, momentum, tera state, turn number

## Opponent Model

- Tracks revealed moves/ability/item per opponent Pokémon
- Narrows possible sets from randbats data (gen9randombattle.json)
- Probability-weighted damage calculation across top 5 remaining sets
- Updates each time opponent acts (move reveal, item trigger, ability activation)

## Training Pipeline

- **Data**: HuggingFace dataset (31.7M replays), filtered for gen9randombattle rated 1400+
- **Samples**: 500K replays → 23.5M training samples (one per turn)
- **Features**: 206 fixed-size vector extracted from battle protocol
- **Model**: PyTorch MLP, BCE loss, Adam optimizer, batch 512, early stopping
- **Export**: ONNX → loaded in browser via onnxruntime-web (<10ms inference)

## Known Limitations

- **Speed awareness is weak** — model doesn't explicitly encode who outspeeds
- **Setup/stall patterns** not well understood (Calm Mind walls, toxic stall)
- **Depth-2 search** can't see 3-turn sequences (setup → sweep)
- **Deterministic** — no mixed strategy, exploitable by observant opponents
- **Wider model (512) didn't help** — features are the bottleneck, not capacity

## Next Steps

- **IMMEDIATE**: Run AlphaZero self-play training on AWS SageMaker (Docker image ready, needs ECR push + IAM role)
- After training: pull ONNX model from S3, drop into `models/`, rebuild extension
- Evaluate trained model vs baselines (Elo tracking built)
- If sim speed becomes bottleneck: build faster Rust/Zig sim for Gen 9

## Key Decisions

| Date | Decision |
|------|----------|
| 2026-05-05 | @pkmn/engine Gen 1 only — pivot to learned eval as priority |
| 2026-05-05 | HuggingFace dataset over scraping (no rate limits, 31.7M replays) |
| 2026-05-06 | Wider model (512→256→128) only +0.7% — features are the bottleneck |
| 2026-05-06 | Added 39 features (speed, type matchup, setup/stall, futility) → 245 total |
| 2026-05-06 | Self-play via AlphaZero-style ISMCTS, @pkmn/sim for Gen 9 battles |
| 2026-05-09 | Docker image verified end-to-end locally, ready for SageMaker |
