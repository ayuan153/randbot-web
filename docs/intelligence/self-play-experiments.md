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

## Cross-run takeaways

1. **Plumbing is solid:** loop closes, Elo logs, models export (`iter_1..5.onnx` + `checkpoint.pt` +
   `elo_iter_*.json` in `model.tar.gz`), onnxruntime-node runs in the container, parallelism is real.
2. **Elo never climbs** across iterations in any config (hovers ~900 vs random, i.e. 65-80% win).
3. **Two compounding blockers:** (a) volume — from-scratch AlphaZero needs far more self-play than one
   g4dn gives; (b) net-inference latency — net self-play games time out at 30s, starving net iters.
4. **The cold-start net is consistently competitive**, suggesting heuristic-guided data + a trained
   net used at eval/deploy time (bootstrap) may beat from-scratch net-vs-net at this budget.

## Cost/time notes
- A 5-iter run is ~$0.40-0.50 and ~55-107 min depending on games/iter.
- Quota = 1 g4dn → **stop a job before launching another**; wait ~60-90s for the instance to release.
- g4dn CPU is ~2.5× slower per game than an Apple-silicon dev Mac; size runs accordingly.
