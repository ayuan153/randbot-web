# AGENTS.md

Guidelines for AI agents working on this repo.

## Build & Test

```bash
npm install          # install deps (run after any package.json change)
npm run build        # vite build → dist/ (Chrome extension output)
npm run lint         # tsc --noEmit (type-check without emitting)
npm test             # vitest run
```

**Before committing, always run:**
```bash
npm run lint && npm test
```

Both must pass with exit code 0. Do not commit with type errors or failing tests.

## Commit Convention

Use [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <short summary>

<optional body>
```

### Types

| Type | When |
|------|------|
| `feat` | New feature or capability |
| `fix` | Bug fix |
| `refactor` | Code change that neither fixes a bug nor adds a feature |
| `test` | Adding or updating tests |
| `docs` | Documentation only |
| `chore` | Build config, deps, tooling |
| `perf` | Performance improvement |

### Scopes

Use the directory/module name: `inject`, `content`, `worker`, `eval`, `state`, `ui`, `util`, `data`, `build`.

### Examples

```
feat(eval): implement damage calc wrapper using @smogon/calc
fix(inject): handle missing app.rooms on non-battle pages
test(eval): add scoring heuristic unit tests
chore(build): pin @crxjs/vite-plugin to 2.0.0-beta.25
docs: update README with scoring formula
```

### Rules

- Subject line ≤ 72 characters
- Imperative mood ("add", not "added" or "adds")
- No period at end of subject
- Body wraps at 80 characters
- Reference issues/context in body if relevant

## Branch Strategy

- `main` — stable, buildable at all times
- Feature branches: `feat/<short-name>` or `fix/<short-name>`
- One logical change per commit — don't mix refactors with features

## Code Style

- TypeScript strict mode (`strict: true` in tsconfig)
- No `as any`, `@ts-ignore`, or `@ts-expect-error`
- Preserve existing comments and doc blocks
- Add inline comments for non-obvious logic
- Export types from `src/types.ts` (shared interfaces)

## Testing

- Framework: Vitest
- Test files: `*.test.ts` colocated with source or in `__tests__/`
- Write tests for any non-trivial logic (eval, scoring, opponent model)
- Run `npm test` before every commit

## Extension-Specific Notes

- `src/inject/` runs in PAGE world (has access to `window.app`)
- `src/content/` runs in ISOLATED world (has access to Chrome APIs)
- `src/worker/` is the service worker (no DOM, no `new Worker()`)
- `src/eval/` runs inside a Web Worker (no DOM, no Chrome APIs)
- Communication between layers is message-passing only — keep payloads serializable

## Intelligence Work — Progress Tracking

After each substantive change to the engine, search, or training pipeline:

1. Update `docs/intelligence/implementation-plan.md` with current progress, decisions made, and any deviations from the original plan
2. Keep a "Current State" section at the top reflecting what's actually built vs planned
3. Update "Next Steps" to reflect what should happen next

This ensures handoffs between agents/sessions are smooth. The docs should always answer: "Where are we? What changed? What's next?"
