# Intelligence Roadmap

Technical plan for evolving randbats-bot from a heuristic engine (~1000 Elo) to competitive-level play (1500+ Elo).

> **This is the high-level conceptual roadmap (Stages 1–5).** For *live status* and the actionable
> near-term plan, see [`implementation-plan.md`](./implementation-plan.md). The Stage 4/5 work
> (ISMCTS + self-play RL) is already partially built and validated on AWS — see
> [`self-play-rl-design.md`](./self-play-rl-design.md) and the Tier 0 handoff
> [`HANDOFF.md`](./HANDOFF.md).

---

## Current State

| Component | Implementation |
|-----------|---------------|
| Search | Expectiminimax, depth 2, alpha-beta pruning |
| Damage | `@smogon/calc` (16-roll distribution, KO probability) |
| Opponent model | Bayesian set narrowing — eliminates impossible sets as moves/items/abilities are revealed |
| Evaluation | Hand-tuned heuristic (HP%, hazards, boosts, status, speed tiers) |
| Estimated strength | ~1000 Elo |

The bot plays reasonable moves but lacks depth to see multi-turn sequences, misses subtle positional plays, and has known bugs in damage calculation that cause misevaluations.

---

## Stage 1: Fix Fundamentals (Current)

**Goal:** Eliminate systematic errors that cause obviously wrong suggestions.

- **Accurate damage calculation** — Fix HP percentage bug where defender's actual HP stat isn't derived correctly from the percentage shown in battle. Thread proper EVs/IVs/nature from the opponent model's candidate sets into `@smogon/calc`.
- **Proper opponent modeling** — When calculating damage against opponent, weight across all remaining candidate sets (not just one). Use expected damage = Σ P(set) × damage(set).
- **Observability** — Implement dev mode overlay and turn logging (see `docs/debugging/`) so we can identify *why* the bot makes bad predictions and fix them systematically.

**Success metric:** No obviously wrong top-1 suggestions in manual testing (e.g., suggesting a resisted move when a super-effective option exists).

---

## Stage 2: Faster Engine + Deeper Search

**Goal:** Search deeper without exceeding 5s/turn time budget.

- **WASM simulation** — Port the battle state-advance step to WASM using [`pkmn/engine`](https://github.com/pkmn/engine) (Zig compiled to WASM, ~100x faster than JS simulation). This replaces our JS-based state cloning + manual effect application.
- **Iterative deepening** — Start at depth 2, deepen until time budget exhausted. Target depth 3-5 within 5 seconds on modern hardware.
- **Move ordering** — Evaluate moves likely to be good first to maximize alpha-beta cutoffs:
  1. KO moves (from previous iteration or static analysis)
  2. STAB super-effective moves
  3. Switches into type-resistant Pokemon
  4. Status moves on first turn of matchup
  5. Everything else
- **Transposition table** — Hash game states (Zobrist hashing on: active Pokemon, HP buckets, boosts, hazards, status). Cache evaluations for deterministic sub-trees. Invalidate on RNG-dependent branches.

**Expected gain:** +200 Elo (deeper search catches 2-3 turn sequences: sack → revenge kill, double switch predictions, setup sweeps).

---

## Stage 3: Learned Evaluation Function (NNUE Equivalent)

**Goal:** Replace the hand-tuned heuristic with a neural network that predicts win probability from any game state.

### Data Collection

- Scrape replays from `replay.pokemonshowdown.com` — target 1M+ Gen 9 Random Battle games
- Filter for games with both players rated 1200+ (avoid noise from beginners)
- Extract (state, outcome) pairs at each turn: state features → {win, loss}
- Reference: [PokéChamp](https://arxiv.org/abs/2503.04094) compiled 3M+ games for training

### Model Architecture

Small MLP (NNUE-style) or shallow transformer:

```
Input features (~200-400 dimensions):
- Per-Pokemon (×12): HP%, status, boosts, types, base stats bucket, item known/unknown
- Field: hazards (each side), weather, terrain, trick room
- Positional: speed tier ordering, type matchup matrix (active vs bench)
- Meta: turn number, remaining Pokemon count each side

Architecture (NNUE-style):
- Input → 256 → 32 → 1 (sigmoid = win probability)
- Quantized to int8 for fast inference
- Or: small transformer (2 layers, 4 heads) over Pokemon embeddings
```

### Integration

- Run inference in eval worker (ONNX Runtime Web via offscreen document)
- Replace `scoring.ts` heuristic at leaf nodes; keep minimax search
- Fallback to heuristic if model load fails

**Expected gain:** +200-300 Elo (learned eval captures patterns humans encode poorly: momentum, team composition synergy, endgame inevitability).

---

## Stage 4: MCTS + Policy Network

**Goal:** Handle imperfect information and stochasticity properly via Monte Carlo methods.

### Why MCTS over Minimax

Minimax assumes perfect information and is exploitable when deterministic (opponent can predict our moves). MCTS with determinization handles:
- Hidden information (opponent's unrevealed Pokemon/moves)
- Stochasticity (damage rolls, accuracy, crits)
- Mixed strategies (randomize over near-equal options)

### Implementation: ISMCTS (Information Set MCTS)

1. **Determinize** — Sample opponent's hidden info from Bayesian model (team, sets, items)
2. **Run MCTS** — For each determinization, run N playouts with UCB1 selection
3. **Aggregate** — Average action values across determinizations
4. **Select** — Choose action with highest average value (or sample proportionally for mixed strategy)

### Policy Network

Train a policy network to predict "good moves" from state → action distribution:
- Reduces effective branching from 81 (9×9) to ~10 candidate actions
- Trained on expert replays (what did 1500+ players choose in this state?)
- Used as prior in MCTS (bias exploration toward likely-good moves)

### Compute Budget

- Target: 1000-5000 playouts per turn within 5s
- Each playout: simulate to depth ~10 or terminal, evaluate with Stage 3 value net
- Parallelizable across Web Workers (4-8 workers)

**Expected gain:** +200 Elo, reaching ~1400-1600 (proper handling of uncertainty, mixed strategies prevent exploitation).

---

## Stage 5: Game-Theoretic Endgame + Exploitation

**Goal:** Optimal play in simplified endgames + exploit predictable opponents.

### Counterfactual Regret Minimization (CFR)

- Solve 1v1 and 2v2 endgames exactly using CFR (small enough game trees)
- Precompute Nash equilibria for common endgame matchups
- Switch from MCTS to solved strategy when ≤2 Pokemon remain per side

### Opponent Exploitation

- Track opponent's action frequencies per game state type
- Detect exploitable patterns:
  - Always switches on predicted KO (→ predict switch, use setup move)
  - Never uses status moves (→ safe to set up)
  - Predictable lead choices (→ optimize team preview)
- Deviate from equilibrium strategy when exploitation EV > risk

### Mixed Strategy Computation

- For critical turns (both players have KO threats), compute minimax mixed strategy
- Randomize according to Nash equilibrium to be unexploitable
- Especially important for 50/50 scenarios (stay in vs switch)

### Self-Play Refinement

- Run self-play games between bot versions
- Fine-tune policy/value networks on self-play data
- Iterate: play → train → play (AlphaZero loop adapted for imperfect info)

**Target:** 1500+ Elo (top 10% of Random Battle ladder).

---

## Key Challenges

| Challenge | Impact | Mitigation |
|-----------|--------|------------|
| **Branching factor** | 9 moves × 9 opponent moves = 81 pairs/turn; ~200-500 effective with RNG outcomes | Policy network pruning, move ordering, alpha-beta |
| **Hidden information** | Opponent's 4 unrevealed Pokemon, held items, EV spreads, unrevealed moves | Bayesian model + determinization sampling |
| **Simultaneous moves** | Pure minimax is exploitable (deterministic = predictable) | Mixed strategies, ISMCTS |
| **Stochasticity** | Damage rolls (0.85-1.0×), accuracy (70-100%), crits (1/24), secondary effects | Expectiminimax → MCTS with sampling |
| **Long horizon** | Games last 30-60 turns with 6 Pokemon per side | Learned eval function reduces required search depth |
| **Compute constraints** | Runs in browser (Web Worker), 5s time budget | WASM engine, quantized models, parallel workers |

---

## References

| Resource | Description |
|----------|-------------|
| [pmariglia/poke-engine](https://github.com/pmariglia/poke-engine) | Rust-based Pokemon battle engine with minimax search. Reference implementation for fast simulation. |
| [PokéChamp (2025)](https://arxiv.org/abs/2503.04094) | Current SOTA — trained on 3M+ games, uses learned evaluation + search. Key reference for Stage 3. |
| [PokéLLMon (2024)](https://arxiv.org/abs/2402.01118) | LLM-based approach using chain-of-thought reasoning. Interesting but likely ceiling-limited vs search. |
| [pkmn/engine](https://github.com/pkmn/engine) | Fast WASM battle simulator written in Zig. Target integration for Stage 2. |
| ISMCTS: Cowling et al., 2012 | "Information Set Monte Carlo Tree Search" — foundational paper for MCTS in imperfect-info games. |
| [Randbats set data](https://data.pkmn.cc/randbats/gen9randombattle.json) | Official random battle sets — used for opponent modeling. |
