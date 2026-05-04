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
```

Then load the extension in Chrome and play a battle — see [Live Testing](#live-testing) below.

## Live Testing

### 1. Build the extension

```bash
npm install
npm run build
```

This produces `dist/` — a ready-to-load Chrome extension.

### 2. Load in Chrome

1. Open `chrome://extensions` in Chrome
2. Enable **Developer mode** (toggle in top-right)
3. Click **Load unpacked**
4. Select the `dist/` folder inside this project

You should see "Randbats Bot" appear in your extensions list. Note the extension ID (you'll need it for debugging).

### 3. Play a battle

1. Go to [play.pokemonshowdown.com](https://play.pokemonshowdown.com/)
2. Log in (or play as guest)
3. Start a **Gen 9 Random Battle** (Battle! → Random Battle)
4. Once the battle starts and your first turn begins, the overlay panel should appear in the bottom-right corner

### 4. What to look for

- **Overlay panel**: Dark floating panel labeled "⚔️ randbats-bot" with turn number and eval time
- **Ranked suggestions**: Each available move/switch scored 0–100 with color coding (green/yellow/red)
- **Details**: KO%, damage%, and other tactical info below each suggestion
- **Updates each turn**: Panel refreshes when a new `|request|` is received

### 5. Debugging

Open DevTools on the Showdown page (`F12` or `Cmd+Opt+I`):

- **Console tab**: Look for `[randbats-bot]` log messages:
  - `[randbats-bot] Hook installed` — inject script is working
  - `[randbats-bot] Content script loaded` — content script is running
  - `[randbats-bot] Suggestions: [...]` — eval results are flowing

- **Service worker logs**: Go to `chrome://extensions` → click "service worker" link under Randbats Bot → opens a separate DevTools for the background script

- **Common issues**:
  - No overlay? Check console for errors. The hook waits for `window.app` — if PS hasn't loaded yet, wait a moment and refresh.
  - Extension not activating? Verify the URL matches `*://play.pokemonshowdown.com/*` or `*://*.psim.us/*`.
  - Stale code? After rebuilding (`npm run build`), go to `chrome://extensions` and click the refresh ↻ icon on the extension, then reload the PS page.

### 6. Rebuild loop

```bash
# Make changes, then:
npm run build
# Go to chrome://extensions → click ↻ on Randbats Bot → reload the PS page
```

For faster iteration, use watch mode:
```bash
npm run dev   # rebuilds on file changes
# Still need to refresh the extension + page after each rebuild
```

## Testing

### Test pyramid

| Layer | Tool | What it tests | Run with |
|-------|------|---------------|----------|
| **Unit** | Vitest | Scoring, minimax, damage calc, opponent model, snapshot parsing | `npm test` |
| **Fixture** | Vitest + replay data | Snapshot extraction against real PS protocol | `npm test` |
| **Integration** | Playwright + local PS server | Full extension flow: load → battle → suggestions appear | `npm run test:e2e` (planned) |

### Unit tests (current)

```bash
npm test              # run once
npm run test:watch    # watch mode
```

Tests cover:
- `snapshot.test.ts` — condition/details parsing, action extraction, format derivation
- `opponent-model.test.ts` — Bayesian set narrowing on reveal events
- `scoring.test.ts` — heuristic evaluation for symmetric/asymmetric states

### Replay fixture tests (planned)

Download real battle protocol from `replay.pokemonshowdown.com` and feed it through our parsing:

```bash
# Download a replay's raw protocol
curl -L https://replay.pokemonshowdown.com/<replay-id>.log > test/fixtures/replay-1.log

# Or use the JSON API for structured data
curl -L https://replay.pokemonshowdown.com/<replay-id>.json > test/fixtures/replay-1.json
```

These fixtures let us test snapshot extraction and opponent model tracking against real game data without a live server.

### Integration tests (planned)

Full end-to-end with a local Pokemon Showdown server:

```bash
# 1. Clone and start local PS server
git clone https://github.com/smogon/pokemon-showdown.git /tmp/ps-server
cd /tmp/ps-server && npm install && node pokemon-showdown start --no-security

# 2. Run integration tests (Playwright loads extension, navigates to localhost:8000)
npm run test:e2e
```

Playwright can load unpacked extensions via persistent context:
```js
const context = await chromium.launchPersistentContext('', {
  args: [
    `--disable-extensions-except=${pathToExtension}`,
    `--load-extension=${pathToExtension}`,
  ],
});
```

### Generating test fixtures with @pkmn/sim

For deterministic unit tests, generate battle states programmatically:

```js
import { BattleStream } from '@pkmn/sim';

const stream = new BattleStream();
stream.write(`>start {"formatid":"gen9randombattle","seed":[1,2,3,4]}`);
stream.write(`>player p1 {"name":"Alice"}`);
stream.write(`>player p2 {"name":"Bob"}`);
// Read protocol output, feed to snapshot extraction
```

Seeded RNG produces identical battles every time — perfect for regression tests.

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
| `vite` | Build tooling (multi-entry extension build) |

## Extensibility

- **Other formats**: Register a `FormatStrategy` in `format-registry.ts` with custom sets DB + scorer
- **ML eval**: Offscreen document (`offscreen/ml-eval.html`) hosts ONNX Runtime Web for learned evaluation
- **Auto-play**: Content script can send moves via `app.rooms[roomId].send()` when enabled

## Roadmap

- [x] Core: inject hook + state extraction + overlay shell
- [x] Eval engine: damage calc + scoring heuristic
- [x] Opponent model with Bayesian narrowing
- [x] Minimax search (depth 2, alpha-beta)
- [x] Full scoring: status moves, hazards, switch-in value, speed
- [ ] Replay fixture tests
- [ ] Integration tests (Playwright + local PS)
- [ ] ML evaluation function (ONNX Runtime Web)
- [ ] Auto-play mode
- [ ] Support additional formats (OU, UU, etc.)
