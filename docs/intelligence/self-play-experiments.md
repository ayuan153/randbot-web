# Self-Play Experiments Log

Chronological record of SageMaker self-play validation runs, their configs, results, and what each
taught us. For architecture see [`self-play-rl-design.md`](./self-play-rl-design.md); for the current
next task see [`handoff-netfeedback-throughput.md`](./handoff-netfeedback-throughput.md).

All runs: `ml.g4dn.xlarge` (4 vCPU, 1 T4), AWS profile `randbot` (acct `516246239933`, us-east-1),
image `…/randbats-training:latest`, config via `--environment`, `MaxRuntimeInSeconds=7200`.

## Per-iteration Elo convention

Each iteration logs `[Elo] vs_random=… vs_heuristic=… estimated=…` to CloudWatch. `vs_random` is
anchored at 800 (random ≈ 800), `vs_heuristic` at 1000. The acting agent is MCTS; the net (when used)
is iteration i's freshly-trained `iter_i.onnx`. Elo is from 30 games/baseline unless noted (noisy:
±~60-90 Elo).

## Runs

### Tier 0 — heuristic value + Elo wiring (`tier0-20260530-1004`)
- Config: 5 iters × 40 games, sims=16, **heuristic value** (no net feedback), eval games=30.
- vs_random Elo: **920 → 870 → 912 → 1041 → 1041** (records 20-10 … 24-6).
- Result: ✅ acceptance met (final ≥ first, positive). MCTS+heuristic beats random 65-80%.
- Lesson: the loop + Elo plumbing works; a heuristic leaf value gives MCTS a real signal. Elo is
  flat-in-expectation because the agent is identical each iteration (no learning fed back).

### Tier 0.5 — net fed back into MCTS, 40 games (`tier05-20260530-1449`)
- Config: 5 iters × 40 games, sims=16, **net feedback on** (iter i self-play uses iter_{i-1}.onnx;
  iter 1 cold; eval uses iter_i.onnx). Completed ~56 min.
- vs_random Elo: **1079 → 920 → 939 → 947 → 920** (records 25-5, 20-10, 20-9, 21-9, 20-10).
- Result: ❌ no climb. The cold-start net (iter 1, trained on diverse heuristic-MCTS games) is the
  strongest; net-vs-net self-play then settles flat at ~930.
- Lesson: net feedback is correctly wired (net loads in container, beats random) but does not compound
  at 40 games/iter — too little volume; net-vs-net narrows the distribution and the tiny 20-feat net
  overfits its own play. Matches the design doc's "cold start needs huge volume" open question.

### Tier 1 — process-per-core parallelism + 200 games (`tier1-20260530-2035`)
- Config: 5 iters × **200 games**, NUM_WORKERS=4, sims=16, net feedback on. Completed Dur 6411s (~107
  min, just under cap).
- Parallelism: ✅ iter 1 (cold) "200 games in 900s across 4 processes" — ~4× speedup (serial ≈ 3600s).
- **Net self-play timed out:** games actually completed per iter = `200, 58, 76, 81, 55`. Net-backed
  games (iters 2-5) exceed the 30s `GAME_TIMEOUT_MS` (slow onnxruntime-node inference, ~35 async
  infers/move, on the g4dn CPU) and are dropped → **net iters were data-starved** (fewer games than
  even Tier 0.5).
- vs_random Elo: **800 → 976 → 1007 → 847 → 912** — still no climb.
- Result: ⚠️ inconclusive volume test. Parallelism works, but it cannot deliver volume when each net
  game times out.
- Lesson: the binding constraint for net feedback is **ORT inference latency in the MCTS hot loop**,
  not game count. Fix inference throughput before testing volume again.

### Tier 1.5 — net-eval cache + legal-action prior renorm (`randbats-alphazero-20260531-0049`)
- Changes: commit b932f83 (session-scoped net-eval cache keyed on the 20-float feature vector, shared by the policy and value calls) + commit b09fb18 (renormalize MCTS priors over each node's legal actions). Same config as Tier 1, so the cache is the only changed variable.
- Config: 5 iters × 200 games, NUM_WORKERS=4, sims=16, net feedback on. Completed ~1h52m, under the 7200s cap; model.tar.gz saved.
- Local: a net self-play game dropped to **2.7s** (38 turns, 16 sims × 5 dets), **97.5% cache hit rate** (200 logical infers → 5 ORT forward passes per move — the 20-feature vector is so coarse that ~5 unique vectors cover a whole move's search).
- SageMaker game counts: iter1=200/200 (heuristic), iter2=130/200, iter3=120/200, iter4=114/200, iter5=130/200 — vs Tier 1's 200/58/76/81/55, the cache roughly **doubled** net-game completion.
- vs_random Elo: **920.4 → 975.7 → 846.6 → 947.2 → 938.7** — still no climb (within noise).
- Result: ⚠️ throughput improved but net self-play still drops ~18-22% of games; Elo flat.
- Lesson: the cache cuts inference CALL COUNT (dedups policy+value and repeated coarse states) but not per-call CONTENTION. On the g4dn (4 vCPU) the 4 shard processes each run multi-threaded onnxruntime-node, oversubscribing the CPU and inflating per-inference latency until long net games brush the 30s cap (single-process locally a game was 2.7s). Diagnosed fix for the residual: cap ORT intra/inter-op threads to 1 per shard (4 shards × 1 = 4 threads on 4 vCPUs). Volume was not the cure for the flat Elo.

### Bootstrap — heuristic-data self-play + accumulation (`randbats-bootstrap-20260531-0252`)
- Change: commit 0c565e6 (BOOTSTRAP mode). Self-play uses heuristic MCTS (no --net → no ORT in the hot loop); training accumulates ALL iterations' JSONL (cat iter_*.jsonl); eval still uses iter_i.onnx (serial).
- Config: BOOTSTRAP=1, 5 iters × 150 games, NUM_WORKERS=4, sims=16, EPOCHS=10, ELO_GAMES=30. Completed ~86 min, under cap; model.tar.gz (4.35 MB) saved.
- Self-play: ALL 5 iters **150/150, ZERO timeouts** (iter times ~756/652/771/582/695s) — throughput fully solved (heuristic self-play has no inference in the hot loop).
- Accumulation: **150 → 300 → 450 → 600 → 750** games (train samples ~27k → 50k+); early training loss improving (0.777 → 0.765).
- vs_random Elo: **1125.2 → 967.7 → 975.7 → 938.7 → 800.0** (DECLINING; iter5 at the 800 floor). vs_heuristic: 929.6 → 1092.2 → 1024.9 → 939.5 → 1070.4 (volatile, no trend). estimated ~1027 → 935.
- Result: ❌ no climb; vs_random got WORSE with more accumulated data, so the bootstrap did NOT beat the ~900 plateau.
- Lesson (decisive): with clean full-volume accumulated data and zero throughput issues, the net STILL doesn't improve and degrades on vs_random as it trains on more data. This rules out throughput AND volume as the binding constraint. The cause is the **20-feature representation**: too coarse (~5 unique feature vectors per move) to support a discriminative policy/value, so more training collapses the net toward base rates, making it a worse MCTS guide than the heuristic. The binding constraint is REPRESENTATION (design-doc Tier 2: unify with the 245-feature `src/eval/features.ts`), not throughput or volume.

### Tier 2 — 225-feature bootstrap (`randbats-bootstrap-rich-20260601-1119`)
- Change: full-Battle 225-feature extractor (commits 6bf9eab/7ef44d8/024a7e8, dep fix 4efdfe9) replacing the 20-feature request extractor. Records per-turn p1Features/p2Features vectors; Python trains directly on them (no re-extraction/parity); net widened to 225->256->256; accurate @smogon/calc damage/KO features. Bootstrap mode (heuristic self-play + cross-iter data accumulation).
- Config: BOOTSTRAP=1, 5 iters × 150 games, NUM_WORKERS=4, sims=16, EPOCHS=10, ELO_GAMES=30. Completed ~92 min, under cap; model.tar.gz (3.9 MB) saved.
- Self-play: ALL 5 iters **150/150, zero timeouts/crashes** from the new feature code. Accumulation 150 -> 300 -> 450 -> 600 -> 750.
- Training loss (final/iter): **0.18, 0.25, 0.23, 0.28, 0.28** — MUCH lower than the 20-feature net's ~0.77. The rich representation is far more learnable / the net fits the data well.
- vs_random Elo: **947.2 -> 894.9 -> 975.7 -> 1079.6 -> 870.4** (peaks at 1079.6 in iter 4, above the ~1041 MCTS+heuristic ceiling and the ~900 plateau, but NOT retained). vs_heuristic: 1023.2 -> 1000.0 -> 1046.6 -> 1085.6 -> 984.9.
- Result: ❌ no SUSTAINED climb — high-variance oscillation (range ~210), final (870) below first (947). Representation bottleneck is resolved (loss 0.77->0.18) and the net reached 1080 at one iter, but no monotonic learning curve.
- Lessons: (a) the 225-feature representation IS learnable (loss collapse) — so representation was a real bottleneck and is now lifted; (b) the experiment is UNDERPOWERED to detect a climb: 30-game eval carries +-60-90 Elo noise, so the 5-point range (~210) is consistent with pure noise around a ~950-1000 mean; (c) the trainer fresh-initializes the net each iter and data grows only 150->750, so the 5 Elo points are ~independent noisy (net, eval) samples, NOT a learning curve; (d) iter5's drop may also be overfitting/forgetting on the 750-game set. Next levers: low-noise eval (hundreds of games per baseline; e.g. an eval-only job over the saved iter_*.onnx, since a full 5-iter run can't fit high ELO_GAMES under the 7200s cap with serial eval); a proper data-volume learning curve (150 vs 1k vs 5k games); warm-start or train/val early-stopping.

## Cross-run takeaways

1. **Plumbing is solid:** loop closes, Elo logs, models export (`iter_1..5.onnx` + `checkpoint.pt` +
   `elo_iter_*.json` in `model.tar.gz`), onnxruntime-node runs in the container, parallelism is real.
2. **Elo never climbs** across iterations in any config (hovers ~900 vs random, i.e. 65-80% win).
3. **Two compounding blockers:** (a) volume — from-scratch AlphaZero needs far more self-play than one
   g4dn gives; (b) net-inference latency — net self-play games time out at 30s, starving net iters.
4. **The cold-start net is consistently competitive**, suggesting heuristic-guided data + a trained
   net used at eval/deploy time (bootstrap) may beat from-scratch net-vs-net at this budget.
5. Throughput is solvable but was never the real blocker for learning. The net-eval cache (Tier 1.5) doubled net-game completion and a net game runs in 2.7s locally; bootstrap (heuristic self-play) eliminates self-play timeouts entirely. Neither made Elo climb.
6. CONFIRMED binding constraint = the 20-feature representation, not throughput or volume. The bootstrap run gave the net clean, growing, full-volume data (150→750 games) with zero dropped games, and vs_random Elo still declined (1125→800). The coarse features (~5 unique vectors/move) cap what any net can learn; more data collapses it toward base rates. Next real lever is Tier 2 feature unification (245-feature src/eval/features.ts), then growing the net.
7. Representation was a genuine bottleneck but not the last one. The 225-feature extractor cut training loss 0.77->0.18 and the net reached 1080 vs_random at one iteration (above the heuristic ceiling), yet no run shows a SUSTAINED climb. The binding constraint is now EVAL SIGNAL-TO-NOISE and experiment design: 30-game eval (+-60-90 Elo) cannot resolve a plausible-size improvement, and fresh-init + 150->750 data is not a learning curve. Next: low-noise eval over saved nets + a real data-volume sweep.

## Cost/time notes
- A 5-iter run is ~$0.40-0.50 and ~55-107 min depending on games/iter.
- Quota = 1 g4dn → **stop a job before launching another**; wait ~60-90s for the instance to release.
- g4dn CPU is ~2.5× slower per game than an Apple-silicon dev Mac; size runs accordingly.
