# Tier 2 — Richer Feature Representation (design, for sign-off)

Self-play's net uses only **20 features** and provably can't learn (bootstrap run with clean
full-volume data still declined: vs_random 1125→800). Research (competitive mechanics + existing
battle AIs) and a map of our extractable data converge on a richer, first-principles representation.
See `self-play-experiments.md` for the runs and `.yolo-sisyphus/handoff/research-*.md` +
`data-surface.md` for the raw research.

## The core unlock

The MCTS value/policy fns **already receive the full `@pkmn/sim` Battle** (via
`BattleAdapter.getState()`) but only read `.activeRequest`. The entire battle state — weather,
terrain, pseudo-weather (Trick Room/Tailwind/Gravity), side conditions (hazards + screens), active
boosts/volatiles/status/toxic-counter, stored stats, types, Tera state, PP, full team — is in hand
and unused. The "request-only" ceiling existed only because the **Python trainer re-extracts from the
recorded request**.

## Architecture decision (Option A — recommended)

**Compute features once in TS (`extractFeatures(battle, side)`), record the per-turn vector
(`p1Features`/`p2Features`) in the JSONL, and have Python train directly on the recorded vectors.**

- Eliminates the TS/Python parity burden entirely (delete `extract_features_from_request`; no parity
  test). One extractor, used identically at self-play, eval, and (later) deploy.
- Unlocks the full battle state immediately.
- Cost: changing the feature set requires re-running self-play. Acceptable — bootstrap self-play is
  cheap and reliable (150/150, no timeouts). (Alternative Option B = record a structured state
  snapshot and re-extract in Python: faster feature iteration, but reintroduces two-extractor parity
  because the TS search path still needs its own extractor. Rejected for that reason.)

### Train/deploy consistency (important)
Extract features on the **concrete (determinized) Battle state**. In self-play we have perfect info;
at deploy, MCTS already determinizes the opponent into a concrete set. Extracting on the concrete
state makes training and deployment see the same kind of input, so we **omit opponent-*uncertainty*
features** (the determinization already represents uncertainty). The Bayesian opponent model feeds
the determinizer, not the feature vector.

### Latency
Keep features to cheap structural lookups. For damage/KO signal use a **lightweight inline estimate**
(Gen-V formula: BP × STAB × type-eff × stat-ratio, normalized) — **not** `@smogon/calc` (not a
self-play dep; too slow per MCTS node). The net-eval cache still keys on the vector; the bootstrap
path doesn't call the net in the hot loop anyway. Precise `@smogon/calc` rolls are a P2/future option.

## Proposed feature vector (~220, perspective-relative)

`extractFeatures(battle, side)` → fixed-length `Float32Array`, all normalized to ~[0,1]/[-1,1],
"my" vs "opp" relative to `side`. Value target = win prob from `side`.

| # | Group | Size | Pri | Source (all from Battle unless noted) |
|---|-------|------|-----|----------------------------------------|
| A | Global field | 15 | P0 | weather 1-hot(5)+turns(1); terrain 1-hot(5)+turns(1); trickroom(1)+turns(1); gravity(1) |
| B | Side conditions ×2 sides | 18 | P0 | per side(9): SR, spikes/3, tspikes/2, web, reflect, lightscreen, auroraveil, tailwind, screen-turns/8 |
| C | Active blocks (mine+opp) | 88 | P0 | per active(44): hp(1), status 1-hot(7), tox/sleep counter(1), boosts ÷6 (7), type membership 1-hot(18), key volatiles(8: sub/leechseed/taunt/encore/confusion/protect/yawn/disable), tera-available(1)+terastallized(1) |
| D | My 4 moves | 40 | P0 | per move(10): BP norm, category 1-hot(3), type-eff vs opp active, priority norm, disabled, pp-frac, est-dmg %opp-HP, KO flag |
| E | Team reserve ×2 sides | 36 | P1 | per side, 6 mons ×(hp-frac, fainted, statused) |
| F | Team aggregates | 12 | P0 | alive÷6 ×2, ΣHP÷6 ×2, #healthy÷6 ×2, #resist-opp-STAB÷6 ×2, #threaten-opp÷6 ×2, hazard-removal-known ×2 |
| G | Speed/priority control | 6 | P0 | outspeed flag, speed ratio, my-priority, opp-priority, TR-favors-me, my-tailwind |
| H | Item/ability flags ×2 active | 10 | P1 | choice-locked, boots, leftovers, lifeorb, item-consumed |

**Total ≈ 225** (P0 ≈ 179, P1 ≈ 46). Lands in the research's 150–300 "competitive" band.

P2 / future (not in v1): precise `@smogon/calc` rolls; per-reserve matchup vs opp active; randbats
set-posterior features; ability-identity embedding; move secondary-effect probabilities.

## Implementation plan (after sign-off)

1. `self-play/mcts/net-features.ts`: add `extractFeatures(battle, side)` (replaces `extractFeatures20`);
   add a tiny type-chart + inline damage helper. Unit-test shape, normalization ranges, determinism.
2. `self-play/sim/battle-runner.ts` (~turn-record build): record `p1Features`/`p2Features` from the
   live battle. Wire `net-eval.ts`/search to use the new extractor on the Battle (not the request).
3. `self-play/training/alphazero_loop.py`: train on recorded `*Features` vectors; set `FEATURE_DIM`
   to the new length; drop `extract_features_from_request`; widen the MLP (e.g. 225→256→256→heads).
4. Re-export ONNX (input dim change), `npm run lint && npm test`, local game timing.
5. Bootstrap run (heuristic self-play + accumulation) and check whether vs_random Elo now climbs.

Policy head (10 actions) and the bootstrap loop are unchanged — only the input representation grows.

## Open questions for sign-off
1. Approve **Option A** (record feature vector; drop Python re-extraction)?
2. Approve the **~225-feature v1 set** above (P0+P1), deferring P2?
3. OK to use a **lightweight inline damage estimate** instead of `@smogon/calc` in v1?
4. Keep raw **type 1-hot (18×2=36)** for the two actives, or compress to derived effectiveness only
   (saves ~30 dims, less expressive)?

## Result (2026-06-01)

FEATURE_DIM=225 implemented and shipped (commits 6bf9eab/7ef44d8/024a7e8/4efdfe9). Run
`randbats-bootstrap-rich-20260601-1119` Completed. Training loss dropped ~0.77 → ~0.2
(representation is learnable). vs_random Elo 947/895/976/1080/870 — hit 1080 at iter4 but no
sustained climb. The 30-game eval is too noisy to resolve a climb and the bottleneck shifts to eval
signal-to-noise + experiment design (see `self-play-experiments.md` Tier 2 entry).