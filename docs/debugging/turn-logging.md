# Turn Logging

Turn logging captures the engine's full decision context every turn, producing a JSON log that can be replayed offline to diagnose prediction errors.

## What It Captures

Each turn log entry contains:

```json
{
  "turn": 5,
  "timestamp": "2026-05-04T19:30:00.000Z",
  "roomId": "battle-gen9randombattle-12345",
  "snapshot": { /* full BattleSnapshot */ },
  "opponentModel": {
    "pokemon": {
      "Garchomp": {
        "candidateSets": [ /* remaining possible sets */ ],
        "revealedMoves": ["Earthquake", "Swords Dance"],
        "revealedItem": null,
        "revealedAbility": "Rough Skin"
      }
    }
  },
  "evalResult": {
    "suggestions": [
      {
        "action": "move 1",
        "moveName": "Ice Beam",
        "score": 87,
        "minimaxValue": 0.82,
        "tacticalScore": 0.95,
        "damageRange": [78, 92],
        "koProb": 0.85
      }
    ],
    "searchDepth": 2,
    "nodesSearched": 1247,
    "evalTimeMs": 312
  },
  "chosenAction": "move 1",
  "actualOutcome": {
    "damageDealt": 84,
    "opponentAction": "switch Skarmory"
  }
}
```

## Enabling Turn Logging

Turn logging is **enabled by default** in dev builds. In production:

- **Toggle:** `Ctrl+Shift+L` or via the dev mode ⚙️ menu
- **Programmatic:** `window.__randbatsBotLogging = true`

Logs are stored in `chrome.storage.local` under the key `turnLogs_{roomId}`.

## Downloading Logs

1. Open dev mode (⚙️ icon or `Ctrl+Shift+D`)
2. Click **"Download Turn Log"** button at bottom of panel
3. Saves as `randbats-log-{roomId}-{timestamp}.json`

Or from console:
```js
chrome.storage.local.get(null, (data) => {
  const logs = Object.entries(data).filter(([k]) => k.startsWith('turnLogs_'));
  console.log(JSON.stringify(logs, null, 2));
});
```

## Using Logs to Identify Prediction Errors

### Workflow

1. Play a game, note which turns had bad suggestions
2. Download the turn log
3. Find the turn entry and check:

| Check | What to look for |
|-------|-----------------|
| `snapshot` | Does HP%, status, boosts match what was on screen? |
| `opponentModel.candidateSets` | Were impossible sets correctly eliminated? |
| `evalResult.damageRange` | Does damage calc match Smogon calculator? |
| `evalResult.suggestions` | Is the correct move even in the list? What score did it get? |
| `actualOutcome` | Did the opponent do something unexpected? Was it predictable from the model? |

### Common Patterns

- **Damage mismatch** → State extraction bug (wrong stats/level/item passed to calc)
- **Opponent model too wide** → Reveal tracking missed an event (check protocol parsing)
- **Correct move scored low** → Heuristic weights are off, or search didn't find the winning line
- **Opponent did something "impossible"** → Set data might be outdated, or a rare set wasn't in the database

## Log Rotation

- Logs auto-clear after 50 games to avoid filling `chrome.storage.local` (5MB limit)
- Oldest games are evicted first
- Pin important games via dev mode UI to prevent eviction
