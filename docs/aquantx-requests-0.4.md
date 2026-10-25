# AquantX request for 0.4: thinking-capable Claude models (R6)

**Status:** built in 0.4.0 - see `docs/aquantx-response-0.4.md` (what was built, and how to adopt it).
**Requested by:** AquantX (`apps/web` and `packages/convo-adapter`, on `@smsoumitra/convo-engine`
**^0.3.0**, `@anthropic-ai/sdk` **^0.125.0**).
**Earlier rounds:** `docs/aquantx-requests.md` (R1-R5, requested 2026-10-16),
`docs/aquantx-response.md` (what 0.3.0 built), `docs/aquantx-0.3.0-adoption.md` (the upgrade
guide). Section 1 below says how AquantX actually adopted 0.3.0, including where it differs
from that guide.
**Priority:** **P1** - it blocks AquantX from moving off Claude Haiku 4.5.

**In one paragraph.** The current Claude models (Haiku 5.5, Sonnet 5.5, Opus 5.5, Fable 5.1)
*think* by default: responses can contain `thinking` blocks. convo-engine doesn't know the block
type, so `ClaudeProviderAdapter` turns each one into an **empty text block**. When that history
is sent back, the API rejects it (`400 messages: text content blocks must be non-empty`). On Haiku
5.5 this broke a plain two-turn `agentLoop` in testing. Fixing the translation isn't enough on
its own, because these models also **bind each thinking block to the exact conversation that
produced it**. A caller that rebuilds its system prompt every turn - AquantX does - gets a
different 400 if it replays old thinking. The engine needs to (a) carry thinking blocks
faithfully, (b) let the caller choose how much thinking history to replay, (c) expose the
thinking/effort request settings, and (d) report stop reasons and usage properly, streaming
included. Details, evidence and tests follow.

---

## 1. How AquantX adopted 0.3.0 (for context)

AquantX moved to `^0.3.0` on 2026-10-23 (AquantX commits `43bb1f5`, `e727dfb`, `844302d`). Its
record is `docs/convo-engine-0.3.0-upgrade.md` in the AquantX repo.

### Where AquantX calls the engine

| Call | Engine API | Model | Notes |
|---|---|---|---|
| **Think** - the surveyor's private copilot conversation | `engine.streamMessage(threadId, text, { systemPrompt })` - **no tools** | `ANTHROPIC_MODEL` (Haiku 4.5) | The system prompt is **rebuilt on every turn**: the knowledge pack, the case record, the evidence register, issued reports, and the surveyor's corrections since the last reply. Threads persist in Postgres through `AquantXStorageAdapter` (`packages/convo-adapter`), which JSON-serialises `Message.content` verbatim, so any new block type round-trips with no adapter change. |
| **Client intake** - the applicant creates an assignment | `engine.agentLoop(threadId, text, { tools, toolExecutor, systemPrompt })` | Haiku 4.5 | Tools save job details. The system prompt also carries per-turn state. |
| **Structured calls** - case-fact extraction, evidence (photo/document) review, cross-batch check, report drafting, pre-issue report check | `ClaudeProviderAdapter.send({ systemPrompt, tools: [oneTool], messages, toolChoice })` on a bare adapter, no engine or thread | Haiku 4.5; the **report check runs on Sonnet 5.5** | One-shot: the result must be one specific tool call. |

### What AquantX uses from 0.3.0

- **R1 `toolChoice`.** It is used only where the model accepts it. AquantX has
  `canForceToolsAndSetTemperature(model)` (`apps/web/src/lib/convo/models.ts`), true only for
  `claude-haiku-4-5*`.
  - Forced path, in `requestToolCall` (`apps/web/src/lib/convo/tool-call.ts`):
    `toolChoice: { type: 'tool', name }`. A missing call, or `stopReason === 'max_tokens'`, is
    logged and returns `undefined`.
  - Unforced path, used for the report check on Sonnet 5.5: the original prose follow-up turn
    ("please call X now"). It echoes the first response's blocks minus empty text blocks.
  - AquantX doesn't pass `toolChoice` to `agentLoop`.
- **R2 `document` blocks.** Used only inside the one-shot evidence-review `send()`. A PDF is sent
  as base64, and a CSV/.xlsx as one text document per sheet, converted by AquantX. They are
  **never stored in a thread**, to keep MBs out of `chat_messages`.
- **R3 typed errors.** The evidence review uses `getStructuredProvider(2048, undefined,
  { maxRetries: 0 })` with its own `withRetry`, driven by `ProviderError.retryable` and
  `retryAfterMs`.
- **R4 adapter options.**
  - `getStructuredProvider(maxTokens, model?, { maxRetries })` caches one adapter per
    `model:maxTokens:maxRetries`.
  - It sets `temperature: 0` **only** for Haiku 4.5. Sonnet 5.5 returns a 400 for any non-default
    temperature, which AquantX confirmed live.
  - AquantX keeps `@anthropic-ai/sdk` on 0.x (`^0.125.0`) because of this.
- **R5 system-prompt blocks + `cacheBreakpoint`. Not adopted yet.** It is step 6 of AquantX's
  upgrade plan and depends on this request: see §5, "Think's system prompt".
- **F1 `SendContext.iteration`.** Available, but no `beforeSend` hook is installed yet.
- **Verification.** `pnpm --filter @aquantx/convo-adapter verify:engine`
  (`packages/convo-adapter/src/verify-engine.ts`) runs 11 live checks. All passed on
  2026-10-23. They cover:
  - R1 on Haiku 4.5;
  - Sonnet 5.5 rejecting forced `tool_choice` and `temperature: 0`, and working unforced;
  - R2 PDF and CSV reading;
  - R3 `AuthenticationError`;
  - R5 cache reads;
  - F1 with `agentLoop` forcing a tool on iteration 1 only.

### Differences from `docs/aquantx-0.3.0-adoption.md`

- **Step 3** (`temperature: 0`) and **step 4** (forced tools) apply only on Haiku 4.5. The guide
  assumed one model for every call, but the report check stays on Sonnet 5.5, where both are 400s.
- **Step 4.** `report-drafting.ts` moved onto `requestToolCall` too; its own two-attempt loop is
  gone.
- **Step 7.** Documents went into the one-shot evidence review only, not into Think threads.
- **Step 6** (Think caching) is not done. See §5.

---

## 2. The problem, with evidence

### 2.1 Reproduction (2026-10-24, live, AquantX's API key)

Through convo-engine 0.3.0, `ClaudeProviderAdapter({ model, maxTokens: 1024, maxRetries: 0 })`,
the `InMemoryStorageAdapter`, and one tool (`record_quantity`):

```ts
await engine.agentLoop(thread.id, 'We counted 140 cartons. Record it with the tool, then say "done".', { tools: [TOOL], toolExecutor: async () => 'recorded' });
await engine.agentLoop(thread.id, 'Now 63 crushed cartons too - record that, then say "ok".',        { tools: [TOOL], toolExecutor: async () => 'recorded' });
```

| Model | `provider.send()` of a one-line question | Two-turn `agentLoop` |
|---|---|---|
| `claude-haiku-5-5` | ok, but `content` = `[{"type":"text","text":""},{"type":"text","text":"140"}]` | **400** `messages: text content blocks must be non-empty` (request `req_011CgLtM3MoJ9ZrsFo5BBnLg`) |
| `claude-sonnet-5-5` | ok, same empty first block | passed, by luck: the model happened not to think on the tool turns |

The empty first text block is the translated `thinking` block.

### 2.2 Root cause in the code

- **`src/adapters/provider/claude.ts`, `translateResponse` (around line 318).** `// Fallback for
  unexpected block types` returns `{ type: 'text', text: '' }`. Every `thinking` and
  `redacted_thinking` block becomes an empty text block, and the signature is lost.
  `translateMessages` then sends that empty text back, and the API rejects it. Even if it didn't,
  the thinking block the API expects has gone.
- **`claude.ts` `stream()` (lines ~90-115).** It yields only `text_delta`, then `tool_use` blocks
  from `finalMessage()`. Thinking blocks are silently dropped, and `stop_reason` and `usage` from
  `finalMessage()` are thrown away.
- **`src/engine.ts` `streamMessage` (~222-245) and `streamAgentLoop` (~446-475).**
  - They rebuild the stored assistant content as "text buffer, then tool_use blocks". That loses
    block order and any non-text, non-tool block.
  - `rawResponse.stopReason` is hard-coded to `'stop'` and `usage` to zeros. So `afterReceive`
    hooks can't see `max_tokens` or `refusal`, and consumers can't measure cost on streamed
    calls.
- **`agentLoop` (~326).** Anything other than `stopReason === 'tool_use'` ends the loop as a
  finished answer, including `max_tokens` (which, with thinking, can mean "thought, wrote
  nothing") and `refusal`.
- **`ContentBlock` (`src/types.ts`)** has no thinking types, so a consumer can't round-trip them
  either.
- The **OpenAI and gateway adapters'** `translateMessages` switches have no `default:` case. Once
  thinking blocks exist in a history, they need an explicit skip; see R6.8.

### 2.3 Why "just drop thinking blocks" isn't the fix

The API rules this design relies on. "Verified" means AquantX checked it live on 2026-10-24.
Everything else is from Anthropic's current model-migration documentation for these models.

1. **Thinking is on by default** for Haiku 5.5, Sonnet 5.5, Opus 5.5 and Fable 5.1 when the
   request has no `thinking` field (adaptive thinking). Haiku 4.5 doesn't think unless asked.
   *Verified.*
2. **Thinking text is omitted by default** (`display: "omitted"`). A `thinking` block comes back
   with `thinking: ""` and a `signature`. `display: "summarized"` returns a readable summary.
   Thinking is billed either way.
3. **On the same model, thinking blocks must be passed back exactly as received**, including
   empty ones and `redacted_thinking`, especially with tool results in the same turn. A serializer
   that skips empty blocks removes the thinking.
4. **A thinking block is bound to its conversation prefix:** the top-level `system`, the `tools`
   set, and every earlier message. If any of that changes and the block is replayed, the request
   fails with a 400 (`messages.N.content.0: Invalid signature in thinking block. The block is
   bound to a different conversation …`).
   - Enforcement is the default for accounts created on or after 2026-08-31.
   - Older accounts are checked only when the request sets
     `thinking.block_binding.prefix_mismatch_behavior` (beta header
     `thinking-binding-controls-2026-08-01`). Any value, `"error"` included, opts the request in.
   - *Verified on Haiku 5.5:* with `"error"` set and the system prompt changed between turns,
     replaying turn 1's thinking block gave exactly this 400.
5. **Removing thinking blocks from the front of the history is allowed;** removing them from the
   middle is not. Each block records the one before it, but earlier thinking blocks aren't part of
   a later block's prefix. So dropping all thinking from earlier turns while keeping the current
   turn's is valid.
   - *Verified on Haiku 5.5,* with enforcement forced on via `"error"`:
     1. Turn 1 ran under system S1: tool round, then answer, with the thinking kept inside the
        turn.
     2. Turn 2 ran under a different system S2, with turn 1's thinking stripped. Its tool round
        and answer both passed.
   - The negative control (S2 with turn 1's thinking kept) failed with the 400 above.
6. `"drop_block"` instead of `"error"` makes the API drop the first mismatched block **and every
   later thinking block**, then proceed. The drops are reported in a top-level
   `input_transformations` array on the response (beta header required).
7. **Thinking counts toward `max_tokens`.** A tight cap can end a response with
   `stop_reason: "max_tokens"` after a `thinking` block and before any text or tool call.
8. **`effort`** (`output_config: { effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max' }`) is
   how to control how much these models think.
   - Defaults: `medium` on Haiku 5.5 and Opus 5.5, `high` on Sonnet 5.5.
   - Changing it between requests doesn't invalidate thinking blocks, but it does restart the
     prompt cache.
   - Haiku 4.5 rejects `effort`.
9. **Turning thinking off:**
   - `thinking: { type: 'disabled' }` is accepted by Haiku 5.5 at effort ≤ `high`, but it's a
     400 on Sonnet 5.5 (which has `{ type: 'between_tools' }` instead) and on Fable 5.1.
   - `budget_tokens` (`{ type: 'enabled', budget_tokens }`) is a 400 on all 5.x models.
10. **Forced `tool_choice`** (`any` / `{type:'tool'}`) is a 400 on Sonnet 5.5, Opus 5.5 and
    Fable 5.1; *verified for Sonnet 5.5*. Haiku 5.5 accepts it, and the response then starts with
    the tool call and has no thinking.
11. **Sampling parameters:** non-default `temperature`/`top_p`/`top_k` are 400s on all 5.x models
    (on API version 2023-06-01, `temperature` must be 1 if sent).
12. **`stop_reason: "refusal"`** (HTTP 200, with `stop_details.category`) is possible on the 5.x
    models, from safety classifiers. Handle it before reading `content`.
13. The 5.x tokenizer counts the same text as about **30% more tokens** than Haiku 4.5. That
    matters for any `max_tokens` tuned on Haiku 4.5.

---

## 3. R6 - what we're asking for

The numbering is for discussion; ship it as one release. Names and shapes are proposals. Adjust
them to fit the engine's design, as with R1-R5.

### R6.1 - Thinking content blocks, round-tripped exactly

Add to `ContentBlock` (`src/types.ts`):

```ts
| { type: 'thinking';          thinking: string; signature: string }
| { type: 'redacted_thinking'; data: string }
```

- **`ClaudeProviderAdapter.translateResponse`:** map Anthropic's `thinking` and
  `redacted_thinking` blocks to these, verbatim: same text, same signature, same position.
- **`ClaudeProviderAdapter.translateMessages`:** send them back verbatim
  (`{ type: 'thinking', thinking, signature }`, `{ type: 'redacted_thinking', data }`). They are
  never dropped because their text is empty.
- **Remove the empty-text fallback.** Unknown block types must never become `{type:'text',
  text:''}`. Proposal: keep any block type the adapter doesn't recognise as an opaque passthrough
  (see the open questions), or at minimum drop it and call `onError`/a debug hook. Never invent
  text.
- **Defensive send-side guard:** in `translateMessages`, skip `text` blocks whose `text` is empty
  or only whitespace (the API rejects them). If a message would end up with no blocks, fail
  before sending with a clear `InvalidRequestError` rather than sending an empty `content` array.
  This also protects histories stored by 0.3.0 that already contain such blocks.
- **`cacheBreakpoint` on a message whose last block is `thinking`:** put `cache_control` on the
  last *non-thinking* block. Check Anthropic's rule; thinking blocks can't carry `cache_control`
  directly.
- **Breaking change:** consumers with an exhaustive `switch` over `ContentBlock` must handle the
  new types. Note it in the changelog and treat the release as 0.4.0. AquantX filters by `type`,
  so it's unaffected.

### R6.2 - Streaming keeps the whole response

- **`ClaudeProviderAdapter.stream()`:**
  - Keep yielding `text_delta` strings as today.
  - On the final chunk, also return the **complete translated response** taken from
    `stream.finalMessage()`: all content blocks in order (thinking, text, tool_use), the
    `stop_reason`, and `usage` including cache fields.
  - Proposal: `ProviderStreamChunk` gains `response?: ProviderResponse` on the `done: true`
    chunk.
  - Optionally, a lightweight signal while the model is thinking, so a UI can show "thinking…"
    instead of a silent pause. For example, a chunk `{ delta: '', done: false, thinking: true }`
    when a `thinking` content block starts. With `display: 'summarized'`, optionally also stream
    the summary text through a separate field. Nice to have.
- **`engine.streamMessage` / `streamAgentLoop`:**
  - When the provider supplies `response`, **persist `response.content` as-is**: same blocks, same
    order. Fall back to today's text-buffer assembly only for adapters that don't supply it
    (OpenAI and gateway, until they do).
  - Use `response.stopReason` and `response.usage` for the `rawResponse` passed to `afterReceive`,
    instead of `'stop'` and zeros.
  - In `streamAgentLoop`, continue the loop on `response.stopReason === 'tool_use'`. Today the
    test is "were tool_use blocks seen", which also works; keep whichever is more robust.
- **Why this matters:** without it, a streamed tool round loses its thinking, as today. On a
  model that thinks between tool calls, that can trip rule 3 or 5, and token usage on streamed
  calls stays invisible to consumers.

### R6.3 - Thinking and effort request options (Claude adapter)

On `ClaudeProviderAdapterOptions`, all optional, with each omitted from the request when unset so
today's behaviour is unchanged:

```ts
thinking?:
  | { type: 'adaptive'; display?: 'omitted' | 'summarized' }
  | { type: 'disabled' }
  | { type: 'between_tools' };          // Sonnet 5.5
effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';   // → output_config: { effort }
```

- Also allow a **per-call override** on `ProviderInput` (`thinking?`, `effort?`), and pass it
  through `sendMessage`, `streamMessage`, `agentLoop` and `streamAgentLoop`, like `toolChoice`.
  AquantX wants, for example, `low` effort for extraction and `medium`/`high` for Think on one
  model.
- **Don't validate model compatibility in the engine.** That's the API's job, and its 400s
  already map to `InvalidRequestError`. Do add a short table to the README of which models accept
  what (rules 8-11).
- **SDK typing:** convo-engine's dev dependency is `@anthropic-ai/sdk ^0.24.0` (0.24.3
  installed), which predates adaptive thinking, `output_config` and `block_binding`. Either bump
  the dev dependency to the 0.12x line AquantX uses (`^0.125.0`) or keep the cast-through
  approach `buildParams` already uses. Keep the peer range so 0.x consumers aren't forced to SDK
  1.x. Note: SDK 1.x defaults to API version `2026-10-21`, where any `temperature` is a 400.

### R6.4 - Choosing how much thinking history to replay (the key part for AquantX)

A new engine option (proposal), settable on the `ConversationEngine` config and overridable per
call:

```ts
thinkingHistory?: 'all' | 'current-turn' | 'none';   // default 'all'
```

| Mode | What's sent | Use when |
|---|---|---|
| `'all'` (default) | Every stored thinking block, verbatim | The conversation is **append-only**: the same system prompt and tools every turn. Best reasoning continuity, and best cache behaviour. |
| `'current-turn'` | Strips `thinking`/`redacted_thinking` from every message **before the latest user message that isn't a tool result**, and keeps those of the current `agentLoop`/`streamAgentLoop` round verbatim | The caller **rebuilds the system prompt or tools between turns** (AquantX Think and intake). Safe under the history-editing check: it removes only a leading run of blocks; rule 5, verified. |
| `'none'` | Strips all thinking blocks from what's sent | Last resort, or a one-time recovery. Tool rounds then run without their own reasoning, so only use it if `current-turn` fails. |

Requirements:
- Stripping applies **only to what is sent**. Storage always keeps the full verbatim blocks, so a
  consumer can switch modes later.
- Implement it as a step after `strategy.assemble()` and before `provider.send/stream`, or as a
  `ContextStrategy` wrapper. It must also apply to custom strategies.
- After stripping, a message with no blocks left must be removed or merged sensibly, never sent
  empty. It can't actually happen, since a thinking-only assistant message only arises from
  `max_tokens`/`refusal` (R6.6), but guard it.
- Document plainly, in the README, that **changing `systemPrompt` or `tools` between turns
  requires `'current-turn'`** on Haiku 5.5, Sonnet 5.5, Opus 5.5 and Fable 5.1, or the account
  will see 400s once enforced. Accounts created from 2026-08-31 are enforced already.

### R6.5 - Opt-in history-check controls (Claude adapter)

```ts
blockBinding?: 'error' | 'drop_block';   // on ClaudeProviderAdapterOptions and per call
```

- When set, send `thinking.block_binding.prefix_mismatch_behavior` and add the beta header
  `thinking-binding-controls-2026-08-01`.
  - Sending `block_binding` without the header is a 400.
  - It needs `thinking.type` `adaptive` or `enabled`. With `blockBinding` set and no `thinking`
    option, send `thinking: { type: 'adaptive', block_binding: … }`.
  - Use the SDK's `betas` parameter on `client.beta.messages.create`/`stream`, or a header via
    request options.
- Surface the response's top-level `input_transformations` array on `ProviderResponse`
  (`inputTransformations?: { type: string; path: string; reason: string }[]`). Unknown entry
  types are passed through, not rejected.
- **Use in tests:** `'error'` turns on enforcement from an older account, which is how the R6.4
  tests can prove the history-editing check really runs. **Use in production:** `'drop_block'`
  degrades instead of failing, if a consumer edits history by mistake.

### R6.6 - Stop reasons: `refusal`, `max_tokens`, `pause_turn`

- Pass the real `stop_reason` through on `send()` and, via R6.2, on `stream()`. Also expose
  `stop_details` (at least `category`) on `ProviderResponse`, e.g. `stopDetails?: { category?:
  string }`.
- **`agentLoop` / `streamAgentLoop`:**
  - **`refusal`:** don't persist the assistant content. Throw a new typed, non-retryable
    `RefusalError extends ProviderError` carrying `category`, after the user message has been
    stored, as today for other errors. The consumer decides what to tell its user. Alternatively,
    persist with `metadata.stopReason = 'refusal'` and return; but a partial refused turn must
    not be replayed to the model later, so throwing is simpler.
  - **`max_tokens`:**
    - Persist what came back, and record `metadata.stopReason = 'max_tokens'` on the stored
      assistant message (it's opaque metadata, already supported).
    - If the content is thinking-only (no text, no tool_use), don't persist it. Throw a typed
      error, or return a message with `metadata.incomplete = true`. Your call, but make it
      detectable.
    - Don't treat it as a clean finish silently.
  - **`pause_turn`** (server tools): out of scope unless trivial. At least don't treat it as
    finished.
- **`sendMessage` / `streamMessage`:** same `stopReason` metadata on the stored message; same
  refusal handling.
- Record `stopReason` (and usage, see R6.7) in the stored assistant message's `metadata` for all
  four methods. AquantX can then show "the answer was cut off" and measure cost per thread.

### R6.7 - Usage on every path

`usage` (input, output, cache read, cache write) from `send()` today, and from `stream()` via
R6.2. Expose it on `afterReceive`'s `rawResponse` for **every** method, including each iteration
of the agent loops (one `afterReceive`-style signal per provider call, or an accumulated total per
loop - say which). AquantX will use it to compare Haiku 4.5 / Haiku 5.5 / Sonnet 5.5 costs per
conversation.

### R6.8 - Non-Claude adapters

- **OpenAI and gateway `translateMessages`:** skip `thinking` and `redacted_thinking` blocks
  explicitly. Another provider can't read them, and they must not reach it as text. Add a
  `default:` branch so a future block type fails loudly in tests, not silently.
- No thinking support is asked for on those providers.

### R6.9 - README and changelog

- A **"Thinking models"** section covering:
  - the rules in §2.3 that affect consumers (3, 4, 5, 7, 8, 9, 10, 11, 12);
  - the `thinkingHistory` modes, with "rebuilding the system prompt each turn ⇒
    `'current-turn'`";
  - `effort` as the cost lever;
  - the model compatibility table for `toolChoice`, `temperature`, `thinking: disabled` and
    `effort`.
- **Changelog:** the `ContentBlock` union grows, empty-text fallback removed, streamed
  `rawResponse` now carries real `stopReason`/`usage`, and `RefusalError`.

---

## 4. Tests - how we'd know it's done

### Unit (mocked SDK, `tests/claude-adapter.test.ts`, `tests/engine.test.ts`)

- [ ] **Response mapping.** A response `[thinking(signature "s1", text ""), text "140"]` maps to
      `[{type:'thinking', thinking:'', signature:'s1'}, {type:'text', text:'140'}]`.
      `redacted_thinking` maps the same way. No empty text block is ever produced.
- [ ] **Request mapping.** The same blocks in a history are sent back byte-for-byte, in order.
      An empty or whitespace-only `text` block in a stored history is not sent.
- [ ] **Unknown blocks.** An unrecognised response block type doesn't become `{type:'text',
      text:''}`.
- [ ] **Stream final response.** `stream()`'s final chunk carries `response` with all blocks in
      order, the real `stopReason` and `usage`.
      - `streamMessage` and `streamAgentLoop` persist exactly those blocks.
      - `afterReceive` sees the real `stopReason`/`usage`.
- [ ] **`thinkingHistory: 'current-turn'`.** Given a stored history of turn 1 (user, assistant
      `[thinking, tool_use]`, user `[tool_result]`, assistant `[thinking, text]`) and turn 2 in
      progress (user, assistant `[thinking, tool_use]`, user `[tool_result]`):
      - every turn-1 thinking block is stripped from the request;
      - every turn-2 thinking block is kept;
      - storage is unchanged.
      `'all'` keeps everything and `'none'` strips everything.
- [ ] **Options mapping.**
      - `thinking`/`effort` reach the request as `thinking: {...}` and
        `output_config: { effort }`.
      - A per-call value overrides the adapter default.
      - Omitted options mean no field is sent, as in 0.3.0.
- [ ] **`blockBinding`.** It adds `thinking.block_binding.prefix_mismatch_behavior` and the beta
      header, and `input_transformations` is surfaced.
- [ ] **`refusal`.** A mocked `stop_reason: 'refusal'` with `stop_details.category: 'cyber'`
      makes `agentLoop` throw `RefusalError` (`retryable: false`, `category: 'cyber'`), with
      nothing persisted for the assistant.
- [ ] **`max_tokens`.** A thinking-only `max_tokens` response is detectable, as designed in R6.6.
- [ ] **Non-Claude adapters.** OpenAI and gateway adapters drop thinking blocks from requests.

### Live (behind `describe.skipIf(!process.env.ANTHROPIC_API_KEY)`, `tests/claude-adapter.integration.test.ts`)

Run each on `claude-haiku-5-5` and `claude-sonnet-5-5`. Use `effort: 'high'` and a prompt that
invites reasoning, so the model actually thinks (Sonnet often skips thinking on trivial turns).
Use `blockBinding: 'error'` to force the history check on, whatever the account's age.

- [ ] **The original bug.** Two-turn `agentLoop` with a tool, same system prompt, default
      `thinkingHistory: 'all'`: no 400. The stored history contains `thinking` blocks with
      non-empty signatures.
- [ ] **The AquantX shape.** Two-turn `agentLoop` with the **system prompt changed between
      turns**:
      - `thinkingHistory: 'current-turn'`: no 400.
      - Same with `'all'`: the expected 400 (`bound to a different conversation`), mapped to
        `InvalidRequestError`. Assert this only when turn 1 actually produced a thinking block;
        log and skip otherwise.
- [ ] **Streaming.** `streamMessage` and `streamAgentLoop` repeat the above. The persisted
      content includes the thinking blocks, and `afterReceive` gets real `usage` (> 0).
- [ ] **`display: 'summarized'`.** Returns a non-empty `thinking` string at least once across a
      couple of tries.
- [ ] **Unforced structured call.** A one-shot `send()` with one tool and `toolChoice` unset on
      Sonnet 5.5: the tool is called. Echoing the response into a follow-up turn (AquantX's
      unforced path) doesn't 400.
- [ ] **Low `max_tokens`.** `max_tokens: 64` with `effort: 'high'` surfaces `stopReason:
      'max_tokens'` correctly, as designed in R6.6.

The AquantX probe scripts that produced §2.1 and the rule 5 check are summarised there and above.
Reuse their shape.

---

## 5. How AquantX will adopt R6 (so the design fits)

- **Think (`streamMessage`).** It will use `thinkingHistory: 'current-turn'`, because the system
  prompt is rebuilt every turn. AquantX may later move per-turn context into appended
  `role: 'system'` messages, the API's append-only pattern, to get `'all'` plus cache hits. That
  would need engine support for mid-conversation system messages, which is a possible later
  request, not part of this one. `effort` will be set per model; `display` stays `omitted`, and
  the R6.2 "thinking…" signal will drive a UI indicator.
- **Think's system prompt.** AquantX's upgrade step 6 (R5 caching) will split the system prompt
  into a stable cached block (the knowledge pack and instructions) and a per-turn block. With
  `'current-turn'` that's compatible; the history-editing check doesn't affect caching of the
  stable block.
- **Client intake (`agentLoop`).** `thinkingHistory: 'current-turn'`, and `effort: 'low'` or
  `'medium'`.
- **Structured calls (`send()`).**
  - `effort: 'low'` on extraction and evidence review, and a raised `max_tokens` (thinking counts
    against it).
  - `canForceToolsAndSetTemperature` will gain Haiku 5.5 for `toolChoice` only, since Haiku 5.5
    accepts forced tools but not `temperature`. AquantX will split that helper in two.
- **Model choice.** AquantX intends to compare Haiku 5.5, Sonnet 5.5 and Haiku 4.5 on Think and
  the structured calls, using R6.7 usage numbers. It will extend
  `packages/convo-adapter/src/verify-engine.ts` with R6 checks.
- **No AquantX workaround.** AquantX won't strip empty blocks on its side; it waits for 0.4.0.

---

## 6. Out of scope / not asked

- Thinking on OpenAI or gateway providers.
- Mid-conversation `role: 'system'` messages, `clear_at`, per-message effort, server-side
  compaction or context editing. These may be future requests once AquantX moves Think to an
  append-only history.
- `budget_tokens` (manual thinking budgets). They're 400s on the 5.x models, and AquantX doesn't
  use thinking on Haiku 4.5.
- Model-specific validation inside the engine. Leave it to the API's 400s, and document it.

## 7. Open questions for the implementer

1. **Unknown response block types.** Opaque passthrough (e.g. `{ type: 'provider_raw'; provider:
   'claude'; block: unknown }`, re-sent verbatim to the same provider and skipped by others), or
   drop plus a warning? AquantX slightly prefers passthrough, because dropping a block from the
   middle of a turn can itself break the thinking chain (rule 5). But the R6.1 types cover
   everything AquantX expects to see.
2. **Thinking-only `max_tokens`.** Throw, or return with `metadata.incomplete`?
3. **Loop usage.** Per-call usage via a new `afterProviderCall`-style hook, or an accumulated
   total in `afterReceive`?
4. **`'current-turn'` boundary.** The latest `user` message whose content isn't solely
   `tool_result` blocks. Confirm this matches how `agentLoop` stores tool results (as `user`
   messages with `tool_result` content - it does today).
