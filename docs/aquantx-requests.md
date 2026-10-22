# Enhancement requests from AquantX

**Status:** open - requested 2026-10-16. Nothing here is built yet.
**Requested by:** AquantX (`apps/web`, consumes `@smsoumitra/convo-engine`; currently pinned to
**0.1.0** - it will move to the release that carries these).
**Where AquantX tracks its side:** `docs/sme-cargo-damage-plan.md` → "When convo-engine ships the
requested enhancements", and `docs/features/evidence-upload.md` in the AquantX repo.

AquantX uses convo-engine for every model call: the Think conversation (`streamMessage`), the
client-intake agent (`agentLoop`), and several one-shot **structured calls** made with a bare
`ClaudeProviderAdapter.send()` that must end in one specific tool call - case-fact extraction,
evidence (photo) review, the cross-photo batch check, report drafting and the pre-issue report
check. The gaps below all surfaced while building those. Each section says why, what we'd like
(a proposal - adjust to fit the engine's design), and how we'd know it's done.

Priority: **P1** blocks or degrades a shipped AquantX feature today; **P2** removes a workaround.

---

## R1 - Forced tool choice (P1)

**Why.** `send()`/`stream()`/`agentLoop()` can't say "you must call this tool". The Claude
adapter sends no `tool_choice`; the OpenAI and gateway adapters hard-code `'auto'`. So now and
then the model answers in prose instead: in real testing, **1 photo review in 8**. For AquantX a
missing call is worse than an error - it silently means "no facts recorded" or "the report check
found nothing". AquantX works around it with a follow-up turn ("please call X now - don't reply in
text"), which costs a second call and still can fail.

**Proposal.** An optional `toolChoice` on the provider input (and passed through by
`agentLoop`/`streamAgentLoop`):

```ts
type ToolChoice =
  | 'auto'                          // today's behaviour, default
  | 'any'                           // must call some tool
  | 'none'                          // tools visible, none may be called
  | { type: 'tool'; name: string }; // must call exactly this tool

send(input: { systemPrompt?: string; messages: ProviderMessage[]; tools?: ToolDefinition[]; toolChoice?: ToolChoice })
```

Adapter mapping:
- Claude: `tool_choice: { type: 'auto' | 'any' | 'none' }` / `{ type: 'tool', name }`. Note
  Anthropic's rule that forced tool use isn't compatible with extended thinking - surface a clear
  error rather than sending an invalid request.
- OpenAI: `'auto' | 'required' | 'none'` / `{ type: 'function', function: { name } }`.
- Gateway: forward when the gateway supports it; otherwise throw a clear
  "toolChoice not supported by this provider" error (same pattern as images today).

**Done when.** With `toolChoice: { type: 'tool', name }`, the response always contains that
`tool_use` block (unit tests per adapter on the request body; one live Claude test behind
`describe.skipIf(!ANTHROPIC_API_KEY)`).

---

## R2 - Document content blocks: PDF and spreadsheets (P1)

**Why.** AquantX evidence is mostly documents: bills of lading, invoices, packing lists, delivery
receipts, insurance policies, claim bills - as PDFs, and tallies/claim schedules as Excel. Today
`ContentBlock` has `text | tool_use | tool_result | image` only, so AquantX accepts **images only**
and asks people to photograph documents (agreed decision D9 in AquantX's evidence spec: "PDF and
Excel after convo-engine supports them").

**Proposal.** A `document` block alongside `image`:

```ts
| {
    type: 'document';
    source:
      | { type: 'base64'; media_type: 'application/pdf'; data: string }
      | { type: 'text'; media_type: 'text/plain' | 'text/csv'; data: string };
    title?: string;    // e.g. "Bill of lading B/L 123" - helps the model cite it
    context?: string;  // optional note shown with the document
  }
```

Adapter mapping:
- Claude: native `document` blocks (base64 PDF; plain-text source). Respect the API's limits
  (PDF size/page caps) and fail with a clear error before sending, not a 400 from the API.
- OpenAI: the provider's file/PDF input where available; otherwise a clear "not supported" error.
- Gateway: clear "not supported" error unless the gateway handles documents.
- Storage adapters must round-trip the block (it's persisted like `image` when sent in a thread).

**Spreadsheets** (`.xlsx`, `.xls`, `.csv`): Claude has no native spreadsheet input. Either:
- (a) convo-engine ships an optional helper on its own subpath - e.g.
  `@smsoumitra/convo-engine/helpers/spreadsheet` → `spreadsheetToDocuments(buffer): ContentBlock[]`
  (one `text/csv` document block per sheet, with the sheet name as `title`, large sheets
  truncated with a stated row count) - keeping its parser dependency out of the core entry points
  (the zero-npm-imports rule for `engine.ts`/`types.ts` stays intact); or
- (b) convo-engine only provides the `text` document source and AquantX converts.

We'd prefer (a) so other consumers get it too - but (b) unblocks AquantX just as well; your call.

**Done when.** A PDF and a CSV can be sent to Claude via `send()` and within a thread
(`sendMessage`, persisted and replayed), with unit tests for each adapter's translation and the
limit checks.

---

## R3 - Typed, normalised provider errors (P2)

**Why.** A 30-photo batch hits rate limits and overload. AquantX decides whether to retry by
**regex on the error message** (`/429|rate.?limit|overload|529|5\d\d|timeout|ECONNRESET/`), which is
fragile across SDK versions and providers, and it can't honour `retry-after`.

**Proposal.** Errors thrown by adapters normalised to a small set, exported from the package root:

```ts
class ProviderError extends Error { provider: 'claude' | 'openai' | 'gateway'; status?: number; cause?: unknown; retryable: boolean }
class RateLimitError extends ProviderError { retryAfterMs?: number }   // 429
class OverloadedError extends ProviderError {}                           // 529 / 503
class ContextLengthError extends ProviderError {}                        // prompt too long
class AuthenticationError extends ProviderError {}                       // 401/403
class InvalidRequestError extends ProviderError {}                       // other 4xx
```

**Done when.** Each adapter maps its SDK/HTTP errors to these (unit tests with mocked
responses), and `retryAfterMs` is filled from the `retry-after` header when present.

---

## R4 - Adapter options: retries, timeout, temperature (P2)

**Why.** `ClaudeProviderAdapter` takes `apiKey`, `model`, `maxTokens` only. The Anthropic SDK
underneath retries twice by default; AquantX adds its own retries on top, so attempts multiply
and nobody can tune them. Structured extraction also wants `temperature: 0`.

**Proposal.** Pass-through options on every adapter where the provider supports them:
`maxRetries`, `timeoutMs`, `temperature`.

**Done when.** The options reach the SDK client / request (unit-tested), and defaults are
unchanged when omitted.

---

## R5 - Cache the system prompt (P2, cost)

**Why.** Think's system prompt is large and mostly stable (role, guardrails, the survey type's
knowledge pack) and is sent on every turn. The Claude adapter sends it as a plain system block -
only messages get `cache_control` via `cacheBreakpoint` - so it's never cached.

**Proposal.** An option to mark the system prompt cacheable, e.g. `cacheSystemPrompt?: boolean`
on `send`/`stream`/engine options, or accept `systemPrompt` as blocks with a `cacheBreakpoint`.
Bonus: allow a stable prefix + a variable suffix (AquantX appends per-assignment context after the
knowledge pack, so only the prefix is cacheable).

**Done when.** The Claude request carries `cache_control` on the system block when asked, and
`usage.cacheReadTokens` shows hits on a second identical call (live test, skipped without a key).

---

## Future needs (not requested yet)

AquantX hasn't designed these features yet. They're listed so the engine's design leaves room for
them. Nothing is needed until AquantX turns one into a numbered request.

### F1 - Knowledge-base retrieval (AquantX C1)

**What's coming.** Think's maritime knowledge is a fixed per-survey-type pack in the system prompt
today. Once the content outgrows the prompt or spans several survey types, AquantX will look up the
relevant passages per question (pgvector in AquantX's own Postgres) and add them to the call.

**Probably no engine change.** `beforeSend` can already change `systemPrompt` or add context, so
the lookup can live entirely in AquantX. Points to keep in mind:
- `beforeSend` runs on **every** `agentLoop`/`streamAgentLoop` iteration. A lookup there would
  repeat on each tool round-trip. AquantX can cache per turn on its side, but a way to tell the
  first iteration from later ones (e.g. an `iteration` field on `SendContext`) would make that
  easy.
- Retrieved passages change every turn, so they must not break R5's cacheable prefix. If R5 adds a
  fixed prefix and a variable suffix, the hook needs to be able to write to the suffix only.

### F2 - Listing and deleting conversations

**What's coming.** If a later phase adds "past conversations" or "delete conversation", AquantX
will need to list a user's threads and delete them. `StorageAdapter` already has optional
`listThreads`/`updateThread`/`deleteThread`, but `ConversationEngine` exposes none of them, and
`AquantXStorageAdapter` doesn't implement them.

**Probably no engine change.** AquantX owns `chat_threads`/`chat_messages` and can query them
directly. Engine-level `listThreads`/`deleteThread` would only matter if the engine kept state of
its own (caches, summaries) that a delete has to clear. If it ever does, please say so.

### Not for convo-engine

- **Spreadsheet review** (AquantX C2: the surveyor uploads a finished Excel calculation for Think to
  check) is covered by R2. Nothing more needed.
- **Voice-note transcription** will use a speech-to-text service, not a chat model. It stays
  outside the engine unless the engine grows audio input.

---

## Notes

- AquantX is on 0.1.0 and hasn't adopted 0.2.0's `streamAgentLoop` yet - no request there.
- Image blocks: the OpenAI adapter currently skips them and the gateway throws. Not blocking for
  AquantX (it only uses Claude), but worth a clear error in the OpenAI adapter rather than silently
  dropping the image.
