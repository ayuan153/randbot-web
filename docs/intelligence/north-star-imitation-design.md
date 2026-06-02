# North-Star Reframe — Human Imitation (Track 1) + Real Measurement (Track 0)

**North star:** top of the Gen 9 Random Battle ladder.
**Status:** design locked; implementing. Supersedes the self-play-RL track as the *primary* lever
(self-play RL is now Phase 3, on top of a human prior). See `self-play-experiments.md` for the gate
result that triggered this reframe.

## Why this reframe (evidence)
- Low-noise (300-game) eval proved the self-play net trained on **heuristic-bootstrapped** data does
  not get stronger with more data — it is behavioral cloning of a hand-coded heuristic, ceilinged at
  the heuristic. (`self-play-experiments.md` → "Tier 2 low-noise eval".)
- The format is imperfect-info + stochastic + simultaneous-move → AlphaZero/ISMCTS is a poor *primary*
  fit (strategy fusion). The known-good approach (and what our deployed extension already does) is
  **supervised learning from strong human replays**.
- We have ~31.7M gen9 randbats replays available (500K already downloaded, 1400+), and a working
  245-feature value net (65% win-pred). We were not using this corpus for the self-play track.
- **Measurement is disconnected from the goal:** the only signals were `vs_random` (800) and
  `vs_heuristic` (1000). We cannot see ladder-relevant strength. Fix this first.

## Lever priority (this phase)
1. **Track 1 — supervised human-imitation value+policy at scale** (the 90% unlock).
2. **Track 0 — measurement** connected to the north star (offline proxy + live ladder GXE).
3. (later) search + set-modeling unification; then self-play RL fine-tuning.

---

## Track 1 — Supervised human-imitation (value + policy)

### Data
- Source: `training/scraper` (HF `HolidayOugi/pokemon-showdown-replays`), gen9randombattle, **rating
  ≥ 1500** (raise the current 1400 floor for stronger imitation).
- Sample at each `|turn|` boundary, **both perspectives** (state the player saw *before* acting).
- Labels per sample: `value` = did this perspective win (1/0); `action` = the action the player chose
  this turn (see action space). Hold out a fixed % of *games* (not positions) for validation.

### Action space (size 10) — must be identical at train and inference
| idx | action |
|----|--------|
| 0-3 | move slots 1-4, **ordered lexicographically by move id** over the active mon's randbats moveset |
| 4-9 | switch to team roster slot 1-6 (order from initial team reveal) |

- **Move-order consistency** is the critical correctness point. Replays do **not** contain the
  `|request|` (which carries the live move-slot order), so we canonicalize: load the gen9 randbats
  **set data** (`gen9randombattle.json`, the same file the extension's `sets-db` uses) in Python; for
  the active species take its moveset, **sort move ids lexicographically**, and map the chosen move →
  its index. Live inference sorts the `request.active[0].moves` ids the same way → identical indices.
- Tera is **not** a separate action for now (it modifies a move; revisit later). Legal actions are
  **masked** to `-inf` before softmax at inference; at train time CE uses the chosen index directly.
- **Edge cases → drop the sample** (don't emit a policy label; value label may still be kept):
  - species' randbats set is role-ambiguous and the revealed moves can't disambiguate the moveset;
  - chosen move id not in the resolved moveset (illusion/zoroark, transform, custom);
  - forced-switch turns emit a switch label only (no move line) — handled, not dropped.

### Net (dual-head)
```
backbone: Linear(245,256) ReLU Dropout0.2  Linear(256,128) ReLU Dropout0.1
value_head:  Linear(128,64) ReLU Linear(64,1) Sigmoid     -> win probability
policy_head: Linear(128,64) ReLU Linear(64,10)            -> action logits
loss = BCE(value, win) + λ·CE(policy_logits, action),  λ≈0.5
```
- Fix the latent bug: `input_dim` is hardcoded 206 in the net/export but features are 245 →
  parameterize from the data shape (default 245).
- Keep existing train/val split + early stopping; **save the BEST net** (by val criterion). Track and
  report both heads' val metrics; select best by win-pred acc (primary) with move-match as a tiebreak.

### Metrics (these ARE the Track-0 offline proxy)
- **Win-prediction accuracy** on held-out 1500+ positions (target > 70%).
- **Top-1 / Top-3 move-match** vs the 1500+ human's actual action (legal-masked). These correlate
  with ladder strength far better than `vs_random`.

### Export
- `export_onnx.py`: `forward` returns `(value, policy_logits)`; `output_names=["win_probability",
  "policy_logits"]`, `input_names=["state"]`, dynamic batch axis. Validate parity vs torch.
- This is a **new artifact** (does not replace `models/value-net-v1.onnx`). Wiring it into search is
  Track 2 (later).

---

## Track 0 — Measurement

### A. Offline proxy (free from Track 1)
The Track-1 held-out win-pred + move-match on 1500+ replays is the first north-star-correlated metric.
No extra infra. Report per training run in `self-play-experiments.md`.

### B. Live ladder client (ground truth GXE)
Minimal headless Node/TS client (`ladder/`): `ws` + `@pkmn/login`.
- Connect `wss://sim3.psim.us/showdown/websocket`; on `|challstr|` POST `name/pass/challstr` to
  `https://play.pokemonshowdown.com/api/login`, strip leading `]`, parse `assertion`, send
  `|/trn USER,0,ASSERTION`; wait `|updateuser|…|1|`.
- `|/search gen9randombattle` (no team preview). Parse `|request|` JSON (active moves+pp+disabled,
  `forceSwitch`, `wait`, `side.pokemon`, `rqid`). Choose via a pluggable `chooseAction(request,state)`
  → `|/choose move N[ terastallize]|rqid` or `|/choose switch N|rqid`; `forceSwitch`→switch,
  `wait`→noop, fallback `|/choose default|rqid`.
- On `|win|USER`/`|tie`: record W/L; read GXE/Elo from the inline `|raw|` block and/or
  `GET https://pokemonshowdown.com/users/USERID.json` → `ratings.gen9randombattle.{elo,gxe,rpr}`.
  Loop: `|/leave`, wait ~2s, search again. Throttle sends ≥600ms; respect the turn timer.
- **Requires a registered account** (rated/GXE); creds via `PS_USERNAME`/`PS_PASSWORD` env. The move
  selector starts simple (legal heuristic) to validate the loop end-to-end, then upgrades to the
  trained net (+ search) so ladder GXE measures real strength.

### C. Strong local anchor (optional)
Add the deployed 245-value-net bot (or the new policy net) as a `p2` baseline in the eval harness for
a >1000-Elo offline anchor. Lower priority once live GXE exists.

---

## Open questions / risks
- **Move-slot canonicalization** is the top correctness risk; validate by measuring top-1 move-match
  (a broken mapping shows up as near-random ~10-20% match). Harden with set data; drop ambiguous mons.
- Randbats set pools with >4 candidate moves per role: resolve the role from revealed moves; if
  unresolved, drop the policy label.
- Re-extracting 500K replays with the new label is a one-off batch (local, CPU); size accordingly.
- Eval is CPU-bound (see experiments doc) — run training/eval on CPU/GPU as available, never assume a
  g4dn is needed for eval.

## Status
- [x] Reframe + design (this doc)
- [ ] T1 policy-label extraction
- [ ] T1 dual-head net + training (val/early-stop/save-best)
- [ ] T1 train + report win-pred & move-match
- [ ] T1 export dual-head ONNX
- [ ] T0 live ladder client + GXE logging
- [ ] (opt) T0 strong local anchor
