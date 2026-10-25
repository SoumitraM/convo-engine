# @smsoumitra/convo-engine

Standalone TypeScript module for managing multi-turn LLM conversations.

## Install

```bash
npm install @smsoumitra/convo-engine
```

Provider adapters live behind subpath exports so you only pull in the peer dependency you need:

```ts
import { ConversationEngine } from '@smsoumitra/convo-engine';
import { ClaudeProviderAdapter } from '@smsoumitra/convo-engine/adapters/claude';
import { InMemoryStorageAdapter } from '@smsoumitra/convo-engine/adapters/storage/memory';
```

`@anthropic-ai/sdk` and `openai` are optional peer dependencies — install whichever provider SDK you use.

## Thinking models

The current Claude models (Haiku 5.5, Sonnet 5.5, Opus 5.5, Fable 5.1) think by default. Responses can contain `thinking` blocks, usually with empty text and a `signature`. The engine stores them as `{ type: 'thinking', thinking, signature }` / `{ type: 'redacted_thinking', data }` and sends them back exactly as received.

**A thinking block is tied to the conversation that produced it**: the top-level system prompt, the tools, and every earlier message. If any of those change and the block is replayed, the request fails with a 400 (`... bound to a different conversation`). This is enforced for accounts created on or after 2026-08-31; older accounts opt in with `blockBinding`. Removing thinking blocks from the *front* of the history is allowed, so pick a `thinkingHistory`:

| `thinkingHistory` | Sent to the provider | Use when |
|---|---|---|
| `'all'` (default) | Every stored thinking block | The same system prompt and tools every turn (append-only) |
| `'current-turn'` | Only the current turn's thinking (from the latest user message that isn't a tool result) | **You rebuild the system prompt or change tools between turns** |
| `'none'` | No thinking blocks | Last resort |

Storage always keeps every block; the setting only affects what is sent. Set it on the engine or per call:

```ts
const engine = new ConversationEngine({ storage, provider, thinkingHistory: 'current-turn' });
await engine.agentLoop(threadId, text, { tools, toolExecutor, effort: 'low' });
```

**Request options** (on `ClaudeProviderAdapter`, overridable per call on `send`/`stream`, `sendMessage`, `streamMessage`, `agentLoop`, `streamAgentLoop`, or in `beforeSend`). Each is left out of the request when unset:

- `effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max'` → `output_config.effort`. The main lever on thinking and cost.
- `thinking: { type: 'adaptive', display?: 'omitted' | 'summarized' } | { type: 'disabled' } | { type: 'between_tools' }`.
- `blockBinding: 'error' | 'drop_block'` → `thinking.block_binding.prefix_mismatch_behavior`, with the `thinking-binding-controls-2026-08-01` beta header. Needs adaptive thinking. `'error'` turns the history check on from any account (useful in tests); `'drop_block'` drops mismatched blocks instead of failing, and the drops are reported in `ProviderResponse.inputTransformations`.

**Stop reasons.** Every stored assistant message records `metadata: { stopReason, usage }`.

- `refusal`: the engine throws `RefusalError` (with `category`) and stores nothing for the assistant. When streaming, text may already have reached your UI, so discard it.
- `max_tokens` with text: the text is stored and returned with `metadata.stopReason: 'max_tokens'`.
- `max_tokens` with no text, or cut off mid tool call: the engine throws `IncompleteResponseError` and stores nothing. Thinking counts toward `maxTokens`, so raise it or lower `effort`.
- `pause_turn`: the agent loops call the provider again to continue.

**Usage.** The `afterProviderCall` hook fires after every provider call (each agent-loop iteration, and calls that end in an error) with the full response, including usage. Streamed calls now carry real `stopReason`/`usage`: the Claude adapter's final `done` chunk has a `response`, and chunks with `thinking: true` signal that the model is thinking.

**Which models accept what** (Claude API, as of 2026-10). The engine doesn't check this; a rejected request surfaces as `InvalidRequestError`.

| | Haiku 4.5 | Haiku 5.5 | Sonnet 5.5 | Opus 5.5 | Fable 5.1 |
|---|---|---|---|---|---|
| Thinks by default | No | Yes | Yes | Yes | Yes |
| Forced `toolChoice` (`'any'`, `{ type: 'tool' }`) | Yes | Yes | **400** | **400** | **400** |
| Non-default `temperature` | Yes | **400** | **400** | **400** | **400** |
| `thinking: { type: 'disabled' }` | n/a | At effort ≤ `high` | **400** (use `between_tools`) | **400** | **400** |
| `effort` | **400** | Yes (default `medium`) | Yes (default `high`) | Yes (default `medium`) | Yes |

The 5.x tokenizer counts the same text as more tokens than Haiku 4.5, and thinking counts toward `maxTokens`. Re-tune `maxTokens` when you move off Haiku 4.5. Thinking blocks are Claude-only: the OpenAI and gateway adapters leave them out of requests.

## Development

```bash
npm install
npm run typecheck
npm test
npm run build
```

Changes to `main` go through a pull request — GitHub branch protection requires 1 approval and a passing `test` status check, and a local pre-push hook (`.husky/pre-push`) blocks direct pushes to `main` as a first line of defense. CI (`.github/workflows/ci.yml`) runs typecheck/test/build on every PR.

## Releasing

Publishing uses [npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers/) (OIDC) — no long-lived npm token stored in the repo.

**First release only** (a brand-new package can't use OIDC until it exists on the registry):

```bash
npm login
npm run build
npm publish
```

Then on [npmjs.com → package settings → Trusted Publisher](https://docs.npmjs.com/trusted-publishers/), add a GitHub Actions publisher pointing at this repo and the `publish.yml` workflow.

**Every release after that:**

1. Bump `version` in `package.json` (e.g. `npm version patch`) via a PR.
2. Once merged, tag the release from `main`: `git tag v<version> && git push origin v<version>`.
3. `.github/workflows/publish.yml` builds and publishes automatically via OIDC when a tag matching `v*.*.*` is pushed.
