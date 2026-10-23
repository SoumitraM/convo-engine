# convo-engine response to AquantX's enhancement requests

**Answers:** `docs/aquantx-requests.md` (requested 2026-10-16).
**Status:** R1–R5 and F1's `iteration` are built and unit-tested, and ship in **0.3.0**.
**Step-by-step upgrade for AquantX:** `docs/aquantx-0.3.0-adoption.md`. The live Claude tests are written
but haven't been run against the API yet (see "Testing" at the end).

Most requests were built as proposed. This doc covers **where the engine differs from the proposal,
and what AquantX should change on its side**. Each item says what to do in AquantX.

| Req | Built as proposed? | What AquantX needs to do |
|---|---|---|
| R1 Forced tool choice | Yes for `send()`/`stream()`. **No** for agent loops: a fixed value applies to the first round only | Drop the "please call X now" follow-up turn; check `stopReason` for `max_tokens` |
| R2 Documents | Yes for PDF and text. Spreadsheets: **option (b)** | Convert `.xlsx`/`.xls` to CSV text documents in AquantX |
| R3 Typed errors | Yes | Replace the message regex; set `maxRetries` deliberately |
| R4 Adapter options | Yes | Add `temperature: 0` / `maxRetries` to `getStructuredProvider()` |
| R5 System prompt cache | **Different shape:** system-prompt blocks, not a boolean. The premise is also partly incorrect | Split prompts into a stable block and a variable block |
| F1 Retrieval | `SendContext.iteration` added | Put retrieved passages in the **user message**, not the system prompt |
| F2 List/delete | No engine change needed | Delete rows directly; the engine keeps no state |

---

## R1: Forced tool choice

**Built:** `toolChoice?: 'auto' | 'any' | 'none' | { type: 'tool'; name: string }` on
`send()`/`stream()`, on `sendMessage()`, and on `agentLoop()`/`streamAgentLoop()`. It maps to
Claude's `tool_choice`, OpenAI's `'required'`/`{ type: 'function' }`, and the same OpenAI form on
the gateway. If `toolChoice` forces a tool while `tools` is empty, or names a tool that isn't in
the list, the adapter throws `InvalidRequestError` before sending anything.

### Difference 1: in agent loops, a fixed `toolChoice` applies to the first round only

If `{ type: 'tool', name }` were sent on every round of `agentLoop`, the model could never give its
final text answer. Every round would be another forced tool call, and the loop would end in
`MaxIterationsExceededError`. So:

```ts
// Fixed value: round 1 is forced, later rounds use 'auto'.
await engine.agentLoop(threadId, text, { tools, toolExecutor, toolChoice: 'any' });

// Full control: a function of the 1-based round number. Its result is used as-is.
await engine.agentLoop(threadId, text, {
  tools, toolExecutor,
  toolChoice: (iteration) => (iteration === 1 ? { type: 'tool', name: 'save_job_details' } : undefined),
});
```

The client-intake agent probably shouldn't force anything. It legitimately replies in prose while
it collects fields. Use `toolChoice` for the one-shot structured calls.

### Difference 2: no check for extended thinking

The proposal asked for a clear error when forced tool use is combined with extended thinking. The
Claude adapter doesn't support extended thinking at all yet, so the two can't be combined and
there's nothing to check. The check will be added when thinking support is.

### What AquantX should change

- **Remove the follow-up turn** ("please call X now - don't reply in text") from evidence review,
  the batch check, extraction, report drafting and the report check. Pass
  `toolChoice: { type: 'tool', name: TOOL.name }` instead.
- **Still check `stopReason`.** A forced call guarantees the model *starts* the tool call. If
  `maxTokens` runs out first (`getStructuredProvider(2048)` with 30 photos, say), `stopReason` is
  `'max_tokens'` and the tool input is truncated or incomplete. Treat that as a failure, not as
  "no facts".
- With a forced tool, Claude doesn't write any text before the call. Don't rely on prose alongside
  the tool input.
- **Model support.** Forced tool choice works on AquantX's current model (Haiku 4.5). The newest
  models (Claude Opus 5.5, Sonnet 5.5 and Fable 5.1) reject `'any'` and `{ type: 'tool' }` with a
  400, which arrives as `InvalidRequestError`. Before moving the structured calls to one of those
  models, switch them back to `'auto'` plus an instruction that names the tool. `'none'` works
  everywhere.

---

## R2: Document content blocks

**Built:** a `document` content block, exactly as proposed:

```ts
{
  type: 'document';
  source:
    | { type: 'base64'; media_type: 'application/pdf'; data: string }
    | { type: 'text'; media_type: 'text/plain' | 'text/csv'; data: string };
  title?: string;
  context?: string;
}
```

- **Claude:** sent as native `document` blocks, so it works with `send()`, `sendMessage()` and in
  threads (persisted and replayed).
- **OpenAI:** PDFs become `file` content parts; text documents are inlined as text.
- **Gateway:** text documents are inlined; PDFs throw `InvalidRequestError`.

### Difference 1: spreadsheets use option (b), conversion happens in AquantX

convo-engine provides the `text` source only. It doesn't ship `helpers/spreadsheet`. The usual
`.xlsx` parsers are heavy, and the best-known one is no longer maintained on npm. That's a
dependency AquantX should choose, version and keep patched for itself, not inherit through
convo-engine.

**AquantX to do:** convert each sheet to CSV and send one document per sheet:

```ts
{ type: 'document', source: { type: 'text', media_type: 'text/csv', data: csv },
  title: `${fileName} — sheet "${sheetName}"`,
  context: truncated ? `First ${n} of ${total} rows.` : undefined }
```

If more consumers ask for a helper later, we'll revisit option (a).

### Difference 2: CSV reaches Claude as `text/plain`

Claude's text document source only accepts `text/plain`, so the adapter sends CSV as plain text.
Nothing changes for AquantX. Keep sending `text/csv`, which still matters for the other adapters.

### Difference 3: size limit checked before sending; page limit left to the API

The Claude adapter rejects a request whose base64 payloads (PDFs plus images) add up to more than
32 MB, which is Claude's request limit. It throws `InvalidRequestError` before sending. It doesn't
check the PDF page limit before sending. That would mean parsing the PDF (a dependency), and the
limit varies by model: 600 pages per request, but **100 on 200K-context models such as Haiku 4.5**,
AquantX's current model. The API's 400 for too many pages comes back as `InvalidRequestError` with
the API's message.

Under API version `2026-10-21` (sent by `@anthropic-ai/sdk` 1.0+), a `document` block placed in an
**assistant** message is rejected. Only ever put documents in user content. The engine never moves
them.

**AquantX to do:** check page counts at upload time if you want a friendlier message; you already
parse uploads there.

### Things to plan for

- **Cost of PDFs in threads.** A PDF in a Think thread is re-sent on *every* later turn, at roughly
  1.5–3k input tokens per page. Prompt caching (R5, plus the engine's message cache breakpoint)
  makes those turns much cheaper, but a long PDF still takes up context for the rest of the thread.
  Consider extracting the facts with a one-shot structured call, and putting only the extract in
  the thread.
- **Storage.** `AquantXStorageAdapter` round-trips content with `JSON.stringify`/`JSON.parse`, so
  `document` blocks will survive unchanged. But base64 PDFs will sit in `chat_messages.content`,
  which can mean multi-MB rows. You may prefer to store a file reference and rebuild the block in
  `getMessages`.
- **Bonus:** the OpenAI adapter now sends image blocks as `image_url` parts instead of silently
  dropping them. That covers the item in your Notes section.

---

## R3: Typed, normalised provider errors

**Built as proposed**, exported from the package root: `ProviderError`, `RateLimitError`,
`OverloadedError`, `ContextLengthError`, `AuthenticationError`, `InvalidRequestError`. Each has
`provider`, `status`, `retryable` and `cause` (the original SDK error). There are three small
extensions:

- `OverloadedError` has `retryAfterMs` too, not just `RateLimitError`.
- `retryAfterMs` reads `retry-after-ms` first, then `retry-after` in seconds or as an HTTP date.
- Connection resets, timeouts and other 5xx errors become a plain `ProviderError` with
  `retryable: true`. 408 and 409 are retryable as well.

Errors that arrive mid-stream are mapped too, for example an `overloaded_error` event after a 200
response. Caller aborts and non-API errors pass through unchanged.

`instanceof` works even though each subpath export (`/adapters/claude`, ...) bundles its own copy
of the classes. The engine passes these errors through unchanged and also reports them to
`onError(err, 'provider')`.

### What AquantX should change

```ts
import { ProviderError, RateLimitError, OverloadedError } from '@smsoumitra/convo-engine';

function shouldRetry(err: unknown) {
  return err instanceof ProviderError && err.retryable;
}
function retryDelayMs(err: unknown, attempt: number) {
  if ((err instanceof RateLimitError || err instanceof OverloadedError) && err.retryAfterMs !== undefined) {
    return err.retryAfterMs;
  }
  return 1000 * 2 ** attempt;
}
```

- Delete the `/429|rate.?limit|overload|529|5\d\d|timeout|ECONNRESET/` regex.
- If you check for SDK errors directly (`instanceof Anthropic.APIError`), switch to these classes.
  The SDK error is still available as `err.cause`.
- Context-length errors are detected by matching the provider's message *inside the adapter*. There
  is no status code that identifies them. You no longer need to.

---

## R4: Adapter options

**Built as proposed** on the Claude and OpenAI adapters: `maxRetries`, `timeoutMs` and
`temperature`. Each one is left out entirely when unset, so the SDK defaults stay the same. The
gateway adapter takes `timeoutMs` (covering the whole request, stream included) and `temperature`.
It has no `maxRetries`, because it has never retried.

These are **constructor** options, so they apply per adapter instance.

**`temperature` has a limited life on Claude.** It works on API version `2023-06-01`, which the
`@anthropic-ai/sdk` 0.x releases send. From API version `2026-10-21`, the default in
`@anthropic-ai/sdk` 1.0+, any `temperature` (even `1`) returns a 400 on every model, and there's no
replacement setting. Use it only while AquantX stays on the 0.x SDK. When you upgrade the SDK,
remove it, or the structured calls will fail.

### What AquantX should change

- `getStructuredProvider()` should pass `temperature: 0`. Keep a separate adapter instance for
  Think, which should keep the default temperature.
- Choose one retry layer. Either keep `withRetry` and set **`maxRetries: 0`**, or drop `withRetry`
  and let the SDK retry with a tuned `maxRetries`. Today the SDK's 2 retries multiply with yours.
  With R3, `withRetry` can honour `retryAfterMs`, which the SDK already does internally, so either
  works.

---

## R5: Caching the system prompt

### Correction to the premise

The adapter can cache the system prompt as part of a thread's history. The engine's default
context strategy puts a cache breakpoint on the last history message. Claude caches everything
before a breakpoint, in the order tools → system → messages, so the system prompt is part of the
cached prefix. It goes uncached in three cases:

1. **The first turn of a thread.** There's no history yet, so there's no breakpoint.
2. **Bare `send()` calls.** None of the structured calls set a breakpoint.
3. **The system prompt changing between turns.** Any change, even at the end, invalidates the
   cached system prompt *and the whole history after it*.

**For Think, case 3 is the normal case.** `buildThinkSystemPrompt` ends with today's date and the
live case record, which the extraction pass updates after the surveyor's messages. Whenever the
case record changes, the next turn caches nothing.

### The minimum size rules out caching on Haiku 4.5

Claude doesn't cache a prefix shorter than the model's minimum, and it gives no error. On Haiku 4.5,
AquantX's current model, the minimum is **4096 tokens**. Rough sizes of AquantX's prompts today:

| Prompt | ≈ tokens | Caches on Haiku 4.5? |
|---|---|---|
| `EXTRACTION_SYSTEM`, `CHECK_SYSTEM`, `REVIEW_SYSTEM` (+ tool schema) | 400–600 (+ a few hundred) | No |
| `THINK_ROLE` + `CARGO_DAMAGE_KNOWLEDGE` | ~3,100 | No |
| Think system prompt + a few turns of history | grows past 4,096 | Yes, if the system prompt stays the same |

So **R5's system-block option saves AquantX nothing on Haiku 4.5 today.** It starts paying off
when the stable prefix grows past 4096 tokens, or on a model with a lower minimum (Claude Haiku 5.5:
512 tokens). The change that saves money for Think now is to **keep the system prompt identical
across a thread's turns**, so the history cache keeps working. See the adoption guide, step 6.

### Difference: system-prompt blocks instead of `cacheSystemPrompt: boolean`

A boolean can't express "cache the prefix, not the suffix", and that split matters most here. So
`systemPrompt` (on `send`/`stream`, engine options and `defaultSystemPrompt`) now accepts blocks:

```ts
systemPrompt: [
  { text: ROLE + GUARDRAILS + knowledgePack(surveyType), cacheBreakpoint: true }, // cached
  { text: perAssignmentContext },                                                  // not cached
]
```

A plain string works exactly as before and isn't cached by itself. The OpenAI and gateway adapters
join the blocks with a blank line.

### What AquantX should change

- **Think (now):** keep the system prompt identical for every turn of a thread. Move the date and
  the live case record out of it and into the request's user message (adoption guide, step 6).
  After that, the engine's message breakpoint caches system prompt + history, and that passes 4096
  tokens after a few turns.
- **Structured calls (later):** once a stable instruction block is over the model's minimum (or on
  a model with a lower one), send it with `cacheBreakpoint: true`. These calls repeat across photos
  and batches, so they will save the most at that point.
- **Intake:** `clientIntakeSystemPrompt()` appends today's date, so the prompt changes every day.
  Put the date in a second block. That only matters once the intake prompt passes the minimum.
- **Minimum size:** a cache prefix below the model's minimum cacheable length (up to about 4K
  tokens on some models) is silently not cached. `usage.cacheReadTokens` stays 0.
- **Limit:** Claude allows at most 4 cache breakpoints per request, counting system blocks plus the
  engine's message breakpoint. The adapter rejects more with `InvalidRequestError`, so use at most
  2 system breakpoints.

### Type change for hooks

`SendContext.systemPrompt` is now `string | SystemPromptBlock[]`. A `beforeSend` hook that treats it
as a string, for example by appending to it, needs to handle the array form.

---

## F1: Knowledge-base retrieval

**Built:** `SendContext.iteration` (1-based; always 1 for `sendMessage`/`streamMessage`, counting
up across agent-loop rounds). `SendContext.toolChoice` was also added, so a hook can see the tool
choice for the current call and change it.

### Difference: put retrieved passages in the user message, not the system prompt

F1 suggests having the hook write retrieved passages into R5's variable system-prompt suffix. That
loses most of the cache. Any change in the system prompt, suffix included, invalidates the cached
history that comes after it, so a suffix that changes every turn means no history cache hits at
all.

Instead, add the passages to the **new user message**. It comes after the cache breakpoint, so
tools, system prompt and history all stay cached. What the hook changes affects only the request,
not storage, so passages aren't saved into the thread.

```ts
beforeSend: async (ctx) => {
  if (ctx.iteration !== 1) return ctx;           // retrieve once per turn
  const passages = await retrieve(textOf(ctx.newMessage));
  const content = typeof ctx.newMessage.content === 'string'
    ? [{ type: 'text' as const, text: ctx.newMessage.content }]
    : ctx.newMessage.content;
  return {
    ...ctx,
    newMessage: {
      ...ctx.newMessage,
      content: [{ type: 'text', text: `<retrieved>\n${passages}\n</retrieved>` }, ...content],
    },
  };
},
```

**Agent-loop caveat:** in rounds after the first, `ctx.newMessage` is the latest `tool_result`
message, and the user's message has moved into `ctx.history`, *without* the passages. If retrieval
is used with `agentLoop`, save the passages and the user message's id on round 1. On later rounds,
add the same passages to that message in `ctx.history`; identical content keeps the cache prefix
stable. Think uses `streamMessage`, so the simple form above is enough there.

---

## F2: Listing and deleting conversations

No engine change is needed. To answer your question: the engine keeps **no state of its own**. Its
only fields are the storage, provider, hooks, context strategy and default system prompt. There are
no caches or summaries, so deleting the `chat_threads`/`chat_messages` rows directly is complete
and safe. If the engine ever adds state of its own, it will expose `deleteThread` and this doc will
say so.

---

## Upgrading from 0.1.0

The full step-by-step is in `docs/aquantx-0.3.0-adoption.md`. In short: AquantX is on 0.1.0, so the upgrade also picks up 0.2.0 (`streamAgentLoop`; Claude's `stream()`
now yields `tool_use` blocks). Changes that can affect AquantX's code:

1. `ContentBlock` has a new `document` member. An exhaustive `switch` over block types gets a type
   error. A `.filter(b => b.type === 'text')`, as in `think-history.ts`, is fine.
2. `SendContext.systemPrompt` widens to `string | SystemPromptBlock[]`, and `SendContext.iteration`
   is a new required field. That only matters if you build a `SendContext` yourself, for example in
   tests.
3. Adapters now throw `ProviderError` subclasses instead of raw SDK errors (the original is
   `err.cause`). Error messages are unchanged.
4. `ProviderAdapter.send`/`stream` take `ProviderInput`. This only matters for a custom provider
   adapter, and AquantX has none.

## Testing

- Unit tests cover each adapter's request translation (tool choice, documents, system blocks,
  options), error mapping from mocked SDK and HTTP failures (including mid-stream errors), the size
  and breakpoint checks before sending, and the engine's pass-through and agent-loop behaviour
  (including document blocks persisted and replayed in a thread). The build was also checked so
  that `instanceof` works across the separately bundled ESM and CJS entry points.
- Live Claude tests are in `tests/claude-adapter.integration.test.ts`. They cover a forced tool
  being called 3 times out of 3, a PDF and a CSV read via `send()`, a PDF replayed in a thread, and
  a cache read on the second identical call. Run them with
  `INTEGRATION=true ANTHROPIC_API_KEY=… npx vitest run tests/claude-adapter.integration.test.ts`.
