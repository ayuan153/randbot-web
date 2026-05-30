# Self-Play RL — Design & Scaling

AlphaZero-style self-play for Gen 9 Random Battles. This doc describes the architecture as built,
its current limitations, and the design for scaling it. For the live status and phased roadmap see
[`implementation-plan.md`](./implementation-plan.md); for the immediate next task see
[`handoff-tier0-closeloop.md`](./handoff-tier0-closeloop.md).

> **State (2026-05-29):** the pipeline runs end-to-end on SageMaker (GPU + ISMCTS, 5 iterations,
> retrievable ONNX), but it does **not yet learn** — see "Current Limitations".

---

## Goal

Train a policy+value network by self-play that exceeds the supervised, human-replay-trained browser
model. The self-play track is independent of the shipped extension until feature spaces are unified
(see Tier 2).

---

## Architecture (as built)

```
                          self-play/run.sh   (container ENTRYPOINT; loops N iterations)
                                  │
        ┌─────────────────────────┼──────────────────────────────┐
        │ 1. SELF-PLAY (Node/TS)   │ 2. TRAIN (Python/PyTorch)     │ 3. EVAL (Python) — NOT WIRED
        ▼                          ▼                              ▼
  sim/sim-server.ts          training/alphazero_loop.py     training/elo_tracker.py
   runs N games, writes        reads iter_N.jsonl,            (orphaned: see Limitations)
   iter_N.jsonl                trains PolicyValueNet,
        │                       exports iter_N.onnx
        ▼                            │
  sim/battle-runner.ts               ▼
   playGame('mcts')            models/iter_N.onnx + checkpoint.pt
        │                            │
        ▼                            └── copied to /opt/ml/model → S3 model.tar.gz
  mcts/ismcts.ts  ── uses ──▶  sim/battle-adapter.ts (CloneableBattle over @pkmn/sim Battle)
   runMCTS(state, legal,            clone via Battle.toJSON()/fromJSON()
     policyFn, valueFn, cfg)
```

### Components

| File | Role |
|------|------|
| `self-play/run.sh` | Container entrypoint. Loops `NUM_ITERATIONS`; each iter: self-play → train → export; copies artifacts to `/opt/ml/model`. Reads `NUM_GAMES/NUM_WORKERS/NUM_ITERATIONS/EPOCHS/POLICY/MCTS_SIMS` from env. |
| `self-play/sim/sim-server.ts` | Orchestrates `NUM_GAMES` games (async in one process), writes JSONL. CLI: `--games --workers --output --policy --mcts-sims --mcts-determinizations`. |
| `self-play/sim/battle-runner.ts` | `playGame('random'\|'mcts')`. The `mcts` path drives both sides via `runMCTS` and records visit-count distributions (`p1Policy`/`p2Policy`) per turn. |
| `self-play/sim/battle-adapter.ts` | `BattleAdapter` implements ISMCTS's `CloneableBattle` over `@pkmn/sim` `Battle` (clone = `toJSON`/`fromJSON`). `getState()` returns the raw `Battle`. |
| `self-play/mcts/ismcts.ts` | ISMCTS: determinize → select (PUCT) → expand → evaluate via `valueFn` → backup. **AlphaZero-style: no rollouts.** Exports `runMCTS`, `uniformPolicy`, `neutralValue`, `DEFAULT_MCTS_CONFIG`. |
| `self-play/sim/policies.ts` | Baseline `PolicyFn`s: `randomPolicy`, `heuristicPolicy`. |
| `self-play/training/alphazero_loop.py` | `PolicyValueNet`, `extract_features_from_request` (`FEATURE_DIM=20`), `train_model` (GPU), `export_onnx` (exports on CPU). |
| `self-play/training/elo_tracker.py` | `compute_elo`, `play_matches(model, baseline, n)`, `track_elo(model, n)`. **Orphaned** — not called anywhere. |

### Data tuple

`sim-server.ts` writes one JSONL line per game:
`{ winner, numTurns, turns: [{ turn, p1Request, p2Request, p1Choice, p2Choice, p1Policy?, p2Policy? }] }`.
The trainer builds `(state[20], policy[10], value)` per turn; `p1Policy`/`p2Policy` (MCTS visit
distributions) are used as the policy target when present, else a one-hot of the chosen action.

### Value convention

`valueFn(state) → number` in `[0,1]` = win probability **from p1's perspective**. Terminal values are
`p1=1.0 / p2=0.0 / draw=0.5`; `backup()` flips `v → 1-v` at each ply.

---

## Current Limitations (why it doesn't learn yet)

1. **Open loop / no value signal.** ISMCTS uses `uniformPolicy` + `neutralValue` (constant `0.5`).
   Because evaluation is value-fn-only (no rollouts), only simulations that *reach a terminal state*
   during selection contribute signal — vanishingly rare in ~46-turn games at low sim counts. Net
   effect: visit distributions are ~uniform, so self-play ≈ random, and the trained net is **never
   fed back** into search, so iterations don't compound.
2. **No strength metric.** `elo_tracker.py` is orphaned; nothing measures whether a run improves.
   Flying blind.
3. **Self-play is CPU-bound and serial.** `sim-server` runs games as async tasks in **one** Node
   process; MCTS compute is synchronous, so `--workers` gives no CPU parallelism (~7s/game at
   `sims=16` on g4dn). This is the throughput bottleneck — and it runs on a GPU instance that the
   self-play phase doesn't use.
4. **Feature mismatch.** Self-play uses a hand-rolled 20-feature vector; the browser uses
   `src/eval/features.ts` (`FEATURE_COUNT=245`). The self-play model therefore cannot be deployed to
   the extension as-is.
5. **Tiny model.** `PolicyValueNet` over 20 features is small enough that GPU training is not the
   bottleneck (self-play is).

---

## Scaling Design

Ordered so that each tier is only worth doing after the previous one makes its output meaningful.

### Tier 0 — Close the loop + measure (prerequisite)

- **Value signal:** start with a heuristic `valueFn` (HP-fraction differential + fainted counts over
  `battle.p1/p2.pokemon`), then graduate to feeding the previous iteration's ONNX back as
  `policyFn`/`valueFn` (true AlphaZero). The heuristic is the cheapest way to get non-random play now.
- **Eval:** wire `elo_tracker.py` into `run.sh`; evaluate each iteration vs `random`/`heuristic`
  baselines; log Elo. Add `--p1-policy/--p2-policy` to `sim-server.ts` so the eval harness can pit
  policies head-to-head.
- **Exit criterion:** Elo climbs across iterations on a small (40-game) run.

### Tier 1 — Throughput (faster + more games)

- **Actor/learner split:** self-play (CPU, many parallel actors, spot) decoupled from training (GPU).
  Self-play does not need a GPU.
- **Real parallelism:** `worker_threads` or process-per-core for self-play.
- **Faster clone:** profile and optimize `BattleAdapter` cloning (`toJSON`/`fromJSON` per sim is the
  hot path); consider incremental make/undo.
- **Distribution:** many actor instances → S3 → learner aggregates; raise the g4dn quota.

### Tier 2 — Features + capacity

- **Unify features** with the browser's 245-feature `src/eval/features.ts` (shared extractor), which
  both enriches the input and makes a self-play model deployable to the extension.
- **Grow the net** once features are richer; GPU training starts to matter.

---

## Open Design Questions

- **Cold start vs warm start:** AlphaZero-from-scratch needs huge self-play volume to escape random
  play. Bootstrapping MCTS's value/policy from the existing supervised model (or a strong heuristic)
  would be far more sample-efficient given a hobby compute budget. Decide before committing to scale.
- **Simultaneous moves:** Pokémon turns are simultaneous; the current adapter applies actions
  sequentially per side. Confirm this approximation is acceptable or model the opponent action as
  part of the stochastic environment response.
- **Determinization quality:** ISMCTS currently clones without sampling opponent hidden info from the
  Bayesian opponent model — determinizations are not yet informed. Wiring the opponent model in is a
  later quality lever.
