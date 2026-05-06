# Intelligence Implementation Plan

A phased roadmap to evolve randbats-bot from a heuristic depth-2 searcher (~1000 Elo) to a neural-net-guided MCTS engine (~1600+ Elo).

---

## Current State

| Component | Status |
|-----------|--------|
| Search | Depth-2 expectiminimax with alpha-beta pruning |
| Damage | `@smogon/calc` (JS, 16-roll average per calc) |
| Opponent model | Bayesian set narrowing — eliminates impossible sets as moves/items/abilities are revealed |
| Evaluation | Hand-tuned heuristic (HP%, hazards, status, boosts, speed tiers, role value) |
| Extension | Chrome extension with dev mode, turn logging, Shadow DOM overlay |
| Performance | ~50-200 positions/second |
| **Estimated strength** | **~1000-1100 Elo** |

### Key Decision

**`@pkmn/engine` only supports Gen 1.** It cannot be used for Gen 9 Random Battles. The original Phase 1 (faster search via @pkmn/engine WASM) is blocked.

**Pivot**: Learned evaluation (previously Phase 2) is now the highest-impact next step. A neural net trained on high-Elo replays will dramatically improve position assessment without requiring a faster simulator. Search improvements become Phase 2 (achievable with move ordering and pruning alone).

---

## Phase 1: Learned Evaluation Function (2-4 weeks) — CURRENT

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

## Phase 2: Search Improvements (1-2 weeks) — NEXT

**Goal**: Reach depth 3-4 with better move ordering and pruning under a 5-second time budget. Target ~1400-1500 Elo.

### Tasks

#### 2.1 Move ordering heuristic

Order moves to maximize alpha-beta cutoffs:

1. **KO moves** (predicted to faint opponent's active) — highest priority
2. **STAB super-effective moves** — likely high damage
3. **Status moves on healthy targets** (Thunder Wave, Toxic, etc.)
4. **Switches into resistances** (type advantage on predicted opponent move)
5. **Everything else** — sorted by base power × STAB × effectiveness

Expected improvement: 3-5x more cutoffs → effectively +1 depth for free.

#### 2.2 Iterative deepening with time control

- Start at depth 1, increase until time budget (5s) runs out
- Return best result from deepest completed search
- Aspiration windows: narrow alpha-beta bounds based on previous iteration's score

#### 2.3 Transposition table

- **Key**: Zobrist hash of (active mons, HP buckets, field conditions, boosts)
- **Value**: (depth, score, best_move, flag: EXACT|LOWER|UPPER)
- **Size**: 2^18 entries (~4MB), LRU eviction

#### 2.4 Null-move-style pruning

Skip evaluation of clearly dominated moves early (e.g., using a weak move when a KO move exists).

### Deliverables

| Artifact | Description |
|----------|-------------|
| `src/eval/move-ordering.ts` | Heuristic move ordering |
| `src/eval/iterative-deepening.ts` | Time-controlled iterative deepening |
| `src/eval/transposition-table.ts` | Zobrist hash + TT lookup/store |
| `scripts/bench-search.ts` | Benchmark script |

---

## Phase 3: ISMCTS + Policy Network (1-2 months) — FUTURE

**Goal**: Properly handle hidden information via Monte Carlo sampling. Target ~1500+ Elo.

### Overview

Random Battles have significant hidden information (opponent's unrevealed moves, items, sets, team members, damage rolls). ISMCTS addresses this by:

1. **Determinizing**: Sample opponent's hidden info from Bayesian model
2. **Searching**: MCTS with UCB1 selection over information sets
3. **Evaluating**: Value net scores leaf nodes (no random rollouts)
4. **Guiding**: Policy network provides prior probabilities for move selection

### Key Components

- ISMCTS with 8-12 determinizations per search
- Policy network (MLP, trained on 1500+ Elo player actions, ~35-40% top-1 accuracy)
- UCB1 with policy priors: `Q(a) + c * P(a) * sqrt(N_parent) / (1 + N(a))`
- Inference batching (16-32 leaf nodes per batch)

### Deliverables

- `src/search/ismcts.ts` — Full ISMCTS implementation
- `src/search/determinize.ts` — Sample concrete states from information set
- `training/train/policy_net.py` — Policy network training
- `models/policy-net-v1.onnx` — Trained policy model

---

## Phase 4: Self-Play + Exploitation (2-3 months) — STRETCH

**Goal**: Exceed the ceiling of human replay data through self-play RL. Target ~1600+ Elo.

### Overview

- Self-play training loop generating games with latest nets
- PPO or AlphaZero-style training (MCTS policy targets)
- Opponent exploitation layer (detect patterns, adjust priors)
- Endgame solving (1v1 Nash equilibrium, 2v2 CFR)

### Key Components

- Self-play arena using `@pkmn/sim` for game generation
- Pattern tracker for opponent tendencies (switch frequency, status usage, Tera timing)
- 1v1 Nash solver (game matrix → linear program)
- 2v2 CFR solver (~1000 iterations convergence)

### Deliverables

- `training/self-play/arena.py` — Self-play game generation
- `training/self-play/train_loop.py` — RL training loop
- `src/exploit/pattern-tracker.ts` — Per-game opponent pattern detection
- `src/endgame/nash-solver.ts` — 1v1 Nash equilibrium solver
- `models/value-net-v2-selfplay.onnx` — Self-play trained nets

---

## Success Metrics

| Phase | Metric | Target | How to measure |
|-------|--------|--------|----------------|
| 1 | Value net accuracy | >65% | Held-out validation set |
| 1 | Win rate vs heuristic | >60% | 500-game A/B test |
| 1 | Inference latency | <10ms/position | Browser profiling |
| 2 | Effective search depth | 3-4 plies | Iterative deepening log |
| 2 | Win rate vs Phase 1 | >55% | 500-game A/B test |
| 3 | Ladder Elo | 1500+ | 200+ rated games on PS ladder |
| 3 | Simulations/second | >1000 | MCTS benchmark |
| 4 | Ladder Elo | 1600+ | 200+ rated games on PS ladder |

---

## Key Dependencies

| Package | Purpose | Phase |
|---------|---------|-------|
| `@smogon/calc` | Damage calculation (search + display) | All |
| `onnxruntime-web` | Browser ML inference (WASM backend) | 1+ |
| `PyTorch` | Model training (Python) | 1, 3, 4 |
| `onnx` | Model export format | 1+ |
| `replay.pokemonshowdown.com` | Training data source | 1, 3 |
| `@pkmn/sim` | Test fixture generation | All |
| `@pkmn/data` | Pokemon/move/ability data | All |

---

## Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Replay API rate limiting | Slows data collection | Use HuggingFace parquet dataset (31.7M replays, no rate limit) |
| ONNX Runtime Web performance | Slow inference blocks search | Quantize model to int8, reduce features, batch inference |
| Overfitting to replay meta | Bot plays outdated strategies | Include only recent replays (last 3 months), periodic retraining |
| Chrome extension CSP blocks WASM | Can't load ONNX runtime | Use offscreen document (relaxed CSP) |
| 206 features insufficient | Low accuracy ceiling | Iterate on feature engineering, add per-move features if needed |
| Self-play mode collapse (Phase 4) | Degenerate strategies | Diverse opponent pool, noise injection, ladder validation |

---

## Timeline

```
Week 1-2:   Phase 1a — Replay scraper, feature extraction, initial training
Week 3-4:   Phase 1b — ONNX export, browser integration, A/B testing
Week 5-6:   Phase 2  — Move ordering, iterative deepening, depth 3-4
Week 7-10:  Phase 3  — ISMCTS, policy net, integration + tuning
Week 11-18: Phase 4  — Self-play, exploitation, endgame solving
```

All timelines assume single developer, part-time (~20 hrs/week). Phases are sequential.

---

## Decisions Log

| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-05-05 | `@pkmn/engine` only supports Gen 1. Pivoting to Phase 2 (learned eval) as priority. | Cannot use for Gen 9 Random Battles. Search improvements alone (without faster sim) give diminishing returns at depth 2. |
| 2026-05-05 | Using HuggingFace dataset (31.7M replays) as primary data source. | Avoids rate limiting from replay.pokemonshowdown.com, parquet format is efficient for filtering. |
| 2026-05-05 | Feature vector design: ~206 fixed-size features. | Compact enough for fast inference (<10ms), rich enough to capture key battle dynamics. Expandable if accuracy plateaus. |
