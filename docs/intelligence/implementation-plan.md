# Intelligence Implementation Plan

A phased roadmap to evolve randbats-bot from a heuristic depth-2 searcher (~1000 Elo) to a neural-net-guided MCTS engine (~1600+ Elo).

---

## Current State

| Component | Status |
|-----------|--------|
| Search | Depth-2 expectiminimax with alpha-beta pruning |
| Damage | `@smogon/calc` (JS, 16-roll average per calc) |
| Opponent model | Bayesian set narrowing — eliminates impossible sets as moves/items/abilities are revealed |
| Evaluation | ONNX neural net (MLP 206→256→128→64→1) + heuristic fallback |
| Extension | Chrome extension with dev mode, turn logging, Shadow DOM overlay |
| Performance | ~50-200 positions/second |
| **Estimated strength** | **~1000-1100 Elo** |

### Latest (2026-05-06)

- Model v3: 245 features, 65.5% accuracy, trained on 5M samples from 500K replays
- Features include speed, type matchup, turns-to-KO, setup/stall detection
- Pivoting to self-play training (AlphaZero-style) for next improvement

### Key Decision

**`@pkmn/engine` only supports Gen 1.** It cannot be used for Gen 9 Random Battles. The original Phase 1 (faster search via @pkmn/engine WASM) is blocked.

**Pivot**: Learned evaluation (previously Phase 2) is now the highest-impact next step. A neural net trained on high-Elo replays will dramatically improve position assessment without requiring a faster simulator. Search improvements become Phase 2 (achievable with move ordering and pruning alone).

---

## Phase 1: Learned Evaluation Function (2-4 weeks) — DONE

**Goal**: Replace heuristic scorer with neural net trained on replays. Target ~1300-1400 Elo.

### Data Pipeline

- **Source**: HuggingFace dataset (31.7M replays, parquet) OR fresh scraping via `replay.pokemonshowdown.com/search.json`
- **Filter**: `gen9randombattle`, rating >= 1400
- **Target**: 500K-1M games (each yields ~40-60 training samples, one per turn)
- Protocol format is identical to live PS — our existing snapshot parser works directly
- The `inputlog` field gives ground-truth player decisions
- **Rate limiting** (if scraping): 1 req/sec, resume from last page, deduplicate by replay ID

### Feature Vector (~206 features)

```
Per-Pokemon (×12 = 156 features):
  hp_fraction, is_active, is_alive, status (7 one-hot),
  atk/def/spa/spd/spe boosts (normalized), has_item

Matchup Features (8):
  best_move_type_eff, their_best_type_eff, speed_advantage,
  our_turns_to_ko, their_turns_to_ko, can_ohko, they_can_ohko, matchup_score

Team-Level (12):
  alive_counts, total_hp_fractions, hazard_damage,
  type_coverage_scores, fainted_counts, status_counts

Field (18):
  weather (6 one-hot), terrain (5 one-hot), screens, tailwind

Tempo (12):
  setup_progress, ko_threats, momentum, tera_state, turn_number
```

All features normalized to `[0, 1]`. Categorical features one-hot encoded.

### Model Architecture

- **MLP**: 206 → 256 → 128 → 64 → 1
- **Activation**: ReLU (hidden), Sigmoid (output)
- **Output**: Win probability for the player whose perspective we're evaluating from
- **Loss**: Binary cross-entropy
- **Optimizer**: Adam, lr=1e-3
- **Batch size**: 512
- **Epochs**: ~50-100 with early stopping (patience=10 on validation loss)
- **Validation**: 10% holdout (split by replay, not by turn), target >65% accuracy

### Integration

- Export to ONNX format
- Load in offscreen document via ONNX Runtime Web (`onnxruntime-web` npm package)
- Replace `evaluate(state)` in minimax with `model.predict(featureVector)`
- Feature extraction runs in the eval worker (pure TS, no DOM)
- Inference time target: <10ms per position

```typescript
// src/eval/learned-eval.ts
export async function evaluate(state: BattleState): Promise<number> {
  const features = extractFeatures(state);  // → Float32Array(206)
  const [winProb] = await onnxSession.run({ features });
  return winProb * 2 - 1;  // map [0,1] → [-1,1] for minimax
}
```

### Deliverables

```
training/
  scraper/          Replay download + filtering
  features/         Feature extraction from battle protocol
  train/            PyTorch training script
  export/           ONNX export + validation
models/
  value-net-v1.onnx
src/eval/
  learned-eval.ts   ONNX inference wrapper
  features.ts       Feature extraction (TS, mirrors Python version)
```

### Milestones

1. Replay scraper working, 100K games downloaded and filtered
2. Feature extraction pipeline producing training data
3. Model trained, >65% accuracy on holdout
4. ONNX export working, inference in browser <10ms
5. Integrated into extension, A/B test vs heuristic

### Success Criteria

| Metric | Target | How to measure |
|--------|--------|----------------|
| Value net accuracy | >65% | Held-out validation set |
| Win rate vs heuristic | >60% | 500-game A/B test (same search depth) |
| Inference latency | <10ms/position | Browser profiling |
| Model size | <500KB | ONNX file size |

---

## Phase 2: AlphaZero-Style Self-Play (3 weeks) — CURRENT

**Goal**: Train via self-play to exceed human replay ceiling. Target ~1400+ Elo.

**Architecture**:
```
AWS (SageMaker/EC2 p5)
├── self-play/sim/          Node.js: @pkmn/sim battle server (multi-core)
├── self-play/mcts/         TypeScript: ISMCTS with policy/value guidance
├── self-play/training/     Python: PyTorch AlphaZero training loop (GPU)
└── self-play/elo/          Python: Elo tracking against baselines
```

**Week 1: Infrastructure + Sim Server**
- @pkmn/sim wrapped in Node.js game server (bot vs bot)
- Generates random teams, plays full games, outputs (state, action, outcome) tuples
- Multi-core: worker_threads for parallel games (~2000-4000 games/sec)
- Docker container for AWS deployment

**Week 2: MCTS + Training Loop**
- ISMCTS: determinize opponent hidden info, run MCTS per sample, aggregate
- Policy net: 245 features → softmax over legal actions (guides MCTS exploration)
- Value net: existing architecture (245 → 512 → 256 → 128 → 1)
- Training loop: self-play (MCTS) → collect trajectories → train policy+value → export checkpoint → repeat

**Week 3: Tuning + Deployment**
- Hyperparameter tuning (MCTS sims per move, exploration constant, temperature)
- Elo tracking: play against fixed baselines (random, heuristic, v3 model)
- Deploy best checkpoint to extension via ONNX export
- Scale training if budget allows

**Key Parameters**:
- MCTS simulations per move: 100-400
- Self-play games per iteration: 50K-100K
- Training batch size: 2048
- Learning rate: 1e-4 (lower for RL stability)
- Temperature: 1.0 early, 0.3 late game (for exploration)
- Determinizations per move: 5-10 (sample opponent hidden info)

**Infrastructure**:
- Sim: Node.js with worker_threads, 16+ cores
- Training: PyTorch on V100/A100 GPU
- Storage: S3 for checkpoints and game logs
- Flexible: works on EC2, SageMaker, or any Docker-compatible GPU instance

---

## Phase 3: Exploitation + Endgame Solving (2-3 months) — FUTURE

**Goal**: Exceed the ceiling of self-play through opponent exploitation and endgame solving. Target ~1600+ Elo.

### Overview

- Opponent exploitation layer (detect patterns, adjust priors)
- Endgame solving (1v1 Nash equilibrium, 2v2 CFR)

### Key Components

- Pattern tracker for opponent tendencies (switch frequency, status usage, Tera timing)
- 1v1 Nash solver (game matrix → linear program)
- 2v2 CFR solver (~1000 iterations convergence)

### Deliverables

- `src/exploit/pattern-tracker.ts` — Per-game opponent pattern detection
- `src/endgame/nash-solver.ts` — 1v1 Nash equilibrium solver
- `models/value-net-v3-selfplay.onnx` — Self-play trained nets

---

## Success Metrics

| Phase | Metric | Target | How to measure |
|-------|--------|--------|----------------|
| 1 | Value net accuracy | >65% | Held-out validation set |
| 1 | Win rate vs heuristic | >60% | 500-game A/B test |
| 1 | Inference latency | <10ms/position | Browser profiling |
| 2 | Ladder Elo | 1400+ | 200+ rated games on PS ladder |
| 2 | Self-play games/sec | >2000 | Sim benchmark (multi-core) |
| 3 | Ladder Elo | 1600+ | 200+ rated games on PS ladder |

---

## Key Dependencies

| Package | Purpose | Phase |
|---------|---------|-------|
| `@smogon/calc` | Damage calculation (search + display) | All |
| `onnxruntime-web` | Browser ML inference (WASM backend) | 1+ |
| `PyTorch` | Model training (Python) | 1, 2, 3 |
| `onnx` | Model export format | 1+ |
| `replay.pokemonshowdown.com` | Training data source | 1 |
| `@pkmn/sim` | Self-play game simulation | 2+ |
| `@pkmn/data` | Pokemon/move/ability data | All |

---

## Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Replay API rate limiting | Slows data collection | Use HuggingFace parquet dataset (31.7M replays, no rate limit) |
| ONNX Runtime Web performance | Slow inference blocks search | Quantize model to int8, reduce features, batch inference |
| Overfitting to replay meta | Bot plays outdated strategies | Include only recent replays (last 3 months), periodic retraining |
| Chrome extension CSP blocks WASM | Can't load ONNX runtime | Use offscreen document (relaxed CSP) |
| Self-play mode collapse | Degenerate strategies | Diverse opponent pool, noise injection, ladder validation |
| ISMCTS determinization quality | Poor search with bad opponent samples | Use Bayesian opponent model to inform determinizations |
| GPU training cost | Budget overrun | Start with small runs, scale only after validating Elo gains |

---

## Timeline

```
Week 1-2:   Phase 1a — Replay scraper, feature extraction, initial training ✅
Week 3-4:   Phase 1b — ONNX export, browser integration, A/B testing ✅
Week 5-7:   Phase 2  — Self-play infrastructure, ISMCTS, training loop
Week 8-12:  Phase 3  — Exploitation, endgame solving, ladder testing
```

All timelines assume single developer, part-time (~20 hrs/week). Phases are sequential.

---

## Decisions Log

| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-05-05 | `@pkmn/engine` only supports Gen 1. Pivoting to Phase 2 (learned eval) as priority. | Cannot use for Gen 9 Random Battles. Search improvements alone (without faster sim) give diminishing returns at depth 2. |
| 2026-05-05 | Using HuggingFace dataset (31.7M replays) as primary data source. | Avoids rate limiting from replay.pokemonshowdown.com, parquet format is efficient for filtering. |
| 2026-05-05 | Feature vector design: ~206 fixed-size features. | Compact enough for fast inference (<10ms), rich enough to capture key battle dynamics. Expandable if accuracy plateaus. |
| 2026-05-06 | Wider model (512→256→128) only +0.7% over narrow. Features are the bottleneck, not capacity. | 64.9% vs 64.2% — diminishing returns from model size. Investment should go into feature engineering. |
| 2026-05-06 | Adding ~40 new features focused on speed, matchup dynamics, setup/stall patterns. | Speed awareness, type matchup depth, turns-to-KO, setup detection, stall detection, futility signals. |
| 2026-05-06 | Starting AlphaZero-style self-play. @pkmn/sim is fast enough (~2000-4000 games/sec multi-core). | Building own sim deferred unless sim becomes bottleneck. Human replay ceiling reached at 65.5% accuracy. |
| 2026-05-06 | Using ISMCTS (not pure MCTS) to handle hidden information via determinization. | Random Battles have significant hidden info (opponent sets, unrevealed mons). Determinization samples from Bayesian model to handle this properly. |
