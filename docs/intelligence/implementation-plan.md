# Intelligence Implementation Plan

A phased roadmap to evolve randbats-bot from a heuristic depth-2 searcher (~1000 Elo) to a neural-net-guided MCTS engine (~1600+ Elo).

---

## Current State

> **⚠️ 2026-06-02 — Direction changed.** The self-play-from-heuristic track below is **deprioritized**
> (a low-noise gate proved more bootstrap data doesn't help — it's behavioral cloning of the heuristic;
> see `self-play-experiments.md`). The **primary track is now supervised human-imitation + real
> measurement**. Authoritative docs:
> - `docs/intelligence/north-star-imitation-design.md` — Tracks 0/1/2 design + results (READ FIRST)
> - `docs/intelligence/HANDOFF.md` — the next task (2C) + ready-to-run handoff
> Self-play RL is now a Phase-3 refinement on top of a human prior, not the foundation.

### Latest (2026-06-02) — Reframe; human-imitation net trained + wired into search

- **Reframe:** stopped self-play-from-heuristic; pivoted to imitation from 31.7M human replays + a
  real ladder measurement. Rationale + evidence in `north-star-imitation-design.md`.
- **Track 1 (done):** dual-head value+policy net trained on 5.0M decisions from 100K games ≥1500.
  Held-out **win-pred 0.67**, **move top-1 0.30** (`models/imitation-dual-v1.onnx`).
- **Track 2A (done):** the learned value net now **drives** depth-2 search as a blended async leaf
  evaluator (was a metadata overlay). `src/eval/minimax.ts` + `eval-worker.ts`.
- **Track 2B (done):** per-move policy features → **move top-1 0.30→0.35** (`imitation-dual-v2.onnx`,
  265-dim input, `DualNet2`).
- **Track 0 (built):** `ladder/` Showdown rated-ladder client (unit-tested core); needs an account to
  run live for the first real GXE.
- **Next = Track 2C** (HANDOFF.md): emit per-move features in `src/eval/features.ts`, swap the
  shipped model to `imitation-dual-v2`, use the policy as a search prior, and measure on the ladder.
  **Blocker found:** `scripts/post-build.mjs` doesn't copy `.onnx.data` weight sidecars → the learned
  net never loads in the built extension (ml mode silently falls back to heuristic). 1-line fix, do
  this first.

| Component | Status |
|-----------|--------|
| Search | Depth-2 expectiminimax; learned value net wired as a blended async leaf eval (Track 2A) |
| Damage | `@smogon/calc` (JS, 16-roll average per calc) |
| Opponent model | Bayesian set narrowing — eliminates impossible sets as moves/items/abilities are revealed |
| Evaluation | Imitation dual-head net (value+policy); `imitation-dual-v2.onnx` 265-d (not yet shipped — see 2C) |
| Extension | Chrome extension with dev mode, turn logging, Shadow DOM overlay |
| Performance | ~50-200 positions/second |
| **Estimated strength** | **~1000-1100 Elo (offline proxy only; no live ladder GXE yet)** |

### Latest (2026-05-06)

- Model v3: 245 features, 65.5% accuracy, trained on 5M samples from 500K replays
- Features include speed, type matchup, turns-to-KO, setup/stall detection
- Pivoting to self-play training (AlphaZero-style) for next improvement

### Latest (2026-05-29)

- **Self-play (AlphaZero) pipeline is validated end-to-end on AWS SageMaker** (GPU + ISMCTS,
  5 iterations, retrievable ONNX). See Phase 2 → "Validation run #3" below.
- **Shipped browser bot is unchanged** — the self-play net is 20-feature and not compatible with
  the browser's 245-feature `learned-eval.ts`; v1 model is untouched.
- **Next work is the self-play track, not the browser.** See the new roadmap and docs:
  - `docs/intelligence/self-play-rl-design.md` — architecture, current limitations, scaling design
  - `docs/intelligence/HANDOFF.md` — Tier 0 task + ready-to-run handoff for a fresh agent
- **Immediate next step (Tier 0):** the MCTS loop is not yet "closed" (uniform policy + neutral
  value → near-random play) and there is no strength signal. Add a heuristic value + wire Elo eval,
  then confirm Elo climbs across iterations — before scaling games/features/compute.

### Latest (2026-05-30) — Tier 0 complete: loop closed + Elo wired + validated

- **Heuristic value signal:** MCTS now evaluates leaves with `mcts/heuristic-value.ts` (HP-fraction
  differential, 0..1 from p1's perspective) instead of the constant `neutralValue` — real signal.
- **Elo eval wired in:** `sim-server.ts` takes `--p1-policy/--p2-policy` (random/heuristic/mcts) and
  `run.sh` runs `elo_tracker.py` after each iteration, logging a greppable `[Elo] vs_random=… …` line.
- **Validation run** `randbats-alphazero-tier0-20260530-1004` → **Completed** (~56 min, GPU + MCTS,
  5 iterations; `model.tar.gz` has `iter_1..5.onnx` + `checkpoint.pt` + `elo_iter_1..5.json`).
  Per-iteration Elo vs the `random` baseline: **920 → 870 → 912 → 1041 → 1041** — the MCTS+heuristic
  agent beats random every iteration (65–80% win rate), and final (1041) ≥ first (920). Acceptance met.
- **Caveat (by design):** Tier 0 does **not** feed the trained net back into MCTS, so the eval agent
  is identical each iteration — Elo is positive/stable, not monotonically climbing. The upward trend
  here is partly noise; a genuine learning curve needs net-feedback (next).
- **Bugs fixed en route** (all SageMaker-only, since the eval works locally): eval crashed with
  `Cannot find package 'tsx'` because `elo_tracker.py` assumed the dev layout (`training/` nested in
  `self-play/`) but the image puts `training/` and the sim/`node_modules` as siblings under `/app`
  (now probes both); also serial eval (CPU-bound MCTS gains nothing from concurrency and was timing
  out under 4× contention), a cleared per-game timeout (dangling timer hung the process), and writing
  eval JSONL via `process.stdout.write` instead of `/dev/stdout` (EINVAL on a Linux pipe).
- **Next (completes "close the loop"):** feed the previous iteration's ONNX back as `policyFn`/
  `valueFn` (true AlphaZero) — needs a TS 20-feature extractor mirroring the Python trainer,
  onnxruntime-node inference in `battle-runner.ts`, and a `--net` arg threaded through. Then Elo
  should climb across iterations. (Throughput = Tier 1; feature unification = Tier 2.)

### Latest (2026-05-30) — Tier 0.5: net fed back into MCTS (implemented, but scale-limited)

- **Implemented + verified end-to-end.** `mcts/net-features.ts` (20-feature extractor, parity-tested
  vs the Python trainer), `mcts/net-eval.ts` (onnxruntime-node: `netValueFn` p1-perspective
  `(tanh+1)/2`, `netPolicyFn` over the 10-action index space), ismcts policy/value fns made
  awaitable, and a `--net` arg threaded through `sim-server`/`battle-runner`/`run.sh`/`elo_tracker`.
  Self-play iter i uses iter_{i-1}.onnx (iter 1 cold-starts); Elo eval iter i uses iter_i.onnx.
  onnxruntime-node loads in the cu121 container; net-backed MCTS beats random (logs show
  `loaded net: …/iter_N.onnx` each iteration).
- **Validation** `randbats-alphazero-tier05-20260530-1449` → **Completed** (~56 min). Per-iteration
  Elo vs random: **1079 → 920 → 939 → 947 → 920** (records 25-5, 20-10, 20-9, 21-9, 20-10).
- **Result: Elo does NOT climb.** The cold-start net (iter 1, trained on diverse heuristic-MCTS
  games) is the strongest; once the net-vs-net loop starts it settles to a flat ~930. Every net still
  beats random (67–83%), but feeding the net back does not compound at this scale.
- **Why (matches the "cold start vs warm start" open question):** 40 games/iter is far too little
  volume for from-scratch AlphaZero — net-vs-net self-play narrows the distribution and the tiny
  20-feature net overfits its own play, regressing slightly vs random instead of improving. This is a
  **volume bottleneck, not a code bug** (the loop is correct and verified).
- **Next:** the prerequisite for net-feedback to compound is **Tier 1 (throughput)** — parallelize
  self-play (worker_threads / process-per-core, actor/learner split) for 10–100× more games/iter.
  Alternatives worth a cheap experiment: renormalize net policy priors over legal actions (currently
  unnormalized), bootstrap value/policy from the heuristic or supervised model rather than from
  scratch, and raise MCTS sims. But the dominant lever is games/iter.

### Latest (2026-05-31) — Tier 1: process-per-core self-play (works) + volume test (inconclusive)

- **True parallelism implemented.** `sim-server.ts` now has a coordinator that forks N shard
  processes (`--shard --workers 1`), each running games/N serially, then merges their JSONL — so
  `--workers` finally scales CPU-bound MCTS across cores (was async-but-serial). Commit `f8d9819`.
- **Validation** `randbats-alphazero-tier1-20260530-2035` → **Completed** (Dur 6411s ≈ 107 min),
  config 5 iters × **200 games**/iter, NUM_WORKERS=4, sims=16, net feedback on.
- **Parallelism confirmed:** iter 1 (cold) did "200 games in 900s across 4 processes" — ~4× speedup
  (serial would be ~3600s).
- **But net self-play is timeout-bottlenecked.** Games actually completed per iter:
  `iter1(cold)=200, iter2=58, iter3=76, iter4=81, iter5=55` (each ~950s). Net-backed games exceed the
  30s `GAME_TIMEOUT_MS` because onnxruntime-node inference in the MCTS hot loop is slow on the g4dn
  CPU (~35 async infers/move), so most net games are dropped → **net iters were data-starved**
  (fewer games than even the 40-game runs).
- **Elo vs random:** `800 → 976 → 1007 → 847 → 912` — still no climb (noisy ~900).
- **Conclusion:** the binding constraint for net-feedback is **ORT inference latency in the MCTS
  loop**, not raw game count. Parallelism works, but it can't help if each net game times out. Next
  agent must fix inference throughput (batch/cache evals, raise/scale the per-game timeout for net
  games, or cut sims/determinizations for net self-play) BEFORE another volume test. See
  `self-play-experiments.md` (run log) and `HANDOFF.md` (next task).

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

### Phase 2 Progress (2026-05-29)

- ✅ Self-play Docker image built and verified locally (Colima x86_64, `@pkmn/sim` + ISMCTS + PyTorch training loop)
- ✅ AWS infrastructure provisioned: ECR repo, S3 bucket (`randbats-training-516246239933`), IAM role (`SageMakerRandbatsRole`)
- ✅ Validation training job launched on SageMaker: `randbats-alphazero-validation-20260529-1048`
  - Instance: ml.g4dn.xlarge (~$0.74/hr), 2hr max runtime
  - Config: 5 iterations, 1000 games/iteration, 10 epochs, 4 workers
  - This is a frugal validation run to confirm the pipeline works end-to-end
- ⏳ Next: monitor job completion, retrieve ONNX model from S3, integrate into extension, then plan scale-up run

### Validation run #1 — FAILED (2026-05-29)

- Job `randbats-alphazero-validation-20260529-1048` FAILED after 125s with `AlgorithmError: exit code 1`
- **CloudWatch root cause**: `[FATAL tini (14)] exec ./run.sh failed: Exec format error`
- **Diagnosis**: Docker image built on Apple Silicon (arm64) without `--platform linux/amd64`.
  Multi-arch base `nvidia/cuda:12.1.0-runtime-ubuntu22.04` defaulted to arm64; cannot exec on
  x86_64 SageMaker instance (ml.g4dn.xlarge). `run.sh` shebang and line-endings verified correct — ruled out.
- **Fix**: new `self-play/build-and-push.sh` builds with `docker buildx build --platform linux/amd64`
  and pushes to ECR. Relaunch with a new timestamped job name.
- **Status**: fix scripted; rebuild + push + relaunch pending (requires Docker + ECR creds, ~$1.50 spend)

### Validation run #2 — SUCCESS + persistence fix (2026-05-29)

- **Architecture fix worked:** Rebuilt image for `linux/amd64` (new `self-play/build-and-push.sh` using
  `docker buildx build --platform linux/amd64`; installed buildx + docker-container builder locally).
  Job `randbats-alphazero-validation-20260529-1227` (ml.g4dn.xlarge, `--environment NUM_ITERATIONS=5,NUM_GAMES=1000,EPOCHS=10,NUM_WORKERS=4`) ran to **Completed** (~24 min billable).
  All 5 iterations completed self-play → train → ONNX export. Validation success criteria MET.
- **Launch mechanism gotcha:** Image uses plain CUDA base with NO `sagemaker-training-toolkit`, so
  `--hyper-parameters` only land in `/opt/ml/input/config/hyperparameters.json` and never reach `run.sh`.
  Must pass run-config via `--environment` (NUM_ITERATIONS/NUM_GAMES/EPOCHS/NUM_WORKERS), NOT `--hyper-parameters`.
- **Persistence bug found + FIXED:** First Completed run produced an EMPTY S3 output — `run.sh` wrote
  artifacts to `$OUTPUT_DIR/models` (=/app/output/models) but never to `/opt/ml/model/` (the only dir
  SageMaker tars to S3). Fix in `self-play/run.sh`: (1) pass `--checkpoint "$OUTPUT_DIR/models/checkpoint.pt"`
  (also fixes latent resume bug — checkpoint saved to CWD while resume looked in models dir), and
  (2) append guarded `cp -r "$OUTPUT_DIR/models/." /opt/ml/model/` when `/opt/ml/model` exists.
  Proven via smoke job `randbats-alphazero-smoke-20260529-1301` (1 iter, 20 games) → real 1.4 MB
  `model.tar.gz` containing `iter_1.onnx` (+ `.onnx.data` external weights) and `checkpoint.pt`.
- **Open issues before production scale-up (BLOCKERS):**
  - **GPU unused:** requirements pull CUDA 13 torch build (`nvidia-cudnn-cu13`, `cuda-toolkit==13.0.2`)
    incompatible with g4dn driver → training ran on CPU. Pin torch to cu121 wheel (matching
    `nvidia/cuda:12.1.0` base) before scaling up.
  - **MCTS not wired into self-play:** sim battle-runner falls back to random play; models train on
    random-policy games (validates plumbing only, not strength). Wire ISMCTS policy/value guidance
    before a meaningful training run.
  - **Feature mismatch:** model is a 20-feature `PolicyValueNet` — NOT compatible with the browser's
    206-feature v1 inference (`learned-eval.ts`). Do NOT drop in as value-net-v2 without aligning
    feature space. v1 model left untouched.
- **Status / next:** Image at `randbats-training:latest` is correct (amd64 + artifact persistence).
  Real prerequisites for a useful run are the GPU/CUDA pin and MCTS wiring.

### Validation run #3 — GPU + MCTS, full 5 iterations (2026-05-29)

- **Both fixes landed and verified on SageMaker.** Job `randbats-alphazero-validation-20260529-1732`
  ran to **Completed** (billable 1922s, ~32 min, ~$0.40) on ml.g4dn.xlarge with
  `--environment NUM_ITERATIONS=5,NUM_GAMES=40,EPOCHS=10,NUM_WORKERS=4,POLICY=mcts,MCTS_SIMS=16`.
- **GPU fix (b1):** torch pinned to `2.5.1+cu121` (+ cu121 `--extra-index-url`); logs now report
  `Using device: cuda` (was CPU fallback under the cu13 build). Commit ab381a6.
- **MCTS wiring (b2):** ISMCTS now drives self-play move selection (CloneableBattle adapter via
  `@pkmn/sim` `toJSON`/`fromJSON`; uniform policy + neutral value evaluator; visit-count
  distributions recorded as `p1Policy`/`p2Policy` and consumed as the trainer's policy target).
  Configurable via `--policy`/`--mcts-sims`. Commits f3245cb, e563eb8, 18c2413.
- **Two more bugs found and fixed during the run (both committed):**
  - (1) ONNX export crashed with a cuda/cpu device mismatch once training used the GPU — fixed by
    moving the model to CPU before `torch.onnx.export` (commit 6359393).
  - (2) The MCTS game loop could hang forever on a non-progressing `wait`/`teamPreview` request
    (the async per-game timeout can't fire while JS runs synchronously) — fixed with a hard
    loop-iteration guard (commit 45cc54c).
- **Output retrieved + verified:** `model.tar.gz` (4.4 MB) contains `iter_1..5.onnx` +
  `checkpoint.pt`; onnxruntime loads `iter_5.onnx` with input `features[batch,20]`, outputs
  `policy[batch,10]` + `value[batch,1]`.
- **Tractability note:** MCTS self-play is CPU-bound/serial (~7s/game at sims=16 on g4dn), so
  games per iteration were reduced from 1000 to 40 to fit the 2-hour cap. A 100-game run was
  stopped for being too slow.
- **Still TODO before a meaningful/production run:**
  - (a) The MCTS evaluator is uniform-policy + neutral-value (AlphaZero cold start) so visit
    distributions are near-uniform and not yet stronger than random — feed the trained net back
    as `policyFn`/`valueFn` (and/or add a heuristic value) for real improvement.
  - (b) Speed up MCTS self-play (`worker_threads` / lower sims / batched inference) since it is
    far slower than random.
  - (c) The self-play net is 20-feature and NOT compatible with the browser's 206-feature v1
    model — do not drop it into `learned-eval.ts` as-is. v1 model remains untouched.

---

## Roadmap — Self-Play Scaling (Tier 0–2) — NEXT

The pipeline runs end-to-end, but **each self-play game is currently near-random**: ISMCTS uses a
uniform policy + a constant neutral value (`0.5`), the trained net is never fed back into search, and
no strength metric runs. Scaling games/features/compute on top of that just produces more near-random
data. The work is therefore ordered: make self-play *meaningful and measurable* first, then scale
throughput, then features.

### Tier 0 — Make self-play meaningful + measurable (DO FIRST)

The immediate next task. Full instructions + acceptance criteria in
`docs/intelligence/HANDOFF.md`.

1. **Give MCTS a real value signal.** Replace `neutralValue` (passed at `self-play/sim/battle-runner.ts`
   lines ~126 & ~137) with a heuristic `ValueFn` over the `@pkmn/sim` Battle (HP-fraction differential
   + fainted counts), returning a 0..1 win-prob from p1's perspective. Cheapest interim signal before
   the trained net is fed back. (Later: swap the heuristic for the trained net as `policyFn`/`valueFn`
   to truly close the AlphaZero loop.)
2. **Turn on Elo evaluation.** Wire the orphaned `self-play/training/elo_tracker.py`
   (`track_elo`/`play_matches`) into `run.sh` so each iteration evaluates the net vs the baselines in
   `self-play/sim/policies.ts` (`randomPolicy`, `heuristicPolicy`). Requires adding `--p1-policy`/
   `--p2-policy` args to `sim-server.ts`.
3. **Validate:** a 40-game × 5-iteration run that logs Elo per iteration and shows Elo trending up
   vs the random baseline. This single experiment tells us whether the architecture learns at all.

### Tier 1 — Faster + more games (throughput)

- **Split actors from the learner.** Self-play is pure CPU MCTS — it does not need a GPU. Run it on
  cheap many-core CPU instances (spot); train on GPU separately.
- **Real parallelism.** The current `--workers` are async in one Node process → zero CPU parallelism
  (hence ~7s/game serial). Use `worker_threads` or process-per-core.
- **Profile the battle clone.** `BattleAdapter` clones via `toJSON`/`fromJSON` every simulation —
  almost certainly the hot path. A faster/incremental clone multiplies sims/sec.
- Request a SageMaker quota increase (currently capped at 1 × ml.g4dn.xlarge).

### Tier 2 — More features (and make the model shippable)

- **Unify the feature extractor** with the browser's 245-feature `src/eval/features.ts`
  (self-play is currently a hand-rolled 20-feature vector in `alphazero_loop.py`). This enriches
  features *and* makes a self-play model drop-in for the extension.
- Grow the net once features are richer (the 20-feature MLP is tiny; GPU training only matters then).

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
