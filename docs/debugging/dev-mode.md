# Dev Mode

Dev mode expands the overlay panel to show the engine's internal reasoning, making it easy to identify why a prediction is wrong.

## Toggling Dev Mode

- **Keyboard shortcut:** `Ctrl+Shift+D` while on a Pokemon Showdown battle page
- **Overlay button:** Click the ⚙️ icon in the top-right corner of the randbats-bot panel
- **Programmatic:** In console, `window.__randbatsBotDevMode = true`

When active, the panel header shows a 🔧 indicator.

## What Dev Mode Shows

### Per-Suggestion Breakdown

Each ranked suggestion expands to show:

| Field | Meaning |
|-------|---------|
| **Minimax value** | Raw search score (0.0–1.0 = estimated win probability) |
| **Tactical score** | Heuristic component (KO%, E[dmg%], status, hazards, speed, pressure) |
| **Final score** | Weighted combination displayed as 0–100 |
| **Search depth** | How deep the engine searched for this action |
| **Best line** | Predicted sequence (e.g., "Thunderbolt → opp switches Garchomp → we switch Weavile") |
| **Damage calc** | Exact damage range and KO probability against current opponent |

### Opponent Model Panel

- List of candidate sets remaining for each revealed opponent Pokemon
- Probability distribution over unrevealed items/abilities/moves
- What was eliminated and why (e.g., "Leftovers eliminated: took Life Orb recoil turn 3")

### State Summary

- Full extracted `BattleSnapshot` as formatted JSON
- Hazard state, weather, terrain, boosts for both sides
- Speed tier ordering (who outspeeds whom)

## Debugging Bad Predictions

When the bot suggests a clearly wrong move:

1. **Check damage calc** — Is the damage range correct? Compare with the [Smogon calculator](https://calc.pokemonshowdown.com/). If wrong, the issue is in state extraction (wrong stats/EVs/IVs being passed).

2. **Check opponent model** — Are the candidate sets reasonable? If the model hasn't narrowed correctly (e.g., still considers Choice Scarf when opponent used two moves), the reveal tracking has a bug.

3. **Check best line** — Does the predicted sequence make sense? If the bot assumes the opponent will make a bad play, the opponent modeling in search is too optimistic.

4. **Check state extraction** — Open the state summary. Verify HP percentages, active Pokemon, and available moves match what's on screen. Mismatches indicate a `snapshot.ts` parsing bug.

## Performance Overlay

Dev mode also shows:
- Eval time (ms)
- Nodes searched
- Alpha-beta cutoff rate
- Cache hit rate (transposition table, when implemented)
