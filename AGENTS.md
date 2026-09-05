# AGENTS.md

This file provides guidance to agents when working with code in this repository.

## What this package is

`@soumitrm/convo-engine` — a standalone TypeScript library for multi-turn LLM conversations. **Full spec: `../ConvoEngine_Spec.md` and `../GatewayProviderAdapter_Spec.md`** (workspace root). Read Sections 3–15 of the spec before touching any code.

## Commands

```bash
npm install          # install deps (run from convo-engine/)
npm run build        # tsup dual ESM+CJS build → dist/
npm run typecheck    # tsc --noEmit (must pass before every commit)
npm test             # vitest run (all tests)
npm test -- engine   # run single test file matching 'engine'
npm test -- --reporter=verbose  # detailed output
```

## Non-obvious build rules

- `tsup` is configured with **5 separate entry points** (index + 4 adapters) — each produces its own ESM+CJS pair. Adding a new adapter requires a new entry in `tsup.config.ts` AND a new subpath export in `package.json`.
- `external: ['@anthropic-ai/sdk', 'openai']` in `tsup.config.ts` — these must never be bundled.
- The subpath export `./adapters/storage/memory` maps to `dist/adapters/storage/in-memory.js` — the file is named `in-memory` but the export path says `memory`. Don't rename either without updating both.
- `examples/basic-chat-app` uses npm workspaces: `"@soumitrm/convo-engine": "workspace:*"` — the examples depend on the parent package by name, not by `file:` path.

## Test file placement

All test files live in `tests/` at the package root (not co-located with source). Vitest is configured to look there. Test files that need a real API key are skipped unless the corresponding env var is set — use `skipIf` / `describe.skipIf`.

## Dependency boundary enforcement

The following files must have **zero imports from npm** (enforced by code review, not linter):
- `src/engine.ts`
- `src/types.ts`
- `src/context/strategy.ts`
- `src/hooks/types.ts`
- `src/adapters/storage/types.ts`
- `src/adapters/storage/in-memory.ts`

`src/adapters/provider/gateway.ts` uses `node:https` only — no npm deps.

## agentLoop persistence rule

All intermediate `tool_use` and `tool_result` messages ARE persisted to the thread (not just the final answer). This is intentional — do not "optimise" it away. The context assembled for the next user turn requires seeing the full tool exchange history.

## `streamMessage` does not run tool loops

If the model returns `tool_use` during a `streamMessage` call, that is a caller error (they should have used `agentLoop`). `streamMessage` is for text-only responses.
