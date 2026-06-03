# Handoff — Track 2C: ship the imitation net + measure on the ladder

**For:** a fresh agent continuing the north-star track after Tracks 1, 2A, 2B.
**Read first, in order:**
1. [`north-star-imitation-design.md`](./north-star-imitation-design.md) — reframe + Track 0/1/2 design + results (authoritative)
2. [`self-play-experiments.md`](./self-play-experiments.md) — the gate result that triggered the reframe (self-play is deprioritized)

## One-line state
A dual-head **value+policy** imitation net is trained (`models/imitation-dual-v2.onnx`, held-out
win-pred **0.67**, move top-1 **0.35**) and the value head is wired as the search leaf evaluator —
**but** the net isn't shipped/used in the real bot yet, and there is **no live ladder number**. 2C
closes that gap.

## What's built (on `main`, scope `eval`/`training`/`ladder`, newest first)
- `74d857f` imitation-dual-v2 (per-move policy) — move-match 0.30→0.35
- `ee69513` per-move policy features + `DualNet2` shared move scorer
- `7e6cab5` value net wired as the minimax leaf evaluator (async + blended)
- `3095aef` ladder client (`ladder/`, unit-tested core)
- earlier: `5c27e53` policy-label extraction, `8c5605a` dual-head net, imitation-dual-v1, design doc

## Key facts you need
- **Models** (`models/`, all PyTorch-ONNX with an external `.onnx.data` weights sidecar):
  - `imitation-dual-v2.onnx` — **input `state[265]`** (245 state ++ 4×5 per-move), outputs
    `win_probability` (scalar) + `policy_logits[5]`. **Use this.**
  - `imitation-dual-v1.onnx` — 245-d, value+policy (no per-move); `value-net-v1.onnx` — legacy 245-d
    value-only (the path currently shipped).
- **Action space (size 5):** `[move0..3, switch]`. Move slots are the active mon's moves **sorted by
  normalized move id** (`toID`), NOT request order. Switch (idx 4) has **no target** (replays lacked
  roster order) — pick the target by value lookahead.
- **Per-move block spec** (must match Python `_move_features` in `training/features/extract_features.py`
  EXACTLY — parity is the #1 risk). For each of the 4 moves, in sorted-move-id order:
  `[ typeEff(moveType, oppActiveTypes)/4 (cap 1.0), basePower/150 (cap 1.0), isStatus(bp==0),
     priority(move ∈ PRIORITY_MOVES), STAB(moveType ∈ playerActiveTypes) ]`. All-zero if <4 distinct
  move ids are known (at inference the `|request|`/availableActions always give 4 → always populated).

## Task — Track 2C (in order)

### 0. [BLOCKER, 1 line] Ship model weights
`scripts/post-build.mjs:~50` copies only `*.onnx`, NOT `*.onnx.data`. So the learned net's weights
never reach the built extension and ml mode silently falls back to heuristic (this also makes Track
2A's wiring inert in the build). Fix: `file.endsWith('.onnx') || file.endsWith('.onnx.data')`. Build
and confirm both files land in the extension's `models/` output.

### 1. Emit per-move features in `src/eval/features.ts`
`FEATURE_COUNT = 245` → **265**. After `writeFutilityFeatures(...)` (≈line 107) and before `return f`,
append the 4×5 block. Helpers already in this file: `getMoveTypePower(name)→[type,bp]`,
`typeEffectiveness(atk,defTypes)`, `getTypes(species)`, `PRIORITY_MOVES: Set`. Use
`snapshot.availableActions` (`MoveAction.id`/`.name`) for the full 4-move set, sort by `toID`.
**Match the Python normalization exactly** (`/4`, `/150`, sorted-id order, `bp==0` for status, STAB vs
`snapshot.player.active` types, typeEff vs `snapshot.opponent.active` types).
- **Verify parity numerically:** pick one replay turn, run Python extraction and the TS extractor on
  the same state, diff the last 20 features. A silent mismatch makes the net out-of-distribution.
- Update the feature-count test (`src/eval/features.test.ts` if present) to 265.

### 2. Load v2 + read the policy
- `eval-worker.ts:14` `MODEL_PATH` → `'models/imitation-dual-v2.onnx'`.
- `learned-eval.ts`: tensor shape `[1, 265]`; add `evaluateWithPolicy(snapshot)` returning
  `{ winProb, policy: Float32Array /*5*/ }` (read `results['policy_logits']`). The existing blended
  leaf eval (Track 2A) keeps using `win_probability` — leaf states are now 265-featured automatically.

### 3. Use the policy as a search prior
One net call on the **root** 265-vector → softmax the legal-masked logits. Map policy slot→action via
sorted-id (`ladder/protocol.ts:policyMoveOrder` shows the exact mapping; mask illegal moves to −∞).
Blend into the final ranking, e.g. `final = β·searchScore + (1−β)·policyProb` (β tunable, start ~0.7).
Switches: `policy[4]` = P(switch); the switch **target** is already handled by the search's per-switch
value eval. Keep it minimal; add a unit test that the prior shifts ranking as expected.

### 4. Measure on the real ladder (the north-star number)
Two paths:
- **Quick:** build, load the extension, play `gen9randombattle` on a registered account manually, then
  read `ratings.gen9randombattle.gxe` from `https://pokemonshowdown.com/users/<id>.json`.
- **Automated (bigger):** make `ladder/client.ts` drive the trained bot. The gap: `ladder/` only
  parses `|request|` today; `search()` needs a `BattleSnapshot`. `src/state/snapshot.ts` builds one
  from the **page** `battle` object, not from raw protocol — so you must add a **protocol state
  accumulator** (~150-200 lines: track opponent active/bench, field, hazards, boosts from
  `|switch|`/`|-weather|`/`|-sidestart|`/`|-boost|`… lines) to construct a `BattleSnapshot` in Node.
  Player side + actions come straight from `|request|`. Then plug `chooseAction` = search + net.

## Commands
```bash
npm run lint && npm test                       # before every commit
python3 -m py_compile training/**/*.py
npm run build                                  # then check dist models/ has *.onnx AND *.onnx.data
PS_USERNAME=... PS_PASSWORD=... npx tsx ladder/client.ts 20   # live ladder (registered account!)
# Re-train if needed (local, CPU; ~10min extract + ~80min/20ep on the 100K set):
cd training
python3 -m features.extract_features --input data/replays --output /tmp/d.npz --min-rating 1500 --limit 100000
python3 -m train.train_model --data /tmp/d.npz --output /tmp/m.pt --epochs 20 --batch-size 1024 --policy-weight 0.5
python3 -m export.export_onnx --model /tmp/m.pt --output ../models/imitation-dual-v2.onnx --input-dim 265
```

## Gotchas
1. **Feature parity (#1):** the 20 new TS features must byte-for-byte match Python; verify numerically.
2. **v2 needs 265 even for value-only:** its value head reads `state[:245]` internally but the ONNX
   input is `[1,265]` — always feed the full 265-vector (extractFeatures returning 265 handles it).
3. **External weights:** ship both `.onnx` and `.onnx.data` (step 0).
4. **Policy slots are sorted-by-id, not request order** — map with `policyMoveOrder`; mask illegal.
5. **Ladder needs a registered account** (guests can't earn GXE); throttle sends ≥600ms.
6. Replays: `training/data/replays/*.json` (500K; `ls` overflows — use Python glob). torch/onnx/ort
   are installed. No cloud needed — training and eval are CPU-bound (run locally).

## Acceptance
- Built extension loads `imitation-dual-v2` (step 0 fix verified), `features.ts` emits 265 with
  **verified parity**, the policy measurably reorders move ranking, `npm run lint && npm test` green,
  committed incrementally (conventional commits, update this doc + the design doc's status).
- **North-star:** a real `gen9randombattle` ladder **GXE** logged from the trained bot (manual or
  automated). That is the first measurement actually connected to the goal.

## Don't
- Don't regress non-ML play (the heuristic leaf-eval default path must stay byte-identical).
- Don't commit the per-move TS features without numerical parity vs Python.
- Don't revive self-play-from-heuristic (gate failed; it's a Phase-3 refinement at best).
