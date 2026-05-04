# randbats-bot

Chrome extension that suggests optimal moves for Pokémon Showdown Random Battles.

Like a chess engine overlay — shows the top-N highest expected-value plays each turn without auto-playing.

## How It Works

```
┌─── PAGE WORLD ────────────────────────────────────┐
│  hook.ts: patches app.receive() → extracts state  │
└───────────────────────────────────────────────────┘
        │ postMessage(BattleSnapshot)
┌─── CONTENT SCRIPT ────────────────────────────────┐
│  bridge.ts: relays state, renders Shadow DOM UI   │
└───────────────────────────────────────────────────┘
        │ chrome.runtime.sendMessage
┌─── SERVICE WORKER ────────────────────────────────┐
│  sw.ts: routes to eval worker                     │
└───────────────────────────────────────────────────┘
        │ worker.postMessage
┌─── EVAL WORKER ───────────────────────────────────┐
│  minimax + @smogon/calc → ScoredOption[]          │
└───────────────────────────────────────────────────┘
```

1. **Hooks** into Pokemon Showdown's `app.receive()` to intercept all battle protocol (same approach as Showdex)
2. **Extracts** full battle state from `app.rooms[roomId].battle` — no separate account needed
3. **Models** the opponent by narrowing possible sets (from [randbats data](https://data.pkmn.cc/randbats/gen9randombattle.json)) as moves/items/abilities are revealed
4. **Searches** via expectiminimax (depth 2, alpha-beta pruning) assuming optimal opponent play
5. **Scores** using full game state: damage, KO probability, status, hazards, switch value, speed tiers
6. **Displays** top-N ranked options in a Shadow DOM overlay panel

## Quick Start

```bash
npm install
npm run build
# Load dist/ as unpacked extension in chrome://extensions
```

Then play a Gen 9 Random Battle — suggestions appear in the overlay each turn.

## Architecture

```
src/
├── inject/
│   └── hook.ts              # PAGE world: patches app.receive(), posts state
├── content/
│   └── bridge.ts            # ISOLATED world: relays state, mounts overlay
├── worker/
│   └── sw.ts                # Service worker: routes messages, manages workers
├── eval/
│   ├── eval-worker.ts       # Web Worker: runs minimax search
│   ├── minimax.ts           # Expectiminimax with alpha-beta pruning
│   ├── scoring.ts           # Heuristic state evaluator
│   ├── damage.ts            # @smogon/calc wrapper
│   └── opponent-model.ts    # Bayesian set narrowing
├── state/
│   ├── snapshot.ts          # Extracts BattleSnapshot from page objects
│   └── sets-db.ts           # Randbats set data loader
├── ui/
│   ├── overlay.tsx          # Preact overlay (Shadow DOM)
│   ├── suggestion-card.tsx  # Individual suggestion display
│   └── styles.css           # Scoped styles
├── util/
│   └── format-registry.ts   # Gen/format extensibility
└── types.ts                 # All shared interfaces
```

## Scoring

The eval engine combines minimax search value with tactical assessment:

```
Score(action) = minimaxValue × 0.7 + tactical × 0.3

tactical = KO_prob×0.35 + E[dmg%]×0.25 + status×0.15 + hazards×0.10 + speed×0.05 + pressure×0.10
```

Leaf node heuristic evaluates full game state:
```
V(state) = Σ_myTeam value(mon) − Σ_oppTeam value(mon) + positional
value(mon) = hp%×0.4 + hasItem×0.05 + boosts×0.1 + role×0.15
positional = hazardDelta×0.12 + statusDelta×0.10 + speedControl×0.08
```

## Key Dependencies

| Package | Purpose |
|---------|---------|
| `@smogon/calc` | Damage calculation (16 rolls, KO chance) |
| `@pkmn/data` | Pokemon/move/ability data |
| `preact` | Lightweight UI for overlay |
| `@crxjs/vite-plugin` | Chrome extension build tooling |

## Extensibility

- **Other formats**: Register a `FormatStrategy` in `format-registry.ts` with custom sets DB + scorer
- **ML eval**: Offscreen document (`offscreen/ml-eval.html`) hosts ONNX Runtime Web for learned evaluation
- **Auto-play**: Content script can send moves via `app.rooms[roomId].send()` when enabled

## Roadmap

- [ ] Core: inject hook + state extraction + overlay shell
- [ ] Eval engine: damage calc + scoring heuristic
- [ ] Opponent model with Bayesian narrowing
- [ ] Minimax search (depth 2, alpha-beta)
- [ ] Full scoring: status moves, hazards, switch-in value, speed
- [ ] ML evaluation function (ONNX Runtime Web)
- [ ] Auto-play mode
- [ ] Support additional formats (OU, UU, etc.)
