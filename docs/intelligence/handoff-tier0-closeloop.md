# Handoff — Tier 0: Close the MCTS Loop + Wire Elo

**For:** a fresh agent picking up the self-play RL track.
**Read first:** [`self-play-rl-design.md`](./self-play-rl-design.md) (architecture + limitations) and the
"Roadmap — Self-Play Scaling" section of [`implementation-plan.md`](./implementation-plan.md).

**One-line state:** the AlphaZero self-play pipeline runs end-to-end on SageMaker (GPU + ISMCTS,
5 iterations, retrievable ONNX), but it does **not learn yet** — MCTS plays ~randomly (uniform policy
+ constant value) and no Elo metric runs. Your job is to fix both, then prove Elo climbs.

---

## 1. Current state (verified 2026-05-29)

- Last successful run: SageMaker job `randbats-alphazero-validation-20260529-1732` → **Completed**
  (~32 min, ~$0.40, GPU + MCTS, 5 iterations). `model.tar.gz` contained `iter_1..5.onnx` +
  `checkpoint.pt`; `iter_5.onnx` loads in onnxruntime (`features[batch,20]` → `policy[batch,10]` +
  `value[batch,1]`).
- `main` is clean. Relevant commits this session (newest first):
  `c3d250a` docs · `45cc54c` MCTS loop guard · `6359393` ONNX export on CPU · `ab381a6` torch cu121 ·
  `18c2413` MCTS policy targets · `e563eb8` --policy/--mcts-sims config · `f3245cb` ISMCTS wiring ·
  `509f45f` docs · `eddd3c9` /opt/ml/model persistence · `988fe5e` build-and-push script.
- The ECR image `…/randbats-training:latest` is current (amd64 + cu121 + MCTS + all fixes).
- **Untracked local artifacts** (`self-play/checkpoint.pt`, `self-play/output/`, `.yolo-sisyphus/`)
  are leftovers — ignore; do not commit.

## 2. AWS resources

| Resource | Value |
|----------|-------|
| AWS profile | `randbot` (account `516246239933`, region `us-east-1`) |
| ECR image | `516246239933.dkr.ecr.us-east-1.amazonaws.com/randbats-training:latest` |
| S3 output | `s3://randbats-training-516246239933/output` |
| IAM role | `arn:aws:iam::516246239933:role/SageMakerRandbatsRole` |
| Instance | `ml.g4dn.xlarge` (Tesla T4) — **quota = 1** (stop a job before launching another) |

## 3. Exact commands

All from repo root `/Users/alleyuan/projects/randbats-bot` unless noted.

**Local build + test (fast, do this for every TS/py change):**
```bash
npm run lint && npm test                     # tsc --noEmit + vitest (53 tests today)
python3 -m py_compile self-play/training/alphazero_loop.py
# end-to-end CPU smoke of trainer+export on existing data:
python3 self-play/training/alphazero_loop.py --data /tmp/any.jsonl --epochs 1 \
  --output /tmp/t.onnx --checkpoint /tmp/t.pt
```

**Build + push the training image (~10–12 min; needs Docker + buildx):**
```bash
./self-play/build-and-push.sh                # buildx --platform linux/amd64 --push
```

**Launch a run (pass config via `--environment`, NOT `--hyper-parameters`):**
```bash
JOB=randbats-alphazero-validation-$(date +%Y%m%d-%H%M)
aws sagemaker create-training-job \
  --training-job-name "$JOB" \
  --algorithm-specification TrainingImage=516246239933.dkr.ecr.us-east-1.amazonaws.com/randbats-training:latest,TrainingInputMode=File \
  --role-arn arn:aws:iam::516246239933:role/SageMakerRandbatsRole \
  --resource-config InstanceType=ml.g4dn.xlarge,InstanceCount=1,VolumeSizeInGB=50 \
  --output-data-config S3OutputPath=s3://randbats-training-516246239933/output \
  --stopping-condition MaxRuntimeInSeconds=7200 \
  --environment NUM_ITERATIONS=5,NUM_GAMES=40,EPOCHS=10,NUM_WORKERS=4,POLICY=mcts,MCTS_SIMS=16 \
  --profile randbot --region us-east-1
```

**Monitor (use `filter-log-events` — `get-log-events --start-from-head` is unreliable once logs grow):**
```bash
aws sagemaker describe-training-job --training-job-name "$JOB" --profile randbot --region us-east-1 \
  --query '{S:TrainingJobStatus,Sec:SecondaryStatus,Fail:FailureReason,Dur:TrainingTimeInSeconds}'
STREAM=$(aws logs describe-log-streams --log-group-name /aws/sagemaker/TrainingJobs \
  --log-stream-name-prefix "$JOB" --profile randbot --region us-east-1 \
  --query 'logStreams[0].logStreamName' --output text)
aws logs filter-log-events --log-group-name /aws/sagemaker/TrainingJobs --log-stream-names "$STREAM" \
  --filter-pattern 'Elo' --profile randbot --region us-east-1 --query 'events[*].message' --output text
```

**Stop (required before relaunch — quota is 1; wait ~60–90s for the instance to release):**
```bash
aws sagemaker stop-training-job --training-job-name "$JOB" --profile randbot --region us-east-1
```

**Retrieve the model:**
```bash
aws s3 cp s3://randbats-training-516246239933/output/$JOB/output/model.tar.gz /tmp/m.tar.gz \
  --profile randbot --region us-east-1
mkdir -p /tmp/m && tar -xzf /tmp/m.tar.gz -C /tmp/m && ls -lh /tmp/m
```

## 4. Gotchas (hard-won — read before you burn a build/run)

1. **Image must be amd64.** Dev host is Apple Silicon (arm64); SageMaker is x86_64. An arm64 image
   fails instantly with `exec ./run.sh: Exec format error`. `build-and-push.sh` pins
   `--platform linux/amd64`. `buildx` must be installed (Docker 29 requires it); a `docker-container`
   builder is already set up locally. Builds are ~10–12 min (cu121 torch ≈ 5 GB) and the layer cache
   is often evicted between builds.
2. **Config goes in `--environment`, not `--hyper-parameters`.** The plain CUDA image has no
   sagemaker-training-toolkit, so `--hyper-parameters` only write `/opt/ml/input/config/hyperparameters.json`
   and never reach `run.sh`. `run.sh` reads `NUM_GAMES/NUM_WORKERS/NUM_ITERATIONS/EPOCHS/POLICY/MCTS_SIMS`.
3. **Artifacts must land in `/opt/ml/model`** or S3 output is empty (only that dir is tarred). `run.sh`
   copies there at the end. If `MaxRuntimeInSeconds` is hit, the job is **killed before that copy** →
   no model. **Size every run to finish comfortably under the cap.**
4. **MCTS is CPU-bound and serial** (~7s/game at `sims=16` on g4dn; `--workers` does not parallelize
   CPU). 1000 games/iter is intractable in 2 h; **40 games/iter, sims=16 ≈ 32 min total** is the
   proven-safe size for a 5-iteration validation.
5. **The async per-game timeout can't interrupt synchronous JS.** A non-progressing `wait` request
   used to hang the loop forever; a hard `MAX_LOOP_ITERATIONS` guard now breaks out
   (`battle-runner.ts`). Keep that guard.
6. **ONNX export runs on CPU** (`export_onnx` moves the model to CPU) to avoid a cuda/cpu mismatch
   when training is on GPU. Don't undo this.
7. **`run.sh` `cd`s into `self-play/`** before `node --import tsx …`; tsx relative imports break
   otherwise. Run the sim that way locally too.
8. **Verify GPU + MCTS in logs:** look for `Using device: cuda` (GPU) and
   `policy: mcts, sims: …` (MCTS). Their absence means a regression.

## 5. Your task — Tier 0

Goal: make self-play *meaningful* (real value signal) and *measurable* (Elo), then prove it learns.
Insertion points were located precisely:

1. **Heuristic value function.** Add `self-play/mcts/heuristic-value.ts` exporting a `ValueFn`
   `(state) => number` that casts `state` to the `@pkmn/sim` `Battle` (it's what `battle-adapter.ts`
   `getState()` returns), sums `hp/maxhp` over `battle.p1.pokemon` and `battle.p2.pokemon`, and returns
   `p1Total / (p1Total + p2Total)` clamped to `[0.01, 0.99]`. **Convention: 0..1 win-prob from p1's
   perspective** (matches ISMCTS terminal values + `backup`'s `1-v` flip). Replace `neutralValue` where
   it's passed to `runMCTS` in `self-play/sim/battle-runner.ts` (currently ~lines 126 & 137).
2. **Wire Elo eval (currently orphaned).** `self-play/training/elo_tracker.py` has
   `track_elo`/`play_matches`/`compute_elo`; baselines are `randomPolicy`/`heuristicPolicy` in
   `self-play/sim/policies.ts`. To use them you must add `--p1-policy`/`--p2-policy` args to
   `sim-server.ts` (route `random`→`randomPolicy`, `heuristic`→`heuristicPolicy`, `mcts`→MCTS path),
   then call the evaluator from `run.sh` after each iteration's training step and **print Elo to
   stdout** (so CloudWatch shows it). Confirm `play_matches`'s expected interface against the code.
3. **Validate:** run 5 iterations × 40 games (`sims=16`) and confirm per-iteration Elo is logged and
   trends upward vs the `random` baseline.

### Acceptance criteria

- `npm run lint && npm test` pass; `py_compile` clean. New unit test(s) cover the heuristic value
  (e.g. a lopsided HP state returns >0.5 for p1).
- A SageMaker run reaches **Completed** with `Using device: cuda` and `policy: mcts` in the logs.
- **Per-iteration Elo is logged** and the final iteration's Elo vs the `random` baseline is **positive
  and ≥ the first iteration's** (i.e. evidence the loop produces signal — exact magnitude doesn't
  matter at this scale).
- Commit + push incrementally (conventional commits, scope `self-play`), one logical change per commit.

### Notes / likely pitfalls

- MCTS with a heuristic value will be a bit slower per sim; if 40 games/iter drifts toward the cap,
  drop `MCTS_SIMS` to 12 or `NUM_GAMES` to 30 rather than risk the cap (gotcha #3).
- The heuristic only counts HP; that's intentional for Tier 0 (cheap signal). Truly "closing the loop"
  (feeding the trained net back as `policyFn`/`valueFn`) is a follow-up, not part of Tier 0.
- Don't touch the browser extension or `models/value-net-v1.onnx` — the self-play net is 20-feature
  and incompatible (browser is 245-feature). Feature unification is Tier 2.

---

## 6. Ready-to-paste prompt for the fresh agent

```
I'm working on randbats-bot at /Users/alleyuan/projects/randbats-bot (AWS profile: randbot, region
us-east-1). The AlphaZero self-play pipeline runs end-to-end on SageMaker but doesn't learn yet:
ISMCTS plays near-randomly (uniform policy + constant value) and no Elo metric runs.

Read these first, in order:
  1. docs/intelligence/handoff-tier0-closeloop.md   (your task + all commands + gotchas)
  2. docs/intelligence/self-play-rl-design.md        (architecture + limitations)
  3. the "Roadmap — Self-Play Scaling" section of docs/intelligence/implementation-plan.md

Then do Tier 0 from the handoff:
  1. Add a heuristic ValueFn (HP-fraction differential over the @pkmn/sim Battle, 0..1 from p1's
     perspective) and replace `neutralValue` in self-play/sim/battle-runner.ts.
  2. Wire the orphaned self-play/training/elo_tracker.py into run.sh (adding --p1-policy/--p2-policy
     to sim-server.ts) so each iteration logs Elo vs the random/heuristic baselines.
  3. Run a 40-game × 5-iteration SageMaker validation (ml.g4dn.xlarge, config via --environment) and
     confirm Elo is logged per iteration and trends up vs random.

Respect the handoff's gotchas (amd64 buildx image; --environment not --hyper-parameters; size runs
under the 7200s cap or the model isn't saved; stop a job before launching another — quota is 1 g4dn;
verify `Using device: cuda` + `policy: mcts` in logs; monitor via `aws logs filter-log-events`).
Run `npm run lint && npm test` before each commit, and commit + push incrementally (conventional
commits, scope `self-play`). Acceptance = a Completed run whose final-iteration Elo vs random is
positive and ≥ the first iteration's. Don't touch the browser extension or value-net-v1.onnx.
```
