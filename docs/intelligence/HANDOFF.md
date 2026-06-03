# HANDOFF — randbats-bot (latest)

> Single source of truth for "where are we, what's next." Supersedes all prior
> `handoff-*.md` (removed). Durable design lives in the design docs linked below.
> **Last updated:** 2026-06-03 · **HEAD when written:** `2b480a5` on `main`
> (remote `github.com/ayuan153/randbot-web`, fully pushed).

## TL;DR

Track 2C is **complete**: the dual-head imitation net (`imitation-dual-v2`) is
trained on corrected data, wired into the bot as both the search leaf evaluator
and a root **policy prior**, and **measured on the real ladder**.

**North-star result:** `gen9randombattle` ladder **GXE 30.4** · Elo ~1062 ·
**11W–24L** · rprd 56.7 (settled) over 35 rated games. The bot plays **well below
average** (50 GXE ≈ average). This is likely a slight *under*-estimate (a since-fixed
watchdog bug forfeited some games). **Takeaway: the imitation-net + depth-2 search
approach is weak; the next real gains require a stronger net and/or deeper search,
not more plumbing.**

Net held-out metrics after the data fix: **win-acc 0.671, move-top1 0.400** (was 0.35).

## Read next (design docs, kept)
- [`north-star-imitation-design.md`](./north-star-imitation-design.md) — authoritative design + dated results log.
- [`implementation-plan.md`](./implementation-plan.md) — phased roadmap (Phase 2 search, Phase 3 ISMCTS+policy).
- [`self-play-experiments.md`](./self-play-experiments.md) + [`self-play-rl-design.md`](./self-play-rl-design.md) — the **separate, deprioritized** self-play RL track (gate failed; Phase-3 refinement at best).

## Fresh-laptop setup (only git contents are guaranteed)
```bash
git clone https://github.com/ayuan153/randbot-web.git && cd randbot-web
npm install                       # incl. onnxruntime-node (ladder) + onnxruntime-web (extension)
npm run build                     # vite -> dist/  (ships models/*.onnx + *.onnx.data)
npm run lint && npm test          # tsc + vitest; expect ~101 tests green
```
**Committed (present on clone):** all source, the trained `models/*.onnx(.data)`, and the
data tables `training/features/data/{species_types.json,move_base_powers.json}`.
**NOT committed (must regenerate locally):**
- `training/data/replays/*.json` (~500K, gitignored via `training/.gitignore: data/`) — needed only to retrain; re-download via `training/scraper` (see README).
- `node_modules/`, `dist/`, `/tmp/*` scratch (`d.npz`, `m.pt`, logs), `models/*.bak`.
- Python deps: `cd training && pip install -r requirements.txt` (torch/onnx/onnxruntime), only needed to retrain.

## What changed this session (commits, newest first)
- `2b480a5` docs: record ladder GXE + proxy-lock blocker
- `36e6167` fix(ladder): message-based watchdog + reconnect backoff
- `620b312` fix(ladder): reconnect + ping/pong watchdog + win count
- `c450ba0` feat(ladder): automated harness (accumulator + net selector)
- `40ed44b` docs: Track 2C completion + data-gap fix
- `3d63550` chore(training): retrain imitation-dual-v2 on corrected data
- `e72990b` feat(eval): use imitation-dual-v2 + blend root policy prior
- `b63457b` feat(eval): emit 265 per-move features with verified Python parity
- `73849b1` fix(training): regenerate species/move tables from @pkmn
- `022b1d7` fix(build): ship .onnx.data external weights to the extension

### The most important thing to know (data-gap fix)
The Python feature tables were hand-maintained and **~70% incomplete** (missing
common species/moves → silently defaulted to Normal/80/`["Normal"]`), so **both nets
had been trained on largely-wrong type/move features**. Fixed by regenerating complete
gen9 tables from `@pkmn`:
- `scripts/gen-data-tables.mjs` (`node scripts/gen-data-tables.mjs`) → `training/features/data/*.json` (876 species, 685 moves).
- `training/features/base_stats.py` now JSON-loads them with id-normalized lookups.
- **Parity is the #1 invariant:** `src/eval/features.ts` `computeMoveBlock` (TS, `@pkmn/data`) must byte-match Python `_move_features`. Guarded by `src/eval/features.test`-style `src/eval/features.move-parity.test.ts`. If you touch features on either side, re-verify parity.

## Key files
| Area | File |
|------|------|
| Features (265-d, parity-critical) | `src/eval/features.ts`, parity test `src/eval/features.move-parity.test.ts` |
| Net inference (browser) | `src/eval/learned-eval.ts` (`onnxruntime-web`) |
| Search + policy-prior blend | `src/eval/eval-worker.ts`, `src/eval/policy-prior.ts` (+test), `src/eval/minimax.ts` |
| Data tables (Python) | `training/features/base_stats.py`, `training/features/data/*.json`, generator `scripts/gen-data-tables.mjs` |
| Retrain runner | `training/retrain_v2.sh` |
| Ladder harness (Node) | `ladder/client.ts`, `ladder/battle-state.ts`, `ladder/bot-selector.ts`, `ladder/net-node.ts` (`onnxruntime-node`) |

## Retraining the net (CPU, local)
Requires replays in `training/data/replays/`. The runner backs up the old model, then
extract → train → export 265-d ONNX:
```bash
bash training/retrain_v2.sh        # ~11 min extract (5M samples from 100K games) + ~50 min train (20 ep)
# outputs models/imitation-dual-v2.onnx (+ .onnx.data); then `npm run build` to ship it
```
ONNX I/O contract (do not change without updating `learned-eval.ts`/`net-node.ts`):
input `state[*,265]` → outputs `win_probability` + `policy_logits[5]`.

## Running the ladder (the automated measurement)
```bash
# Registered account REQUIRED. Credentials are NOT stored in the repo — pass inline:
PS_USERNAME=<user> PS_PASSWORD=<pass> npx tsx ladder/client.ts 40
# Reads GXE from https://pokemonshowdown.com/users/<userid>.json after each game.
```
The harness mirrors the shipped bot: builds a `BattleSnapshot` from raw protocol,
runs `search()` + ML-blended leaf eval + root policy prior, returns a legal choice;
reconnects on drop; 240s message-silence watchdog; ≥600ms throttle; `chooseDefault` fallback.

### ⚠️ Gotcha that blocked the clean re-measurement
**Pokémon Showdown auto-locks datacenter/cloud IPs as "proxies."** The last run was on
an AWS IP (`15.248.6.12`); login succeeds but the user is name-locked (`‽<user>`) and
**cannot search rated games** (connection ends right after `/search`). The current GXE
30.4 was obtained before the lock bit. **To re-measure cleanly, run from a residential
IP** (e.g. a home laptop) or appeal the PS lock. No code change can bypass this.

Other gotchas:
- A couple of `@pkmn/sim` battle tests (`net-features`, `battle-adapter`) are timing-sensitive and can flake under load — re-run `npm test` to confirm green.
- Never commit credentials; `.gitignore` covers `.env*`.

## Next steps (prioritized)
1. **Clean ladder re-measure** from a residential IP (`npx tsx ladder/client.ts 40`). The current 30.4 is mildly contaminated by the (now-fixed) disconnect-forfeit bug; a clean run gives the true baseline.
2. **Raise strength (the real lever).** GXE 30.4 says the approach is weak. Candidates, roughly in ROI order:
   - Search: iterative deepening + move ordering, push to depth 3–4 (Phase 2 in the plan); tune `POLICY_BLEND` (0.7) / `ML_BLEND` (0.5).
   - Net: bigger/better policy+value net; train on higher-rated replays / more data; richer features.
   - Phase 3: ISMCTS guided by the policy net.
3. Harness polish (optional): the per-session W/L console tally under-counts across reconnects (server JSON is authoritative); consider lowering search time for faster games.

## Status checklist
- [x] Ship weights sidecar · [x] 265 features + parity · [x] load dual-net + policy prior
- [x] Regenerate data tables + retrain · [x] automated ladder harness · [x] first live GXE (30.4)
- [ ] Clean ladder re-measure (residential IP) · [ ] stronger net/search
