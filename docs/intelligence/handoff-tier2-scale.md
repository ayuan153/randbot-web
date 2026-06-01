# Handoff — Tier 2 done, validate-then-scale

**For:** a fresh agent continuing the self-play RL track after the Tier 2 feature work.
**Read first, in order:**
1. [`self-play-rl-design.md`](./self-play-rl-design.md) — architecture + limitations
2. [`self-play-experiments.md`](./self-play-experiments.md) — every run incl. Tier 2 (newest at bottom)
3. [`feature-design-tier2.md`](./feature-design-tier2.md) — the 225-feature schema + result

## One-line state

The representation bottleneck is **fixed**: a 225-feature full-Battle extractor replaced the old
20-feature one (training loss fell ~0.77 → ~0.18; a trained net hit **1080 vs_random** at one
iteration, above the heuristic ceiling). But **no run shows a *sustained* Elo climb**, and the reason
is now **measurement**, not representation: 30-game eval carries ±60–90 Elo noise and the loop
(fresh-init net each iter, data only 150→750) is not a learning curve. **Do not commit big compute
until a cheap, low-noise probe confirms the net actually gets stronger with more data.**

## What's built (this phase, on `main`, newest first, scope `self-play`)
- `f7e3937` docs: Tier 2 run log + eval-noise diagnosis
- `4efdfe9` fix: add `@smogon/calc` to `self-play/package.json` (container `npm ci` only installs
  self-play deps — root-hoisted deps are NOT present in the image)
- `024a7e8` train on recorded 225-d vectors + widen net (225→256→256)
- `7ef44d8` record per-turn `p1Features`/`p2Features`; net-eval uses `extractFeatures` on the Battle
- `6bf9eab` 225-feature `extractFeatures(battle, side)` (full Battle state + @smogon/calc damage)
- `c3e2b50` Tier 2 design doc
- (earlier) `b932f83`/`b09fb18` net-eval cache + prior renorm; `0c565e6` BOOTSTRAP mode

## Key code map (deltas from the prior handoff)
- `self-play/mcts/net-features.ts` — `extractFeatures(battle, side)` (FEATURE_DIM=225, perspective-
  relative, normalized; finite-sanitized + null-guarded so it never throws on simulated states) and
  the legacy `extractFeatures20`. Damage/KO via `estimateDamageFrac` (@smogon/calc, ~5 calcs/extract).
- `self-play/mcts/net-eval.ts` — `netValueFn` extracts side `'p1'` (ISMCTS p1-perspective);
  `netPolicyFn(perspective)`; ORT input `[1,225]`; session-scoped cache.
- `self-play/sim/battle-runner.ts` — `TurnRecord` now carries `p1Features`/`p2Features`; recorded at
  decision time (before `battle.choose()`).
- `self-play/training/alphazero_loop.py` — trains directly on recorded vectors (2 perspective-
  symmetric samples/turn); `FEATURE_DIM=225`; no request re-extraction.
- `self-play/training/policy_value_net.py` — `input_dim=225`, 256×256 trunk.
- `self-play/run.sh` — `BOOTSTRAP=1` ⇒ heuristic self-play (no `--net`, no timeouts) + `cat
  iter_*.jsonl` accumulation; eval unchanged (serial, `--net iter_i.onnx`). **No `EVAL_ONLY` mode yet.**

## AWS resources
| Resource | Value |
|----------|-------|
| Profile | `randbot` (acct `516246239933`, us-east-1) — expires ~daily; run `mwinit` on a Midway error |
| ECR | `516246239933.dkr.ecr.us-east-1.amazonaws.com/randbats-training:latest` |
| S3 out | `s3://randbats-training-516246239933/output` |
| Role | `arn:aws:iam::516246239933:role/SageMakerRandbatsRole` |
| Instance | `ml.g4dn.xlarge` — **quota 1** (stop before relaunch); 7200s max runtime |
| Latest model | `s3://…/output/randbats-bootstrap-rich-20260601-1119/output/model.tar.gz` — 225-feature `iter_1..5.onnx` + `checkpoint.pt` + `elo_iter_*.json` |

## Your task — validate the signal, then prepare to scale

### Phase A — cheap validation gate (1× g4dn; do this FIRST)
1. **Add an `EVAL_ONLY` mode** to `run.sh` (gate like BOOTSTRAP): skip self-play+train; run
   `elo_tracker.py` over a set of provided `iter_*.onnx` with a high `ELO_GAMES` (e.g. 300–500).
   (Eval is serial; a high game count fits because there's no self-play/train in the job.)
2. **Low-noise comparison:** pull the saved `iter_1..5.onnx` from the rich run's `model.tar.gz` and
   eval each at ≥300 games/baseline. Question: does the later/more-data net beat the earlier one
   **beyond tight CIs** (±~25 Elo at 300 games)?
3. **Data-volume sweep:** train the 225-feature net on 150 vs ~1–2k accumulated games and eval each at
   low noise. Question: does strength rise **monotonically** with data?
4. **Gate:** strength clearly ↑ with data ⇒ proceed to Phase B / big compute. Flat ⇒ diagnose
   (overfit? value-target sign/þmagnitude? policy-target quality? net capacity?) before spending.

### Phase B — scaling prep (parallelizable; needed to exploit big compute)
- **Training that compounds:** warm-start from the prior checkpoint (or principled re-init) + a
  train/val split + early stopping + **save the BEST net, not the last** (the iter-5 collapse was
  last-net + noise).
- **Eval that scales:** parallelize or decouple eval so it isn't the serial bottleneck and
  `ELO_GAMES` isn't cap-bound.
- **Actor/learner split:** many parallel self-play actors → S3 → a learner that aggregates (Tier 1
  design). Request a g4dn **quota increase** (or move to a g5 / multi-GPU) and **checkpoint mid-run**
  so the wall-clock cap is non-fatal.
- **Capacity + volume:** bigger net and far more self-play once "more data helps" is confirmed.

## Exact commands
```bash
# local (repo root): always before committing
npm run lint && npm test
python3 -m py_compile self-play/training/*.py

# build + push amd64 image (changing self-play/sim|mcts busts the npm-ci layer → full rebuild;
# changing only training/*.py or run.sh is a fast COPY layer)
./self-play/build-and-push.sh

# launch (config via --environment, NOT --hyper-parameters)
JOB=randbats-<name>-$(date +%Y%m%d-%H%M)
aws sagemaker create-training-job --training-job-name "$JOB" \
  --algorithm-specification TrainingImage=516246239933.dkr.ecr.us-east-1.amazonaws.com/randbats-training:latest,TrainingInputMode=File \
  --role-arn arn:aws:iam::516246239933:role/SageMakerRandbatsRole \
  --resource-config InstanceType=ml.g4dn.xlarge,InstanceCount=1,VolumeSizeInGB=50 \
  --output-data-config S3OutputPath=s3://randbats-training-516246239933/output \
  --stopping-condition MaxRuntimeInSeconds=7200 \
  --environment BOOTSTRAP=1,NUM_ITERATIONS=5,NUM_GAMES=150,EPOCHS=10,NUM_WORKERS=4,POLICY=mcts,MCTS_SIMS=16,RUN_ELO=1,ELO_GAMES=30 \
  --profile randbot --region us-east-1
# (for EVAL_ONLY, swap the --environment for your EVAL_ONLY=1,ELO_GAMES=400,... once implemented)

# monitor (grep the [Elo] line + per-iter game counts)
STREAM=$(aws logs describe-log-streams --log-group-name /aws/sagemaker/TrainingJobs \
  --log-stream-name-prefix "$JOB" --profile randbot --region us-east-1 \
  --query 'logStreams[0].logStreamName' --output text)
aws logs filter-log-events --log-group-name /aws/sagemaker/TrainingJobs --log-stream-names "$STREAM" \
  --filter-pattern 'Elo' --profile randbot --region us-east-1 --query 'events[*].message' --output text

# stop (required before relaunch) / fetch a model
aws sagemaker stop-training-job --training-job-name "$JOB" --profile randbot --region us-east-1
aws s3 cp s3://randbats-training-516246239933/output/$JOB/output/model.tar.gz /tmp/m.tar.gz --profile randbot --region us-east-1
```

## Gotchas (hard-won)
1. **Runtime deps must be in `self-play/package.json`.** The Dockerfile `cd /app/self-play && npm ci`
   installs ONLY self-play deps; locally things resolve via root `node_modules` hoisting and HIDE a
   missing self-play dep (this bit us with `@smogon/calc`). Add any new runtime import there + refresh
   `package-lock.json`, and smoke-test a container-style run.
2. **`extractFeatures` must stay finite + non-throwing** on simulated/determinized states (the net is
   called on them during search). Keep the finite-sanitization pass and null-guards; a NaN feature ⇒
   NaN loss, a throw ⇒ silently dropped eval games.
3. **Eval is serial and noisy.** 30 games ≈ ±60–90 Elo. Don't trust single-iter Elo deltas. This is
   the #1 thing to fix before reading any "climb".
4. **7200s cap ⇒ no model saved** (per-iter Elo still lands in CloudWatch). Size runs accordingly;
   add mid-run checkpointing for longer runs.
5. amd64 buildx image; `--environment` not `--hyper-parameters`; quota 1 g4dn (stop before relaunch);
   `mwinit` on Midway errors; macOS has no `timeout` (run detached + poll).
6. We use **`@pkmn/sim` in-process** (clone via `toJSON/fromJSON` for MCTS), NOT the Showdown
   `simulate-battle` CLI.

### Acceptance (next phase)
- Phase A: a **low-noise** (≥300 games) measurement that the 225-feature net's strength **rises with
  training data** (beyond CIs) — or a documented negative result + root-cause. THEN big compute.
- Always: `npm run lint && npm test` + `py_compile` green; commit + push incrementally (conventional
  commits, scope `self-play`); log every run in `self-play-experiments.md`.

### Don't
- Don't commit big compute before Phase A measures a signal.
- Don't touch the browser extension or `models/value-net-v1.onnx` (245-feature, separate from the
  self-play 225-feature net).
- Don't launch a second g4dn job without stopping the first (quota 1).
