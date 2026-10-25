# Changelog

## 0.4.0

Support for thinking-capable Claude models (Haiku 5.5, Sonnet 5.5, Opus 5.5, Fable 5.1). See "Thinking models" in the README.

### Breaking

- **`ContentBlock` has three new members:** `thinking`, `redacted_thinking` and `provider_raw`. An exhaustive `switch` over `ContentBlock` needs cases for them.
- **The empty-text fallback is gone.** `ClaudeProviderAdapter` no longer turns unrecognised response blocks into `{ type: 'text', text: '' }`. Thinking blocks are mapped to the new types, and anything else is kept as `provider_raw`.
- **Streamed calls report real values.** `afterReceive`'s `rawResponse` for `streamMessage`/`streamAgentLoop` now carries the real `stopReason` and `usage` when the adapter supplies them (Claude does). Before, these were `'stop'` and zeros.
- **Refusals throw.** `stopReason: 'refusal'` makes all four send methods throw `RefusalError`, and the assistant content is not stored.
- **Unusable `max_tokens` responses throw.** A `max_tokens` response with no text, or one cut off mid tool call, throws `IncompleteResponseError` and stores nothing. Before, the agent loops treated it as a finished answer.
- **Stored metadata.** Stored assistant messages now carry `metadata: { stopReason, usage }`.
- **Wider union types.** `ProviderName` gains `'custom'`, and the `onError` phase gains `'afterProviderCall'`.

### Added

- **Claude adapter options**, also settable per call on `ProviderInput`, all four engine methods and `SendContext`:
  - `thinking`, `effort` (→ `output_config.effort`);
  - `blockBinding` (→ `thinking.block_binding.prefix_mismatch_behavior`, plus the `thinking-binding-controls-2026-08-01` beta header).
- **`thinkingHistory: 'all' | 'current-turn' | 'none'`** on the engine config and per call. It strips stored thinking from what is sent and runs after any context strategy. `applyThinkingHistory` is exported.
- **`ProviderResponse` fields:** `stopDetails` (refusal category and explanation) and `inputTransformations`.
- **`ProviderStreamChunk` fields:**
  - `response` on the `done` chunk: the complete response, with every block in order;
  - `thinking: true` / `thinkingDelta` while the model thinks.
- **`afterProviderCall` hook**, fired after every provider call with the full response (usage included).
- **New errors:** `RefusalError` (`category`, `explanation`) and `IncompleteResponseError` (`stopReason`), both non-retryable.
- **`ProviderAdapter.name`**, which labels errors the engine raises.

### Fixed

- **Empty text blocks.** `ClaudeProviderAdapter` drops empty or whitespace-only `text` blocks when sending, which repairs histories stored by 0.3.0. An assistant message left with nothing is dropped; an empty user message throws `InvalidRequestError` before sending.
- **Cache breakpoints** skip thinking blocks, which can't carry `cache_control`.
- **Thinking signatures when streaming.** Claude streaming accumulates thinking text and signatures itself, so they survive on older `@anthropic-ai/sdk` versions whose `finalMessage()` leaves them out.
- **`streamMessage`** no longer throws away streamed text when a `tool_use` block also arrives.
- **OpenAI and gateway adapters** leave thinking and `provider_raw` blocks out of requests, and fail loudly on an unknown block type.
- **Mid-stream provider errors** in `streamMessage`/`streamAgentLoop` are now reported to `onError` with the `'provider'` phase.
