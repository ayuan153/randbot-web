# Handoff — Net-Feedback Throughput (make the loop actually learn)

**For:** a fresh agent continuing the self-play RL track.
**Read first, in order:**
1. [`self-play-rl-design.md`](./self-play-rl-design.md) — architecture + current limitations
2. [`self-play-experiments.md`](./self-play-experiments.md) — the three runs and what each taught us
3. The "Roadmap — Self-Play Scaling" / "Latest" sections of [`implementation-plan.md`](./implementation-plan.md)

## One-line state

The AlphaZero loop is closed, measured, parallelized, and the trained net is fed back into MCTS — all
validated on SageMaker. **It still doesn't learn (Elo vs random hovers ~900, never climbs).** The
binding blocker is now **net-inference latency in the MCTS hot loop**: net-backed self-play games
exceed the 30s per-game timeout on the g4dn CPU and get dropped, so net iterations train on far fewer
games than requested (e.g. 55-81 of 200). Fix throughput first, then re-test whether volume makes Elo
climb.

## What's built (on `main`, newest first, all scope `self-play`)
- `f8d9819` process-per-core self-play parallelism (coordinator forks N `--shard` workers, merges JSONL)
- `d096410` feed trained net back into MCTS (net-eval.ts, --net threaded through)
- `cfd6986` 20-feature TS extractor (parity-tested vs Python) + awaitable MCTS policy/value fns
- `1d1830a`/`6e714d7`/`c200ddb` Elo-eval reliability fixes (serial eval, cleared timer, sims, stdout
  fd, Docker-layout sim path)
- `e0969b5`/`a654819` Elo wiring (`--p1-policy/--p2-policy`, `playEvalGame`, draw handling)
- `08ecabe` heuristic HP-differential value

## Key code map
- `self-play/mcts/ismcts.ts` — ISMCTS; `runMCTS(state, legal, policyFn, valueFn, cfg)`; PolicyFn/ValueFn
  are **awaitable**; `MAX_LOOP_ITERATIONS` + 30s `GAME_TIMEOUT_MS` guards live in `battle-runner.ts`.
- `self-play/mcts/net-eval.ts` — `loadNet`, `netValueFn` (p1-perspective `(tanh+1)/2`), `netPolicyFn`
  (priors over the 10-action index space: 0-3=move1-4, 4-9=switch1-6). **ORT inference is async + per
  node** — this is the latency hot spot.
- `self-play/mcts/net-features.ts` — 20-feature extractor; `net-features.test.ts` parity-checks it
  against golden vectors in `__fixtures__/feature-parity.json` (regen via the Python extractor).
- `self-play/sim/sim-server.ts` — CLI `--games --workers --output --policy --mcts-sims
  --mcts-determinizations --p1-policy --p2-policy --net --shard`; self-play coordinator + shards; eval
  mode (serial, JSONL to fd 1).
- `self-play/sim/battle-runner.ts` — `playGame(policy, mctsConfig?, net?)`, `playEvalGame(p1,p2,cfg?,net?)`.
- `self-play/training/alphazero_loop.py` — `extract_features_from_request` (FEATURE_DIM=20),
  `parse_choice` (action→index), value target `{-1,+1}`, train + `export_onnx` (CPU).
- `self-play/training/elo_tracker.py` — `track_elo`/`play_matches`; spawns sim-server; `--net` forwards
  to eval. Prints `[Elo] vs_random=… vs_heuristic=… estimated=…`.
- `self-play/run.sh` — per iter: self-play (iter i uses `iter_{i-1}.onnx`, iter 1 cold) → train →
  Elo eval (uses `iter_i.onnx`). Env: `NUM_ITERATIONS NUM_GAMES NUM_WORKERS EPOCHS POLICY MCTS_SIMS
  RUN_ELO ELO_GAMES`.

## AWS resources
| Resource | Value |
|----------|-------|
| Profile | `randbot` (acct `516246239933`, us-east-1) — **expires ~daily; run `mwinit` to re-auth** |
| ECR | `516246239933.dkr.ecr.us-east-1.amazonaws.com/randbats-training:latest` |
| S3 out | `s3://randbats-training-516246239933/output` |
| Role | `arn:aws:iam::516246239933:role/SageMakerRandbatsRole` |
| Instance | `ml.g4dn.xlarge` — **quota 1** (stop before relaunch) |

## Exact commands
```bash
# local (repo root): lint+test before every commit
npm run lint && npm test
python3 -m py_compile self-play/training/*.py

# build + push amd64 image (~10-12 min)
./self-play/build-and-push.sh

# launch (config via --environment, NOT --hyper-parameters)
JOB=randbats-alphazero-$(date +%Y%m%d-%H%M)
aws sagemaker create-training-job --training-job-name "$JOB" \
  --algorithm-specification TrainingImage=516246239933.dkr.ecr.us-east-1.amazonaws.com/randbats-training:latest,TrainingInputMode=File \
  --role-arn arn:aws:iam::516246239933:role/SageMakerRandbatsRole \
  --resource-config InstanceType=ml.g4dn.xlarge,InstanceCount=1,VolumeSizeInGB=50 \
  --output-data-config S3OutputPath=s3://randbats-training-516246239933/output \
  --stopping-condition MaxRuntimeInSeconds=7200 \
  --environment NUM_ITERATIONS=5,NUM_GAMES=200,EPOCHS=10,NUM_WORKERS=4,POLICY=mcts,MCTS_SIMS=16,RUN_ELO=1,ELO_GAMES=30 \
  --profile randbot --region us-east-1

# monitor (use filter-log-events; grep the [Elo] line and the "across N processes" throughput line)
STREAM=$(aws logs describe-log-streams --log-group-name /aws/sagemaker/TrainingJobs \
  --log-stream-name-prefix "$JOB" --profile randbot --region us-east-1 \
  --query 'logStreams[0].logStreamName' --output text)
aws logs filter-log-events --log-group-name /aws/sagemaker/TrainingJobs --log-stream-names "$STREAM" \
  --filter-pattern 'Elo' --profile randbot --region us-east-1 --query 'events[*].message' --output text

# stop (required before relaunch) / retrieve model
aws sagemaker stop-training-job --training-job-name "$JOB" --profile randbot --region us-east-1
aws s3 cp s3://randbats-training-516246239933/output/$JOB/output/model.tar.gz /tmp/m.tar.gz --profile randbot --region us-east-1
```

## Gotchas (hard-won)
1. **Image must be amd64** (dev Mac is arm64); `build-and-push.sh` pins `--platform linux/amd64`.
2. **Config via `--environment`** (no sagemaker-training-toolkit in the image).
3. **Finish under the 7200s cap** or `/opt/ml/model` is never copied → no model. Per-iteration Elo is
   still in CloudWatch even if capped, so a capped run still yields the trend.
4. **`--workers` now parallelizes self-play** (process-per-core). Eval is intentionally serial.
5. **Net self-play games time out** at 30s `GAME_TIMEOUT_MS` on g4dn (ORT latency). This is THE bug to
   fix (see task). Raising the timeout alone just makes iters slower; reduce inference cost.
6. **Fast vs slow rebuilds:** changing `self-play/sim|mcts/*` busts the cu121 pip layer → full ~12-min
   build. Changing only `self-play/training/*.py` is COPY'd after pip → **~25s rebuild**. (Optional
   win: reorder the Dockerfile to COPY source after `pip install` to make all rebuilds fast.)
7. **`mwinit`** — `randbot` creds expire ~daily; re-auth when AWS calls return a Midway error.
8. **Verify in logs:** `Using device: cuda`, `loaded net: …/iter_N.onnx` (self-play), `Self-play: …
   across N shard processes`, and the per-iter `[Elo]` line.
9. **macOS has no `timeout`** binary; long ops should run detached + polled.

## Your task — make net feedback compound (Elo climbs)

Tier 1 proved parallelism works but net self-play is inference-bound. Do these in order:

1. **Fix net-inference throughput** so net self-play games finish under the timeout. Options (cheapest
   first): (a) **cache** net evaluations per determinized state within a move (many MCTS sims re-eval
   similar states); (b) **cut** `MCTS_SIMS`/`numDeterminizations` for net self-play; (c) **raise
   `GAME_TIMEOUT_MS`** for net games AND parallelize/scale so wall-clock stays bounded; (d) batch
   inference (harder — tree search is sequential). Verify locally: a net self-play game must complete
   in « 30s and `Completed N games` must equal the requested count on SageMaker.
2. **Renormalize `netPolicyFn` priors over legal actions** (currently unnormalized; reviewer-flagged) —
   small correctness win for search guidance.
3. **Re-run the volume test** (e.g. 5 × 200-400 games) and check whether Elo vs random now climbs with
   net iters getting their full game count.
4. **If still flat, switch strategy to bootstrap** (the cold-start net is always competitive): keep
   heuristic-guided self-play for data, train the net, and use it at eval/deploy — rather than
   from-scratch net-vs-net. This is likely the best ROI on a 1-g4dn budget.

### Acceptance
- Net self-play completes its full requested game count on SageMaker (no mass timeouts).
- A Completed run whose per-iteration `vs_random` Elo **climbs** (final > first by more than ~1 noise
  band, i.e. clearly, not luck), OR a documented bootstrap result that beats the ~900 plateau.
- `npm run lint && npm test` + `py_compile` green; commit + push incrementally (conventional commits,
  scope `self-play`); update `self-play-experiments.md` with the new run.

### Don't
- Don't touch the browser extension or `models/value-net-v1.onnx` (245-feature; self-play net is
  20-feature — incompatible until Tier 2 feature unification).
- Don't launch a second g4dn job without stopping the first (quota 1).
