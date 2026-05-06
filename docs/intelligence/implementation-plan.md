# Intelligence Implementation Plan

A phased roadmap to evolve randbats-bot from a heuristic depth-2 searcher (~1000 Elo) to a neural-net-guided MCTS engine (~1600+ Elo).

---

## Current State

- **Search**: Depth-2 expectiminimax with alpha-beta pruning
- **Damage**: `@smogon/calc` (JS, 16-roll average per calc)
- **Opponent model**: Bayesian set narrowing — eliminates impossible sets as moves/items/abilities are revealed
- **Evaluation**: Hand-tuned heuristic combining HP%, hazards, status, boosts, speed tiers, role value
- **Performance**: ~50-200 positions/second (JS damage calc is the bottleneck)
- **Estimated strength**: ~1000-1100 Elo on the Gen 9 Random Battle ladder

### Limitations

1. Depth 2 cannot see two-turn sequences (setup → sweep, double switch, sack → revenge)
2. Heuristic eval misvalues complex positions (e.g., Trick Room, weather wars, Perish Song)
3. No handling of hidden information beyond set narrowing (doesn't reason about what opponent *might* do given what they know)
4. Single-threaded, no time management

---

## Phase 1: Faster Search (1-2 weeks)

**Goal**: Reach depth 4-6 with iterative deepening under a 5-second time budget. Target ~1200 Elo.

### Tasks

#### 1.1 Integrate @pkmn/engine (Zig→WASM)

Replace `@smogon/calc` as the position evaluator inside the search tree. `@pkmn/engine` compiles the full Gen 9 battle simulator from Zig to WASM, giving us:

- Full turn simulation (moves, switches, abilities, weather, terrain, items)
- ~100x faster than JS damage calc per position
- Deterministic replay given a seed (useful for transposition tables)

Keep `@smogon/calc` for the **display layer** (showing damage ranges and KO% in the overlay) since it provides human-readable roll breakdowns.

```
engine/sim/pkmn-engine.ts
├── initEngine(): Promise<Engine>     — load WASM, initialize
├── cloneState(state): State          — cheap copy for tree search
├── applyAction(state, action): State — advance one turn
└── getLegalActions(state): Action[]   — enumerate moves + switches
```

#### 1.2 Iterative deepening with time control

```
function search(root: State, budget: 5000ms): ScoredAction {
  let bestAction = null;
  for (let depth = 1; depth <= MAX_DEPTH; depth++) {
    bestAction = minimax(root, depth, -Inf, +Inf);
    if (elapsed() > budget * 0.8) break;
  }
  return bestAction;
}
```

- Start at depth 1, increase until time runs out
- Return the best result from the deepest completed search
- Aspiration windows: narrow alpha-beta bounds based on previous iteration's score

#### 1.3 Move ordering heuristic

Order moves to maximize alpha-beta cutoffs:

1. **KO moves** (predicted to faint opponent's active) — highest priority
2. **STAB super-effective moves** — likely high damage
3. **Status moves on healthy targets** (Thunder Wave, Toxic, etc.)
4. **Switches into resistances** (type advantage on predicted opponent move)
5. **Everything else** — sorted by base power × STAB × effectiveness

Expected improvement: 3-5x more cutoffs → effectively +1-2 depth for free.

#### 1.4 Transposition table

Hash game states and cache evaluations for deterministic sub-trees:

- **Key**: Zobrist hash of (active mons, HP buckets, field conditions, boosts)
- **Value**: (depth, score, best_move, flag: EXACT|LOWER|UPPER)
- **Size**: 2^20 entries (~16MB), LRU eviction
- **Limitation**: Only valid for deterministic nodes (no random damage rolls in key)

#### 1.5 Benchmark

Create `scripts/bench-search.ts`:

- Load 20 representative battle states from test fixtures
- Run old search (depth 2, @smogon/calc) and new search (iterative deepening, @pkmn/engine)
- Measure: positions/second, wall-clock time, effective depth reached, move agreement rate

### Deliverables

| Artifact | Description |
|----------|-------------|
| `engine/sim/pkmn-engine.ts` | @pkmn/engine WASM wrapper |
| `engine/search/iterative-deepening.ts` | Time-controlled iterative deepening minimax |
| `engine/search/move-ordering.ts` | Heuristic move ordering |
| `engine/search/transposition-table.ts` | Zobrist hash + TT lookup/store |
| `scripts/bench-search.ts` | Benchmark script |
| Updated `eval-worker.ts` | Uses new engine instead of old minimax |

### Migration

Restructure `src/` into `extension/` + `engine/` split:

| Current path | New path |
|---|---|
| `src/eval/minimax.ts` | `engine/search/minimax.ts` |
| `src/eval/scoring.ts` | `engine/eval/heuristic.ts` |
| `src/eval/damage.ts` | `engine/damage/smogon-calc.ts` |
| `src/eval/opponent-model.ts` | `engine/model/opponent-model.ts` |
| `src/inject/` | `extension/inject/` |
| `src/content/` | `extension/content/` |
| `src/worker/` | `extension/worker/` |
| `src/ui/` | `extension/ui/` |

---

## Phase 2: Learned Evaluation (2-4 weeks)

**Goal**: Replace the hand-tuned heuristic with a neural network trained on high-Elo replay data. Target ~1400 Elo.

### Tasks

#### 2.1 Build replay scraper

**Source**: `replay.pokemonshowdown.com` public API

```
GET https://replay.pokemonshowdown.com/search.json?format=gen9randombattle&page=N
GET https://replay.pokemonshowdown.com/<replay-id>.json
```

**Filters**:
- Format: `gen9randombattle`
- Both players rated 1400+ Elo
- Games from last 6 months (meta relevance)

**Target**: 500K-1M games (each game yields ~40-60 training samples = one per turn)

**Output format** (`data/replays/YYYY-MM/batch-NNNN.jsonl`):
```json
{"turn": 12, "features": [...], "outcome": 1, "replay_id": "gen9randombattle-123456"}
```

**Rate limiting**: 1 request/second, resume from last page on restart, deduplicate by replay ID.

#### 2.2 Feature extraction

Fixed-size vector of **384 features** per game state:

| Feature group | Count | Description |
|---|---|---|
| My active mon | 32 | HP%, types (18 one-hot), boosts (7), status (6), has_item |
| Opp active mon | 32 | Same as above |
| My team (6 slots) | 120 | HP%, alive, types, revealed_moves_count, status per mon |
| Opp team (6 slots) | 120 | Same (using opponent model's best guess for unrevealed) |
| Field | 32 | Weather (5), terrain (4), hazards (6 per side), screens (3 per side), trick_room, tailwind |
| Matchup | 36 | Type effectiveness matrix (my active vs each opp mon, opp active vs each my mon) |
| Meta | 12 | Turn number, remaining mons count (both sides), speed tier comparison, switch_count |

All features normalized to `[0, 1]`. Categorical features one-hot encoded.

#### 2.3 Train value network

**Architecture**:
```
Input(384) → Linear(256) → ReLU → Dropout(0.2)
           → Linear(128) → ReLU → Dropout(0.2)
           → Linear(64)  → ReLU
           → Linear(1)   → Sigmoid
```

**Output**: Win probability for the player-to-move (0.0 = certain loss, 1.0 = certain win).

**Training details**:
- **Framework**: PyTorch 2.x
- **Loss**: Binary cross-entropy
- **Optimizer**: AdamW (lr=1e-3, weight_decay=1e-4)
- **Batch size**: 4096
- **Epochs**: 100 with early stopping (patience=10 on validation loss)
- **Data split**: 90% train / 10% validation (split by replay, not by turn)
- **Augmentation**: None needed (asymmetric game, no board symmetry)

**Expected accuracy**: 63-67% on held-out games (random baseline = 50%).

#### 2.4 Export to ONNX and integrate

```python
# export/export_onnx.py
torch.onnx.export(model, dummy_input, "models/value-net-v1.onnx",
                  input_names=["features"], output_names=["win_prob"],
                  dynamic_axes={"features": {0: "batch"}})
```

**Browser integration**:
- Load ONNX model in offscreen document (`extension/offscreen/ml-eval.html`)
- ONNX Runtime Web with WASM backend (WebGL fallback)
- Inference time target: <5ms per position (single sample)
- Batch inference: evaluate 50-100 leaf nodes at once for throughput

**Integration point**:
```typescript
// engine/eval/learned-eval.ts
export async function evaluate(state: BattleState): Promise<number> {
  const features = extractFeatures(state);  // → Float32Array(384)
  const [winProb] = await onnxSession.run({ features });
  return winProb * 2 - 1;  // map [0,1] → [-1,1] for minimax
}
```

#### 2.5 A/B testing

Run 500+ games of Phase 1 bot (heuristic eval) vs Phase 2 bot (learned eval) on a local PS server:

- Same search depth/time budget
- Alternate sides (p1/p2) to control for team RNG
- Measure: win rate, 95% confidence interval, average game length

### Deliverables

| Artifact | Description |
|----------|-------------|
| `training/scraper/download_replays.py` | Paginated replay downloader with rate limiting |
| `training/scraper/parse_protocol.py` | PS protocol → structured game states |
| `training/features/extract.py` | Game state → 384-dim feature vector |
| `training/train/value_net.py` | PyTorch training script with logging |
| `training/export/to_onnx.py` | Export + validation script |
| `models/value-net-v1.onnx` | Trained model (~200KB) |
| `engine/eval/learned-eval.ts` | ONNX inference wrapper |
| `engine/eval/features.ts` | TS feature extraction (mirrors Python) |
| `scripts/ab-test.ts` | Automated bot-vs-bot testing |

---

## Phase 3: ISMCTS + Policy Network (1-2 months)

**Goal**: Properly handle hidden information (opponent's unrevealed moves, items, sets) via Monte Carlo sampling. Target ~1500 Elo.

### Tasks

#### 3.1 Implement ISMCTS (Information Set Monte Carlo Tree Search)

Random Battles have significant hidden information:
- Opponent's unrevealed moves (up to 4 per mon)
- Opponent's item and ability (until revealed)
- Opponent's unrevealed team members
- Damage rolls (uniform 85-100%)

**Algorithm**:
```
function ismcts(rootState, budget: 3000ms):
  for each iteration until budget exhausted:
    1. DETERMINIZE: sample opponent's hidden info from Bayesian model
       - Pick a concrete set for each unrevealed opponent mon
       - Sample damage rolls uniformly
    2. DESCEND: traverse tree using UCB1 to select actions
    3. EXPAND: add new node for unexplored action
    4. EVALUATE: run value net on leaf state
    5. BACKPROPAGATE: update visit counts and value estimates
  
  return action with highest visit count at root
```

**Key parameters**:
- Determinizations per search: 8-12 (balance accuracy vs speed)
- Simulations per determinization: 200-500
- UCB1 exploration constant: c = 1.4 (tune empirically)
- Total simulations: ~2000-5000 per turn

**Information set handling**: Nodes in the tree represent *information sets* (what the player knows), not specific game states. A single node may correspond to multiple determinizations.

#### 3.2 Train policy network

**Architecture**:
```
Input(384) → Linear(256) → ReLU → Dropout(0.3)
           → Linear(128) → ReLU → Dropout(0.3)
           → Linear(MAX_ACTIONS) → masked_softmax
```

Where `MAX_ACTIONS = 10` (4 moves + 5 possible switches + 1 Mega/Tera/Z).

**Training data**: (state, action_chosen) pairs from 1500+ Elo players.

**Loss**: Cross-entropy between predicted action distribution and one-hot of chosen action.

**Masking**: Zero out probabilities for illegal actions before softmax.

**Expected accuracy**: ~35-40% top-1 (many positions have multiple good moves), ~70% top-3.

#### 3.3 Integrate policy + value nets in MCTS

Following AlphaZero's approach adapted for imperfect information:

- **Selection**: UCB score = `Q(a) + c * P(a) * sqrt(N_parent) / (1 + N(a))`
  - `Q(a)` = average value from backpropagation
  - `P(a)` = policy network's prior probability for action `a`
  - `N(a)` = visit count for action `a`
- **Evaluation**: Value network scores leaf nodes (no random rollouts)
- **Expansion**: Initialize new node's prior probabilities from policy net

**Inference batching**: Collect 16-32 leaf nodes, run policy+value nets in one batch for GPU-like throughput even on CPU/WASM.

#### 3.4 Tuning

Hyperparameter sweep on 1000-game matches:

| Parameter | Range | Method |
|---|---|---|
| Exploration constant (c) | 0.5 - 3.0 | Grid search |
| Determinization count | 4 - 16 | Grid search |
| Simulations per turn | 500 - 5000 | Time-budget constrained |
| Policy temperature | 0.5 - 2.0 | Grid search |
| Value weight vs rollout | 0.5 - 1.0 | Grid search |

### Deliverables

| Artifact | Description |
|----------|-------------|
| `engine/search/ismcts.ts` | Full ISMCTS implementation |
| `engine/search/tree-node.ts` | MCTS tree node with UCB1 |
| `engine/search/determinize.ts` | Sample concrete states from information set |
| `training/train/policy_net.py` | Policy network training |
| `training/export/policy_to_onnx.py` | Export policy net |
| `models/policy-net-v1.onnx` | Trained policy model (~200KB) |
| `scripts/tune-mcts.ts` | Hyperparameter tuning harness |
| Benchmark report | Win rate vs Phase 2, simulations/second |

---

## Phase 4: Self-Play + Exploitation (stretch, 2-3 months)

**Goal**: Exceed the ceiling of human replay data through self-play reinforcement learning. Target ~1600+ Elo.

### Tasks

#### 4.1 Self-play training loop

Use `@pkmn/engine` WASM for fast game simulation (no browser needed, runs in Node.js):

```
Loop:
  1. Generate 1000 games of bot vs bot (latest policy + value nets)
  2. Collect (state, MCTS_policy, game_outcome) triples
  3. Train value net on (state → outcome)
  4. Train policy net on (state → MCTS_policy)
  5. Evaluate new nets vs previous version (100 games)
  6. If win rate > 55%, accept new nets as current best
  7. Repeat
```

**Training regime**:
- **Algorithm**: PPO (Proximal Policy Optimization) or AlphaZero-style (MCTS policy targets)
- **Games per iteration**: 1000 (×~50 turns = 50K training samples)
- **Training iterations**: 100-500
- **Hardware**: Single GPU (RTX 3090 or equivalent), ~1 week for convergence
- **Checkpoint**: Save model every 10 iterations, keep best-of-N

#### 4.2 Opponent exploitation layer

While self-play finds strong general play, real ladder opponents are predictable. Add an exploitation module:

**Pattern detection** (tracked per-game):
- Switch frequency on predicted super-effective moves
- Status move usage rate
- Tendency to stay in vs switch when at low HP
- Tera type preferences (always Tera on first opportunity, or save for endgame)

**Exploitation**:
- Adjust opponent model's action probabilities based on detected patterns
- Feed adjusted probabilities into ISMCTS (opponent is no longer assumed optimal)
- Example: if opponent never switches, value setup moves higher (they won't punish)

#### 4.3 Endgame solving

For simplified endgame states (1v1, 2v2 remaining), compute exact solutions:

**1v1 endgame**:
- Enumerate all (my_move × opp_move) outcomes
- Build game matrix, solve for Nash equilibrium (linear program)
- Cache solutions by (mon1, mon2, HP_bucket, field) tuple

**2v2 endgame**:
- Use CFR (Counterfactual Regret Minimization) for 2v2 with switching
- ~1000 iterations of CFR converges for most 2v2 states
- Pre-compute common endgame archetypes, solve rest on-the-fly

### Deliverables

| Artifact | Description |
|----------|-------------|
| `training/self-play/arena.py` | Self-play game generation |
| `training/self-play/train_loop.py` | RL training loop |
| `engine/exploit/pattern-tracker.ts` | Per-game opponent pattern detection |
| `engine/exploit/exploiter.ts` | Adjust MCTS priors based on patterns |
| `engine/endgame/nash-solver.ts` | 1v1 Nash equilibrium solver |
| `engine/endgame/cfr.ts` | 2v2 CFR solver |
| `models/value-net-v2-selfplay.onnx` | Self-play trained value net |
| `models/policy-net-v2-selfplay.onnx` | Self-play trained policy net |

---

## Success Metrics

| Phase | Metric | Target | How to measure |
|-------|--------|--------|----------------|
| 1 | Positions/second | >10,000 | `scripts/bench-search.ts` |
| 1 | Effective search depth | 4-6 plies | Iterative deepening log |
| 1 | Move agreement with depth-8 | >70% | Compare shallow vs deep on fixtures |
| 2 | Value net accuracy | >65% | Held-out validation set |
| 2 | Win rate vs Phase 1 | >60% | 500-game A/B test |
| 2 | Inference latency | <5ms/position | Browser profiling |
| 3 | Win rate vs Phase 2 | >55% | 500-game A/B test |
| 3 | Ladder Elo | 1500+ | 200+ rated games on PS ladder |
| 3 | Simulations/second | >1000 | MCTS benchmark |
| 4 | Ladder Elo | 1600+ | 200+ rated games on PS ladder |
| 4 | Win rate vs Phase 3 | >55% | 500-game A/B test |

---

## Key Dependencies

| Package | Purpose | Phase | Notes |
|---------|---------|-------|-------|
| `@pkmn/engine` | Fast WASM battle simulator | 1+ | Zig→WASM, ~100x faster than JS |
| `onnxruntime-web` | Browser ML inference | 2+ | WASM backend, ~5ms per inference |
| `PyTorch` | Model training (Python) | 2,3,4 | 2.x with CUDA support |
| `onnx` | Model export format | 2+ | Bridge between PyTorch and browser |
| `replay.pokemonshowdown.com` | Training data source | 2,3 | Public API, rate-limited |
| `@pkmn/sim` | Test fixture generation | 1+ | Seeded deterministic battles |
| `@smogon/calc` | Display-layer damage info | All | Keep for overlay UI |

---

## Risks & Mitigations

| Risk | Impact | Likelihood | Mitigation |
|------|--------|------------|------------|
| `@pkmn/engine` API instability | Blocks Phase 1 search | Medium | Pin version, maintain thin adapter layer, fallback to `@smogon/calc` at reduced depth |
| Replay API rate limiting | Slows Phase 2 data collection | High | Cache aggressively, scrape incrementally over days, store raw + parsed |
| ONNX Runtime Web performance | Slow inference blocks MCTS | Medium | Quantize model to int8, reduce feature count, batch inference |
| Overfitting to replay meta | Bot plays outdated strategies | Medium | Include only recent replays (last 3 months), periodic retraining pipeline |
| WASM memory limits | Crashes in long searches | Low | Pool and reuse engine instances, limit tree size |
| Chrome extension CSP blocks WASM | Can't load @pkmn/engine | Low | Use offscreen document (relaxed CSP), or compile to asm.js fallback |
| Self-play mode collapse | Phase 4 nets find degenerate strategies | Medium | Maintain diverse opponent pool, add noise to self-play, validate on ladder |

---

## Timeline

```
Week 1-2:   Phase 1 — @pkmn/engine integration, iterative deepening, benchmarks
Week 3-4:   Phase 2a — Replay scraper, feature extraction, initial training
Week 5-6:   Phase 2b — ONNX export, browser integration, A/B testing
Week 7-10:  Phase 3a — ISMCTS implementation, policy net training
Week 11-12: Phase 3b — Integration, tuning, ladder testing
Week 13-20: Phase 4 — Self-play loop, exploitation, endgame solving
```

All timelines assume single developer, part-time (~20 hrs/week). Phases are sequential but deliverables within a phase can be parallelized.
