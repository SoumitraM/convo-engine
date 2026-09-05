# AGENTS.md

This file provides guidance to agents when working with code in this repository.

## Architectural constraints (non-obvious only)

- **Dependency boundary is enforced by convention, not tooling.** Core files (`engine.ts`, `types.ts`, `context/`, `hooks/`, both storage files) must have zero npm imports. There is no eslint rule or import-linting enforcing this — it is a hard architectural rule that must be manually respected.
- **Peer deps are optional by design.** `@anthropic-ai/sdk` and `openai` are in `peerDependenciesMeta` as `optional: true`. If a consumer installs the package without either SDK and never imports the corresponding adapter subpath, they get zero errors. This is intentional — do not add either SDK to `dependencies` to "fix" a missing-module error; instead ensure the import is only in the adapter file behind the subpath export.
- **Five tsup entry points, not one.** The build produces 5 separate output pairs (ESM+CJS each). Adding a feature to `src/engine.ts` is a single-entry-point change. Adding a new provider adapter requires: new source file + new tsup entry + new `"exports"` subpath in `package.json` + new peer dep if applicable.
- **`sendMessage` is a primitive; `agentLoop` wraps it.** They share internal context-assembly and persistence logic via a shared `_runTurn()` helper. Do not duplicate the orchestration logic across the two methods.
- **`streamMessage` and `agentLoop` are mutually exclusive paths** for tool use. `streamMessage` cannot run an agent loop. A future `streamAgentLoop()` is acknowledged in the spec but explicitly deferred — do not add it speculatively.
- **Thread history is immutable from the engine's perspective.** `afterReceive` cannot mutate persisted messages. If a consumer needs to update a message, they do it directly via their `StorageAdapter` implementation — not through the engine.
- **`ContextStrategy` runs before `beforeSend`.** Order: `getHistory` → `assemble()` → `beforeSend` hook → provider call. The hook can see and mutate the assembled context but runs after strategy assembly, not instead of it.
- **`agentLoop` calls `beforeSend` on every iteration**, not just the first. This is load-bearing for RAG injection to stay current across tool-call rounds. Do not optimise it to run once.
