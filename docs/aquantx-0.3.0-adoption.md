# Adopting convo-engine 0.3.0 in AquantX

**Audience:** whoever does the upgrade in the AquantX repo.
**Background:** `docs/aquantx-requests.md` (what AquantX asked for) and `docs/aquantx-response.md`
(what was built, and where it differs). This guide is the step-by-step version, tied to AquantX's
current files (read on 2026-10-22). Paths are relative to the AquantX repo root.

The steps are ordered so each one can ship on its own. Steps 1–2 are the upgrade itself, steps 3–5
fix the structured calls (R1, R3, R4), step 6 is Think's caching (R5), and step 7 is documents (R2).
Code below is a sketch against today's AquantX code. Adjust names to taste.

---

## 1. Upgrade the dependency

`^0.1.0` won't pick up 0.3.0, because a caret range on a 0.x version only allows patch updates. In
both `apps/web/package.json` and `packages/convo-adapter/package.json`:

```json
"@smsoumitra/convo-engine": "^0.3.0"
```

**Keep `@anthropic-ai/sdk` on its current 0.x release** for now. Step 3 uses `temperature`, which
the API rejects from version `2026-10-21` onwards, the default in SDK 1.0+ (see step 9).

## 2. Typecheck and run the tests

```bash
npm install && npm run typecheck && npm test
```

Expected result: no type errors. I checked AquantX for the three breaking changes. There's no
exhaustive `switch` over `ContentBlock` (`think-history.ts` uses `.filter`, which is fine), no
`beforeSend` hook or `SendContext` yet, and no custom `ProviderAdapter`. Runtime behaviour is
unchanged until you start passing the new options.

One behaviour change to note: adapter errors are now `ProviderError` subclasses rather than raw SDK
errors. The messages are the same, so today's regex in `withRetry` keeps working until step 5
replaces it.

## 3. Structured provider: `temperature: 0` and explicit retries (R4)

`apps/web/src/lib/convo/engine.ts`. Today's adapters are cached by `maxTokens` only. Key them by the
options too:

```ts
const _structuredProviders = new Map<string, ClaudeProviderAdapter>();

export function getStructuredProvider(
  maxTokens = 4096,
  { maxRetries }: { maxRetries?: number } = {},
): ClaudeProviderAdapter {
  const key = `${maxTokens}:${maxRetries ?? 'sdk'}`;
  let provider = _structuredProviders.get(key);
  if (!provider) {
    provider = new ClaudeProviderAdapter({
      apiKey: getApiKey(),
      model: process.env.ANTHROPIC_MODEL ?? 'claude-haiku-4-5-20251001',
      maxTokens,
      temperature: 0,   // remove before moving to @anthropic-ai/sdk 1.x (step 9)
      maxRetries,       // undefined keeps the SDK's default of 2
    });
    _structuredProviders.set(key, provider);
  }
  return provider;
}
```

Leave `makeProvider()` (Think, intake) alone, so conversations keep the default temperature.

## 4. Forced tool calls instead of the follow-up turn (R1)

### `apps/web/src/lib/convo/tool-call.ts`

Replace the "please call X now" second turn with a forced tool choice. A missing call can then only
mean that the output was truncated, so report that:

```ts
import type { ContentBlock, ToolChoice, ToolDefinition } from '@smsoumitra/convo-engine';

export async function requestToolCall(params: {
  tool: ToolDefinition;
  messages: StructuredRequest['messages'];
  send: (request: { messages: StructuredRequest['messages']; toolChoice: ToolChoice }) => Promise<StructuredResponse>;
}): Promise<{ call: ToolUseBlock | undefined; response: StructuredResponse }> {
  const { tool, messages, send } = params;
  const response = await send({ messages, toolChoice: { type: 'tool', name: tool.name } });
  const call = findToolCall(response, tool.name);
  if (!call || response.stopReason === 'max_tokens') {
    // With a forced tool this means the output ran out mid-call; the input may be incomplete.
    console.error(`${tool.name}: no complete tool call`, { stopReason: response.stopReason });
    return { call: undefined, response };
  }
  return { call, response };
}
```

Update the doc comment too: it says convo-engine can't force a tool choice yet.

### The three callers pass `toolChoice` through

```ts
// case-record/extraction.ts
send: ({ messages, toolChoice }) =>
  getStructuredProvider().send({ systemPrompt: EXTRACTION_SYSTEM, tools: [RECORD_TOOL], messages, toolChoice }),

// think/report-check.ts
send: ({ messages, toolChoice }) =>
  getStructuredProvider(4096).send({ systemPrompt: CHECK_SYSTEM, tools: [CHECK_TOOL], messages, toolChoice }),

// think/evidence-review.ts (sendForTool) — see step 5 for withRetry / maxRetries
send: ({ messages, toolChoice }) =>
  withRetry(() => getStructuredProvider(2048, { maxRetries: 0 }).send({ systemPrompt, tools: [tool], messages, toolChoice })),
```

### `apps/web/src/lib/think/report-drafting.ts`

`attemptDraft` calls `send()` directly. Add
`toolChoice: { type: 'tool', name: WRITE_REPORT_TOOL.name }`. After that, the `for (attempt < 2)`
loop in its caller only re-runs on truncation. Either drop it or keep one retry for
`stopReason === 'max_tokens'` with a bigger `maxTokens`. The "Respond only with the write_report
tool call" sentence in the prompt is now redundant but harmless.

**Don't force tools on the intake agent** (`conversation/messages/route.ts` → `agentLoop`). It
correctly replies in prose while it collects fields.

## 5. Typed retries in evidence review (R3)

`apps/web/src/lib/think/evidence-review.ts`. Replace the regex with the error classes and honour
`retry-after`:

```ts
import { ProviderError, RateLimitError, OverloadedError } from '@smsoumitra/convo-engine';

async function withRetry<T>(task: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await task();
    } catch (error) {
      lastError = error;
      if (!(error instanceof ProviderError) || !error.retryable || attempt === MAX_ATTEMPTS) break;
      const hinted = (error instanceof RateLimitError || error instanceof OverloadedError) ? error.retryAfterMs : undefined;
      await new Promise((resolve) => setTimeout(resolve, hinted ?? 1500 * attempt * attempt));
    }
  }
  throw lastError;
}
```

This path uses `getStructuredProvider(2048, { maxRetries: 0 })` (step 4), so `withRetry` is the
only retry layer. Before, the SDK's 2 retries ran inside each of your 3 attempts, up to 9 calls. The
other structured callers have no `withRetry` and keep the SDK's default retries.

## 6. Make Think's turns cacheable (R5)

**Why this and not system-prompt blocks:** AquantX runs on Haiku 4.5, whose minimum cacheable
prefix is 4096 tokens. Think's stable part (`THINK_ROLE` + `CARGO_DAMAGE_KNOWLEDGE`) is about 3,100
tokens, so caching it as a system block on its own does nothing. The engine's message breakpoint
*would* cache system prompt + history, which passes 4096 after a few turns. But
`buildThinkSystemPrompt` ends with the date and the live case record, so the system prompt changes
whenever extraction records a fact, and every such turn starts the cache from scratch.

**Fix:** keep the system prompt the same for every turn, and send the per-turn assignment context
with the user's message, without storing it.

### `apps/web/src/lib/think/think-prompt.ts`: split stable from per-turn

```ts
/** Identical on every turn of a Think conversation — safe to cache. */
export function thinkConversationSystemPrompt(): string {
  return [THINK_ROLE, PLAIN_TEXT_INSTRUCTION, CARGO_DAMAGE_KNOWLEDGE].join('\n\n');
}

/** Changes as the case record does — sent with the user's turn, never stored. */
export async function thinkTurnContext(access: WorkspaceAccess): Promise<string> {
  const context = await buildAssignmentContext(access);
  return `--- THIS ASSIGNMENT (today is ${new Date().toISOString().slice(0, 10)}) ---\n${context}`;
}
```

Keep `buildThinkSystemPrompt(access, 'generate')` as it is for report drafting. That's a one-shot
call, so there's nothing to keep stable.

### `apps/web/src/lib/convo/engine.ts`: a `beforeSend` hook on the Think engine

The route hands the context over through a small map keyed by thread id. The hook puts the context
in front of the user's message, but only in the request. Storage keeps the plain message, so later
turns' history stays byte-identical.

```ts
import type { SendContext } from '@smsoumitra/convo-engine';

/** Per-turn assignment context, handed from the Think route to the hook below. */
export const pendingThinkContext = new Map<string, string>();

function withTurnContext(ctx: SendContext): SendContext {
  const context = pendingThinkContext.get(ctx.thread.id);
  if (ctx.iteration !== 1 || context === undefined) return ctx;
  pendingThinkContext.delete(ctx.thread.id);
  const content = typeof ctx.newMessage.content === 'string'
    ? [{ type: 'text' as const, text: ctx.newMessage.content }]
    : ctx.newMessage.content;
  return {
    ...ctx,
    newMessage: { ...ctx.newMessage, content: [{ type: 'text', text: context }, ...content] },
  };
}

// in getSurveyorPrivateAiEngine():
_surveyorPrivateAiEngine = new ConversationEngine({
  storage: new AquantXStorageAdapter(),
  provider: makeProvider(),
  defaultSystemPrompt: SURVEYOR_PRIVATE_AI_SYSTEM_PROMPT,
  hooks: { beforeSend: withTurnContext },
});
```

### `apps/web/src/app/api/assignments/[jobId]/workspace/think/messages/route.ts`

```ts
const systemPrompt = thinkConversationSystemPrompt();
pendingThinkContext.set(threadId, await thinkTurnContext(access));
const { stream, completion } = engine.streamMessage(threadId, message, { systemPrompt });
```

Clear the entry in the route's error path if `streamMessage` fails before the hook runs.

### Check it worked

On the third or later turn of a Think thread, log `usage.cacheReadTokens`. For a `streamMessage`
call, a quick way is a one-off `send()` with the same inputs; the engine's stream doesn't surface
usage. It should be in the thousands. If it's 0, the system prompt or history is still changing
between turns.

Also check Think's answers once: the model now reads the assignment context at the start of the
newest turn instead of in the system prompt. That usually helps, since the context sits right next
to the question, but it's a prompt change.

**Not needed yet:** system-prompt blocks with `cacheBreakpoint`. Use them for the structured calls
once a stable block passes the model's minimum (4096 on Haiku 4.5, 512 on Claude Haiku 5.5), and
for the intake prompt's date (`clientIntakeSystemPrompt`) at the same point.

## 7. Documents as evidence (R2, decision D9)

What the engine provides:
`{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } | { type: 'text', media_type: 'text/csv' | 'text/plain', data }, title?, context? }`.
It works in bare `send()` and in threads. AquantX needs to:

1. **Accept the files.** Extend `ACCEPTED_FILE_TYPES` in
   `apps/web/src/components/workspace/evidence/evidence-labels.ts` (and the second
   `accept="image/*"` input in `EvidencePanel.tsx`) with `application/pdf`, `.pdf`, `text/csv`,
   `.csv`, `.xlsx` and `.xls`, plus the server-side MIME mapping next to it.
2. **Check limits at upload.** Claude reads at most **100 PDF pages per request on Haiku 4.5**
   (600 on larger-context models), and a request is capped at 32 MB including base64. The adapter
   rejects an oversized request before sending, with `InvalidRequestError`. Checking page counts at
   upload gives the surveyor a better message.
3. **Convert spreadsheets in AquantX** (option b). Make one `text/csv` document per sheet, titled
   `"<file> — sheet <name>"`. If a sheet is cut short, say so in `context`, e.g.
   `"First 500 of 2,340 rows."`. Pick and pin the `.xlsx` parser yourselves.
4. **Review flow.** In `evidence-review.ts`, the per-item review builds
   `[{ type: 'image', ... }, { type: 'text', text: context }]`. For a PDF or sheet, build the
   `document` block in the same position. A `title` such as "Bill of lading B/L 123" helps the model
   cite it.
5. **Threads (Think).** If a document goes into a Think thread, it's stored by
   `AquantXStorageAdapter` as JSON in `chat_messages.content` (multi-MB rows) and re-sent on every
   later turn. Prefer extracting facts with a one-shot structured call and putting only the extract
   in the thread.
6. **Placement.** Documents go in **user** messages only. From API version `2026-10-21`, a document
   in an assistant message is a 400.

## 8. Optional: friendlier errors in the routes

The Think and intake routes catch everything into one generic message. With R3 they can tell "busy,
try again in a moment" (`RateLimitError` / `OverloadedError`, using `retryAfterMs`) apart from real
failures (`InvalidRequestError`, `AuthenticationError`).

## 9. Later: moving to `@anthropic-ai/sdk` 1.x or a newer model

- **SDK 1.x sends API version `2026-10-21`**, where any `temperature` returns a 400. Remove
  `temperature: 0` from `getStructuredProvider()` in the same change. There's no replacement
  setting, so check that extraction output is still consistent enough at the default.
- **Claude Opus 5.5, Sonnet 5.5 and Fable 5.1 reject forced tool choice** (`'any'` /
  `{ type: 'tool' }`). Before moving the structured calls to one of them, switch `requestToolCall`
  back to `'auto'` and name the tool in the prompt. The step 4 `stopReason`/missing-call check then
  matters again.
- A newer model with a lower caching minimum (Claude Haiku 5.5: 512 tokens) makes the step 6
  "Not needed yet" items worth doing.

## Done when

- [ ] Both packages are on `^0.3.0`, and typecheck and tests pass (steps 1–2).
- [ ] No "please call X now" turn remains. Evidence review, extraction, the report check and
      drafting send a forced `toolChoice`, and a truncated call is logged as a failure (step 4).
- [ ] `withRetry` has no regex, and evidence review runs with `maxRetries: 0` (step 5).
- [ ] Think's system prompt is identical across turns, and `cacheReadTokens > 0` by turn 3 (step 6).
- [ ] A PDF and an `.xlsx` (as CSV sheets) can be uploaded as evidence and reviewed (step 7), if D9
      is in scope for this release.
