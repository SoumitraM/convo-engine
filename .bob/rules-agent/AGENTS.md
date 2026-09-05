# AGENTS.md

This file provides guidance to agents when working with code in this repository.

## Coding rules (non-obvious only)

- **Never import from npm in core files.** `src/engine.ts`, `src/types.ts`, `src/context/`, `src/hooks/`, `src/adapters/storage/` have zero runtime npm deps. The CI `tsc --noEmit` check won't catch this — it must be manually verified.
- **`ContentBlock` is a discriminated union** — always narrow with `switch (block.type)`. Never cast to `any` or use index access like `block.text` without narrowing first.
- **`tool_result` messages are emitted as standalone entries** in translated OpenAI message arrays, not nested inside another message's content array. Both `OpenAIProviderAdapter` and `GatewayProviderAdapter` must do this — see spec Section 3.2.
- **`cacheBreakpoint` is silently ignored** by `OpenAIProviderAdapter` and `GatewayProviderAdapter` — no warning, no throw. Only `ClaudeProviderAdapter` acts on it.
- **`agentLoop` `afterReceive` fires once** — on the final text response only, never on intermediate `tool_use` messages. Do not call it inside the loop.
- **`streamMessage` completion promise** only resolves after the stream is fully consumed. If the caller never iterates the stream, `completion` never settles. Document this at the call site.
- **Streaming tool calls must be buffered**, not yielded incrementally. Accumulate `delta.tool_calls` across SSE chunks; yield one `tool_use` ContentBlock after `[DONE]`. See `GatewayProviderAdapter_Spec.md` Section 3.5.
- **`MaxIterationsExceededError`** must be a named export from `src/index.ts` so consumers can catch it specifically.
- **Subpath export path ≠ file name**: `./adapters/storage/memory` maps to `in-memory.ts`. Don't rename either.
- **`InMemoryStorageAdapter` implements all 7 methods** (4 required + 3 optional). Do not skip the optional ones.
