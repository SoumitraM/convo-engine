# convo-engine 0.4.0: response to AquantX's R6, and how to adopt it

**Answers:** `docs/aquantx-requests-0.4.md` (R6, requested 2026-10-25).
**Status:** R6.1–R6.9 are built and unit-tested. They ship in **0.4.0**: see `CHANGELOG.md`, and the
README's "Thinking models" section.
**Live tests:** all 12 R6 live checks pass on Haiku 5.5 and Sonnet 5.5 (run 2026-10-25). See
"Testing" at the end.
**AquantX files referenced** were read on 2026-10-25 (AquantX `6eb17f1`). Paths in Part 2 are
relative to the AquantX repo root.

Part 1 covers what was built and where it differs from the request. Part 2 is the step-by-step
adoption.

| Req | Built as proposed? | Notes |
|---|---|---|
| R6.1 Thinking blocks | Yes | Unknown blocks become `provider_raw` (your preferred option). An empty **assistant** message is dropped, not rejected |
| R6.2 Streaming | Yes, including the "thinking…" signal | `streamAgentLoop`'s single `done` chunk carries the last iteration's `response` |
| R6.3 `thinking` / `effort` | Yes | Dev SDK not bumped; the peer range is unchanged and that's now safe (see below) |
| R6.4 `thinkingHistory` | Yes | Caveat for `beforeSend` hooks that edit the request: see "Difference 4" |
| R6.5 `blockBinding` | Yes | Combining it with non-adaptive `thinking` is rejected before sending |
| R6.6 Stop reasons | Yes | Thinking-only `max_tokens` **throws** `IncompleteResponseError`. So does a tool call cut off by `max_tokens` |
| R6.7 Usage | Yes | A new per-call `afterProviderCall` hook, plus `metadata.usage` on every stored assistant message |
| R6.8 Other adapters | Yes | |
| R6.9 Docs | Yes | |

---

# Part 1: What was built

## R6.1: Thinking blocks round-trip exactly

`ContentBlock` gains three members:
- `{ type: 'thinking'; thinking; signature }`;
- `{ type: 'redacted_thinking'; data }`;
- `{ type: 'provider_raw'; provider; block }`.

The Claude adapter maps them both ways, verbatim and in position. The empty-text fallback is gone.

On send, the adapter drops `text` blocks that are empty or only whitespace. That also repairs
histories stored by 0.3.0. `cache_control` goes on the last block that isn't thinking.

### Difference 1: unknown blocks are kept, as `provider_raw`

This is the passthrough you preferred, and it answers open question 1. A response block the adapter
doesn't model is stored verbatim, re-sent unchanged to Claude, and skipped by the OpenAI and gateway
adapters. Blocks such as server-side `fallback` blocks are already appearing, and dropping one from
the middle of a turn could break the thinking chain.

### Difference 2: an empty assistant message is dropped, not an error

The request asked for an `InvalidRequestError` when a message would end up with no blocks. That is
what happens for a **user** message. An **assistant** message left with nothing is dropped instead.
A 0.3.0 thread can hold `[{ type: 'text', text: '' }]` (a thinking-only `max_tokens` reply), and
throwing would make that thread fail on every later turn. The API merges the user turns on either
side, so dropping the message is safe.

## R6.2: Streaming keeps the whole response

`ClaudeProviderAdapter.stream()` still yields text deltas and then `tool_use` blocks. Its
`done: true` chunk now also carries `response`: every block in order, the real `stopReason`, and
`usage` including the cache fields.

While the model thinks, chunks arrive with `thinking: true` and `delta: ''`. With
`display: 'summarized'`, those chunks also carry `thinkingDelta` text.

`streamMessage` and `streamAgentLoop` store `response.content` as-is. `afterReceive` sees the real
`stopReason` and `usage`. `streamAgentLoop` continues on `stopReason === 'tool_use'`.

**One fix you didn't ask for:** thinking text and signatures arrive as `thinking_delta` and
`signature_delta` events. Older `@anthropic-ai/sdk` 0.x releases leave these out of
`finalMessage()`; the 0.24 dev dependency does, for example. So a streamed thinking block came back
with an empty signature, and the next request would have 400'd. The adapter now accumulates them
itself, so this works whatever SDK version is installed. It also picks up `stop_details` from
`message_delta` for the same reason.

## R6.3: `thinking` and `effort`

These are on `ClaudeProviderAdapterOptions` and per call: on `ProviderInput`, all four engine
methods, and `SendContext`, so a `beforeSend` hook can change them per iteration. Each is left out
of the request when unset.

- `effort` maps to `output_config: { effort }`.
- There's no model validation, as requested. The README has the compatibility table.
- The dev SDK stays at 0.24 using the cast-through approach. The peer range stays `>=0.20.0`. Thanks
  to the streaming fix above, the SDK version no longer affects thinking.

## R6.4: `thinkingHistory`

`thinkingHistory: 'all' | 'current-turn' | 'none'` can be set on the engine config and per call.
It runs after `strategy.assemble()`, so it applies to custom strategies too. It never changes
storage.

`'current-turn'` keeps thinking only from the latest `user` message that isn't solely
`tool_result` blocks. That answers open question 4: `agentLoop` stores each tool result as a `user`
message holding only `tool_result` blocks.

A message left empty after stripping is removed, and its cache breakpoint moves to the message
before it. The function is exported as `applyThinkingHistory`.

### Difference 4: a `beforeSend` edit must be the same on every iteration of a turn

`'current-turn'` makes changes **between** turns safe. It can't help with a change **within** a
turn. The 0.3.0 adoption guide's step 6 sketched a `beforeSend` hook that adds the assignment
context to the user message on `iteration === 1` only. On a thinking model, iteration 2 would send
that user message without the context. Iteration 1's thinking was produced with it, so it no longer
matches, and the request 400s.

Any request edit a hook makes must be the same on every iteration of a turn. Step 4 below avoids
the problem entirely.

## R6.5: `blockBinding`

`blockBinding: 'error' | 'drop_block'` is on the adapter and per call. It sends
`thinking: { type: 'adaptive', [display], block_binding: { prefix_mismatch_behavior } }`.

- The beta header `thinking-binding-controls-2026-08-01` goes in request options rather than
  `client.beta.messages`, so it works on every 0.x SDK.
- If `thinking` is `disabled` or `between_tools`, the adapter throws `InvalidRequestError` before
  sending. The API only accepts `block_binding` with adaptive thinking on Haiku 5.5 and Sonnet 5.5.
- `ProviderResponse.inputTransformations` passes the response's `input_transformations` array
  through as-is.

## R6.6: Stop reasons

`ProviderResponse.stopDetails` carries `{ category?, explanation? }`. All four engine methods
handle stop reasons the same way:

| `stopReason` | Stored? | Result |
|---|---|---|
| `refusal` | No | Throws `RefusalError` (`category`, `explanation`, `retryable: false`) |
| `max_tokens` with text, no `tool_use` | Yes, `metadata.stopReason: 'max_tokens'` | Returned. The loop ends |
| `max_tokens` with no text, **or with a `tool_use`** | No | Throws `IncompleteResponseError` (`stopReason`, `retryable: false`) |
| `pause_turn` | Yes | Agent loops call the provider again. `sendMessage`/`streamMessage` return it with `metadata.stopReason` |
| anything else | Yes, `metadata.stopReason` | As before |

### Difference 5: a `max_tokens` tool call throws too

You asked about thinking-only responses. A tool call cut off by `max_tokens` has a truncated input.
Storing it would also leave a `tool_use` with no `tool_result`, and the next request on that thread
would 400. So that case throws as well. This answers open question 2: throwing is easy to detect,
and nothing half-finished gets stored.

In every case the user message stays stored, as with other errors.

**Streaming:** a refusal can arrive after some text has already streamed. The engine throws once
the stream ends. Throw away whatever partial text the UI has shown.

**Bare adapter calls** (`provider.send()` with no engine) don't throw on these. They return the
response with `stopReason` and `stopDetails`, so your structured calls must check them (step 5).

## R6.7: Usage on every path

This answers open question 3 with two signals:

- A new `afterProviderCall({ thread, userMessage, iteration, response, assistantMessage? })` hook.
  It fires once per provider call: every agent-loop iteration, and calls that end in
  `RefusalError`/`IncompleteResponseError`, which are billed too. Errors in the hook go to `onError`
  with phase `'afterProviderCall'`.
- Every stored assistant message has `metadata: { stopReason, usage }`.

`afterReceive` is unchanged: once per turn, and `rawResponse` is the final call's response. Adding a
second meaning to it would have broken its "fires once" contract.

## R6.8 and R6.9

The OpenAI and gateway adapters skip `thinking`, `redacted_thinking` and `provider_raw` blocks. They
have an exhaustive `default:` branch that throws on a future block type.

README: "Thinking models". Changelog: `CHANGELOG.md`.

**Breaking changes, all checked against AquantX:**
- **The `ContentBlock` union grows.** AquantX filters by `type` everywhere, so no change is needed.
- **New errors.** Refusals and unusable `max_tokens` responses now throw.
- **Stored metadata.** Assistant messages now carry `metadata`.
- **Wider union types.** `ProviderName` gains `'custom'`, and `onError`'s phase gains
  `'afterProviderCall'`.

---

# Part 2: Adopting 0.4.0 in AquantX

Ship steps 1–3 first: they're safe on Haiku 4.5 and change nothing visible. Steps 4–6 prepare each
call path for a 5.x model. Step 7 is the model switch.

## 1. Upgrade

In `apps/web/package.json` and `packages/convo-adapter/package.json`:

```json
"@smsoumitra/convo-engine": "^0.4.0"
```

Keep `@anthropic-ai/sdk` at `^0.125.0`. Nothing in R6 needs a different SDK.

## 2. Typecheck and run the tests

There should be no type errors:
- `toDisplayText` (both routes) and `messageText` (`think-history.ts`) filter blocks by `type`;
- there's no exhaustive `switch` over `ContentBlock`, no custom `ProviderAdapter`, and no `onError`
  hook.

Runtime behaviour on Haiku 4.5 is unchanged, apart from two things:
- stored assistant messages carry `metadata` (step 3);
- a `max_tokens` intake turn with no text now throws instead of being stored.

## 3. Store `stopReason` and usage (`packages/convo-adapter`)

`AquantXStorageAdapter.appendMessage` currently keeps only `metadata.referencedEntityIds`
(`aquantx-storage-adapter.ts:62`), so the engine's `stopReason`/`usage` are dropped. Nothing breaks
if you leave it that way. To keep them, add a `jsonb` column to `chat_messages` (e.g.
`provider_meta`), write `{ stopReason, usage }` there, and read it back into `metadata`. That gives
cost per thread with one query.

If you'd rather not change the schema, meter in a hook instead:

```ts
// apps/web/src/lib/convo/engine.ts
const meter: EngineHooks['afterProviderCall'] = ({ thread, iteration, response }) => {
  console.info('llm-usage', { threadId: thread.id, type: thread.type, iteration, model: defaultModel(), ...response.usage });
};
// in both engines:
hooks: { afterProviderCall: meter },
```

## 4. Think and intake: `thinkingHistory: 'current-turn'`

Both conversations change their system prompt between turns:
- Think rebuilds it from the case record on every turn (`buildThinkSystemPrompt`);
- intake's `clientIntakeSystemPrompt()` embeds today's date, so it changes daily.

On a 5.x model, replaying earlier turns' thinking after such a change is a 400. Set it on both
engines:

```ts
// apps/web/src/lib/convo/engine.ts
new ConversationEngine({
  storage: new AquantXStorageAdapter(),
  provider: makeProvider(),
  defaultSystemPrompt: CLIENT_INTAKE_SYSTEM_PROMPT,      // / SURVEYOR_PRIVATE_AI_SYSTEM_PROMPT
  thinkingHistory: 'current-turn',
  hooks: { afterProviderCall: meter },
});
```

It does nothing on Haiku 4.5, which doesn't think, so it's safe to ship now.

**This replaces the 0.3.0 guide's step 6 design.** Don't move the case record into the user message
with a `beforeSend` hook (see Difference 4). Keep it in the system prompt, split into two blocks,
which is the R5 shape:

```ts
// apps/web/src/lib/think/think-prompt.ts — sketch
export async function buildThinkSystemPrompt(access, mode): Promise<SystemPrompt> {
  return [
    { text: [THINK_ROLE, PLAIN_TEXT_INSTRUCTION, knowledgePack].join('\n\n'), cacheBreakpoint: true },
    { text: await buildAssignmentContext(access) /* + today's date */ },
  ];
}
```

The stable block caches on its own on Haiku 5.5, whose minimum is 512 tokens; Haiku 4.5's minimum
is 4096. The per-turn block can change freely, because `'current-turn'` strips the earlier thinking
that would have been tied to it.

One cost note: the default context strategy also adds a breakpoint on the last history message.
Think makes one call per turn, and the next turn's system prompt differs, so that write is never
read back. If cache-write cost shows up in step 3's numbers, give the Think engine a
`contextStrategy` that sets no message breakpoint. Intake gains from it within a turn, so leave
intake alone.

**Later (not part of 0.4.0):** the append-only pattern would get `'all'`, which keeps the model's
earlier reasoning and caches the history. It would put each turn's context in a mid-conversation
`role: 'system'` message, which Haiku 5.5 and Sonnet 5.5 accept with no beta. That needs engine
support for placing and storing those messages: your §5 "possible later request".

## 5. Structured calls

### `requestToolCall` (`apps/web/src/lib/convo/tool-call.ts`)

- **Check for a refusal first.** In both branches, `if (response.stopReason === 'refusal')`, log
  `response.stopDetails?.category` and return `{ call: undefined, response }`. Bare `send()` doesn't
  throw on a refusal, and a refused response has no tool call.
- **Echo `first.content` verbatim** in the unforced follow-up. Drop the `.filter(...)` and the
  `'(no answer)'` placeholder. The adapter now strips empty text itself. Filtering only removes the
  thinking-block lookalikes that 0.3.0 produced, and the real thinking blocks must be sent back
  unchanged. If `first.content` is empty, the adapter drops that assistant message, which is fine.

### `models.ts`: split the helper

On Haiku 5.5, forced `toolChoice` is accepted but `temperature` is a 400.

```ts
export function canForceToolChoice(model = defaultModel()): boolean {
  return model.startsWith('claude-haiku-4-5') || model.startsWith('claude-haiku-5-5');
}
export function canSetTemperature(model = defaultModel()): boolean {
  return model.startsWith('claude-haiku-4-5');
}
/** effort is a 400 on Haiku 4.5. */
export function acceptsEffort(model = defaultModel()): boolean {
  return !model.startsWith('claude-haiku-4-5');
}
```

### `getStructuredProvider` (`engine.ts`)

- Use `canSetTemperature` for `temperature: 0`.
- Add `effort: 'low'` when `acceptsEffort(resolved)`. Add `effort` to the cache key if callers ever
  vary it. Per call works too: `send({ ..., effort: 'low' })`.
- **Raise `maxTokens` on 5.x.** Thinking counts against it, and the 5.x tokenizer counts about 30%
  more tokens. Evidence review's 2048 and extraction's 4096 are tight. Start at 2× and use step 3's
  numbers to tune.

On Haiku 5.5, a forced call skips thinking, so `effort` matters mostly for the unforced Sonnet 5.5
report check. Callers pass `toolChoice` as today, using `canForceToolChoice` instead of
`canForceToolsAndSetTemperature`.

## 6. Think's UI: thinking indicator, refusals, cut-off replies

In `think/messages/route.ts`, the stream loop:

```ts
for await (const chunk of stream) {
  if (chunk.thinking) { send({ type: 'thinking' }); continue; }
  if (typeof chunk.delta === 'string' && chunk.delta) send({ type: 'delta', text: chunk.delta });
}
```

Add `| { type: 'thinking' }` to `ThinkStreamEvent` (`lib/api/workspace/types.ts`). The client shows
"thinking…" until the next `delta`. You may want to send the event only once per reply, since a
thinking block yields several chunks with `display: 'summarized'`.

In the `catch`, tell the two new errors apart:

```ts
import { IncompleteResponseError, RefusalError } from '@smsoumitra/convo-engine';

const error =
  err instanceof RefusalError ? 'Think can’t help with that request.' :
  err instanceof IncompleteResponseError ? 'Think ran out of room before answering - please try again.' :
  'Think couldn’t reply just now - please try again.';
send({ type: 'error', error });
```

On `error`, the client should **discard any streamed partial text**: a refusal can follow some
text. Nothing was stored for the assistant, so the next `reply` event's history won't contain it.

If `IncompleteResponseError` shows up in practice, raise Think's `maxTokens` in `makeProvider()`
(default 8192), or lower its `effort`. Intake's route already returns 502 on any error. Optionally,
map `RefusalError` to a clearer message there.

## 7. Switch models, one path at a time

1. **Check it live first.** Extend `packages/convo-adapter/src/verify-engine.ts` with the R6
   checks: the original two-turn bug, the changed-system-prompt case under `'current-turn'` (and
   `'all'` as the negative control), streaming usage, and `max_tokens` with a small cap. Use
   `blockBinding: 'error'` so the history check runs on any account. Copy the shape of convo-engine's
   "R6 thinking — live" tests.
2. **Structured calls next.** Set `effort: 'low'`, raise `maxTokens`, and run the report-check and
   extraction evals.
3. **Then Think and intake.** Set `ANTHROPIC_MODEL=claude-haiku-5-5`, or override per engine. Pass
   `effort` in `makeProvider()`: `'medium'` (the default) for Think, `'low'` for intake.
4. **Compare costs.** Use step 3's numbers per thread type across Haiku 4.5, Haiku 5.5 and
   Sonnet 5.5.

Older Think threads switch cleanly. They contain no thinking blocks, and any 0.3.0 empty text blocks
are dropped when sending.

## Done when

- [ ] Both packages are on `^0.4.0`, and typecheck and tests pass (steps 1–2).
- [ ] Usage is recorded per provider call, in `chat_messages` or through `afterProviderCall`
      (step 3).
- [ ] Both engines use `thinkingHistory: 'current-turn'`, and no `beforeSend` hook edits the request
      on iteration 1 only (step 4).
- [ ] `requestToolCall` checks for `refusal` and echoes responses verbatim. `models.ts` has
      separate checks for forcing tools, temperature and effort (step 5).
- [ ] Think shows a thinking indicator, discards partial text on error, and has wording for refusals
      and cut-off replies (step 6).
- [ ] `verify:engine` passes the R6 checks on Haiku 5.5 and Sonnet 5.5 before any path moves
      (step 7).

---

## Testing

- **Unit (run, passing):** 184 tests. The R6 ones are in `tests/thinking.test.ts`
  (`thinkingHistory`, stop reasons, usage, streamed responses) and in the
  `claude-adapter`/`openai-adapter`/`gateway-adapter` tests (mapping, options, `blockBinding`,
  stream final response). They cover every unit item in §4 of the request.
- **Live (run 2026-10-25, all passing):** every live item in §4, on `claude-haiku-5-5` and
  `claude-sonnet-5-5`, with `effort: 'high'` and `blockBinding: 'error'`. 12 tests, run as:

  ```bash
  set -a; source .env; set +a
  INTEGRATION=true npx vitest run tests/claude-adapter.integration.test.ts -t "R6"
  ```

  The results confirm, against the live API:
  - **The original bug is fixed.** The two-turn `agentLoop` works, and the stored thinking blocks
    have non-empty signatures, streamed ones included.
  - **The changed-system-prompt case behaves as designed.** It passes under `'current-turn'`, and
    the `'all'` negative control returns the expected 400 as `InvalidRequestError`.
  - **The opt-in controls work.** The `blockBinding` beta header passes through request options.
  - **Streaming reports real numbers.** Streamed calls report real usage to `afterProviderCall`.
  - **`max_tokens` with a small cap surfaces correctly.**

  **One finding for AquantX:** at `effort: 'high'`, Sonnet 5.5 often doesn't think at all on short
  prompts. Two of two short reasoning prompts came back with no thinking block, while at `'max'`
  both did. The summarized-display test therefore runs at `'max'`. Don't rely on a "thinking…"
  indicator always appearing on Sonnet.
