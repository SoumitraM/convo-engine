/**
 * ClaudeProviderAdapter unit tests
 * Uses vi.mock to avoid loading the real @anthropic-ai/sdk at test time.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock @anthropic-ai/sdk before importing the adapter
// ---------------------------------------------------------------------------

const mockCreate = vi.fn();
const mockStream = vi.fn();

vi.mock('@anthropic-ai/sdk', () => {
  return {
    default: vi.fn().mockImplementation(() => ({
      messages: {
        create: mockCreate,
        stream:  mockStream,
      },
    })),
  };
});

import Anthropic from '@anthropic-ai/sdk';
import { ClaudeProviderAdapter } from '../src/adapters/provider/claude.js';
import {
  ProviderError,
  RateLimitError,
  OverloadedError,
  ContextLengthError,
  AuthenticationError,
  InvalidRequestError,
} from '../src/errors.js';
import {
  APIError,
  APIConnectionTimeoutError,
  APIUserAbortError,
  BadRequestError,
  RateLimitError as SdkRateLimitError,
} from './helpers/fake-sdk-errors.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAnthropicTextResponse(text: string) {
  return {
    content:    [{ type: 'text', text }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 20, output_tokens: 10 },
  };
}

function makeAnthropicToolUseResponse(id: string, name: string, input: Record<string, unknown>) {
  return {
    content:    [{ type: 'tool_use', id, name, input }],
    stop_reason: 'tool_use',
    usage: { input_tokens: 20, output_tokens: 10 },
  };
}

/**
 * The real SDK's client.messages.stream() returns a MessageStream: async
 * iterable over raw events, plus a finalMessage() the adapter calls after
 * the loop to recover tool_use blocks (see claude.ts stream()).
 */
function makeFakeMessageStream(
  events: unknown[],
  finalMessage: { content: unknown[]; [key: string]: unknown },
) {
  return {
    [Symbol.asyncIterator]: () => (async function* () { yield* events; })(),
    finalMessage: vi.fn().mockResolvedValue({
      stop_reason: 'end_turn',
      usage: { input_tokens: 20, output_tokens: 10 },
      ...finalMessage,
    }),
  };
}

// ---------------------------------------------------------------------------
// send()
// ---------------------------------------------------------------------------

describe('ClaudeProviderAdapter.send', () => {
  beforeEach(() => {
    mockCreate.mockReset();
    mockStream.mockReset();
  });

  it('returns a text ProviderResponse on a text reply', async () => {
    mockCreate.mockResolvedValue(makeAnthropicTextResponse('Hello from Claude'));
    const adapter = new ClaudeProviderAdapter({ apiKey: 'test-key' });

    const result = await adapter.send({
      messages: [{ role: 'user', content: 'Hi' }],
    });

    expect(result.content[0].type).toBe('text');
    if (result.content[0].type === 'text') {
      expect(result.content[0].text).toBe('Hello from Claude');
    }
    expect(result.stopReason).toBe('end_turn');
    expect(result.usage.inputTokens).toBe(20);
    expect(result.usage.outputTokens).toBe(10);
  });

  it('returns a tool_use ProviderResponse on a tool call reply', async () => {
    mockCreate.mockResolvedValue(
      makeAnthropicToolUseResponse('call_1', 'get_weather', { city: 'London' }),
    );
    const adapter = new ClaudeProviderAdapter({ apiKey: 'test-key' });

    const result = await adapter.send({
      messages: [{ role: 'user', content: 'Weather?' }],
    });

    expect(result.content[0].type).toBe('tool_use');
    if (result.content[0].type === 'tool_use') {
      expect(result.content[0].name).toBe('get_weather');
      expect(result.content[0].input).toEqual({ city: 'London' });
    }
    expect(result.stopReason).toBe('tool_use');
  });

  it('prepends system prompt as system blocks in the request', async () => {
    mockCreate.mockResolvedValue(makeAnthropicTextResponse('ok'));
    const adapter = new ClaudeProviderAdapter({ apiKey: 'test-key' });

    await adapter.send({
      systemPrompt: 'You are helpful.',
      messages: [{ role: 'user', content: 'Hi' }],
    });

    const call = mockCreate.mock.calls[0][0];
    expect(call.system).toBeDefined();
    expect(call.system[0].text).toBe('You are helpful.');
  });

  it('applies cache_control to the last block when cacheBreakpoint is set', async () => {
    mockCreate.mockResolvedValue(makeAnthropicTextResponse('ok'));
    const adapter = new ClaudeProviderAdapter({ apiKey: 'test-key' });

    await adapter.send({
      messages: [
        { role: 'user', content: 'Msg 1', cacheBreakpoint: true },
        { role: 'user', content: 'Msg 2' },
      ],
    });

    const call = mockCreate.mock.calls[0][0];
    const firstMsg = call.messages[0];
    const lastBlock = firstMsg.content[firstMsg.content.length - 1];
    expect(lastBlock.cache_control).toEqual({ type: 'ephemeral' });
  });

  it('translates tools into Claude tool format', async () => {
    mockCreate.mockResolvedValue(makeAnthropicTextResponse('ok'));
    const adapter = new ClaudeProviderAdapter({ apiKey: 'test-key' });

    await adapter.send({
      messages: [{ role: 'user', content: 'Use a tool' }],
      tools: [{
        name: 'search',
        description: 'Search the web',
        inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
      }],
    });

    const call = mockCreate.mock.calls[0][0];
    expect(call.tools[0].name).toBe('search');
    expect(call.tools[0].input_schema).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// stream()
// ---------------------------------------------------------------------------

describe('ClaudeProviderAdapter.stream', () => {
  beforeEach(() => {
    mockCreate.mockReset();
    mockStream.mockReset();
  });

  it('yields text deltas and a terminal done:true chunk', async () => {
    // The claude adapter uses client.messages.stream(), not create(stream:true)
    const fakeEvents = [
      { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello' } },
      { type: 'content_block_delta', delta: { type: 'text_delta', text: ' world' } },
    ];
    mockStream.mockReturnValue(
      makeFakeMessageStream(fakeEvents, { content: [{ type: 'text', text: 'Hello world' }] }),
    );

    const adapter = new ClaudeProviderAdapter({ apiKey: 'test-key' });
    const chunks = [];
    for await (const chunk of adapter.stream({ messages: [{ role: 'user', content: 'Hi' }] })) {
      chunks.push(chunk);
    }

    expect(chunks.filter(c => !c.done).map(c => c.delta)).toEqual(['Hello', ' world']);
    expect(chunks[chunks.length - 1].done).toBe(true);
  });

  it('yields a tool_use ContentBlock delta before the terminal chunk', async () => {
    // No text_delta events — the model goes straight to a tool call, which
    // only shows up in finalMessage() (see claude.ts stream()), not as
    // content_block_delta/text_delta events.
    const fakeEvents = [
      { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Let me check...' } },
    ];
    mockStream.mockReturnValue(
      makeFakeMessageStream(fakeEvents, {
        content: [
          { type: 'text', text: 'Let me check...' },
          { type: 'tool_use', id: 'call_1', name: 'get_weather', input: { city: 'London' } },
        ],
      }),
    );

    const adapter = new ClaudeProviderAdapter({ apiKey: 'test-key' });
    const chunks = [];
    for await (const chunk of adapter.stream({ messages: [{ role: 'user', content: 'Weather?' }] })) {
      chunks.push(chunk);
    }

    const toolUseChunk = chunks.find(c => !c.done && typeof c.delta !== 'string');
    expect(toolUseChunk).toBeDefined();
    expect(toolUseChunk?.delta).toEqual({
      type: 'tool_use',
      id: 'call_1',
      name: 'get_weather',
      input: { city: 'London' },
    });
    // Tool call must arrive before the terminal chunk
    expect(chunks[chunks.length - 1].done).toBe(true);
    expect(chunks[chunks.length - 2]).toBe(toolUseChunk);
  });
});

// ---------------------------------------------------------------------------
// R1 — toolChoice
// ---------------------------------------------------------------------------

const TOOLS = [
  { name: 'record_facts', description: 'Record facts', inputSchema: { type: 'object', properties: {} } },
  { name: 'other_tool',   description: 'Other',        inputSchema: { type: 'object', properties: {} } },
];

describe('ClaudeProviderAdapter toolChoice', () => {
  beforeEach(() => {
    mockCreate.mockReset();
    mockStream.mockReset();
    mockCreate.mockResolvedValue(makeAnthropicTextResponse('ok'));
  });

  it('sends no tool_choice when toolChoice is omitted (unchanged default)', async () => {
    const adapter = new ClaudeProviderAdapter({ apiKey: 'k' });
    await adapter.send({ messages: [{ role: 'user', content: 'Hi' }], tools: TOOLS });
    expect(mockCreate.mock.calls[0][0]).not.toHaveProperty('tool_choice');
  });

  it.each([
    ['auto', { type: 'auto' }],
    ['any',  { type: 'any' }],
    ['none', { type: 'none' }],
  ] as const)('maps %s → %j', async (choice, expected) => {
    const adapter = new ClaudeProviderAdapter({ apiKey: 'k' });
    await adapter.send({ messages: [{ role: 'user', content: 'Hi' }], tools: TOOLS, toolChoice: choice });
    expect(mockCreate.mock.calls[0][0].tool_choice).toEqual(expected);
  });

  it('maps a named tool → { type: "tool", name }', async () => {
    const adapter = new ClaudeProviderAdapter({ apiKey: 'k' });
    await adapter.send({
      messages: [{ role: 'user', content: 'Hi' }],
      tools: TOOLS,
      toolChoice: { type: 'tool', name: 'record_facts' },
    });
    expect(mockCreate.mock.calls[0][0].tool_choice).toEqual({ type: 'tool', name: 'record_facts' });
  });

  it('passes tool_choice on stream() too', async () => {
    mockStream.mockReturnValue(makeFakeMessageStream([], { content: [] }));
    const adapter = new ClaudeProviderAdapter({ apiKey: 'k' });
    for await (const _ of adapter.stream({
      messages: [{ role: 'user', content: 'Hi' }],
      tools: TOOLS,
      toolChoice: 'any',
    })) { /* drain */ }
    expect(mockStream.mock.calls[0][0].tool_choice).toEqual({ type: 'any' });
  });

  it('rejects a forced tool choice with no tools, before sending', async () => {
    const adapter = new ClaudeProviderAdapter({ apiKey: 'k' });
    await expect(adapter.send({ messages: [{ role: 'user', content: 'Hi' }], toolChoice: 'any' }))
      .rejects.toBeInstanceOf(InvalidRequestError);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('rejects a tool name that is not in the tools list', async () => {
    const adapter = new ClaudeProviderAdapter({ apiKey: 'k' });
    await expect(adapter.send({
      messages: [{ role: 'user', content: 'Hi' }],
      tools: TOOLS,
      toolChoice: { type: 'tool', name: 'missing' },
    })).rejects.toThrow('"missing", which is not in the tools list');
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("'none' without tools sends nothing extra", async () => {
    const adapter = new ClaudeProviderAdapter({ apiKey: 'k' });
    await adapter.send({ messages: [{ role: 'user', content: 'Hi' }], toolChoice: 'none' });
    const call = mockCreate.mock.calls[0][0];
    expect(call).not.toHaveProperty('tool_choice');
    expect(call).not.toHaveProperty('tools');
  });
});

// ---------------------------------------------------------------------------
// R2 — document blocks
// ---------------------------------------------------------------------------

describe('ClaudeProviderAdapter document blocks', () => {
  beforeEach(() => {
    mockCreate.mockReset();
    mockCreate.mockResolvedValue(makeAnthropicTextResponse('ok'));
  });

  it('sends a base64 PDF as a native document block with title and context', async () => {
    const adapter = new ClaudeProviderAdapter({ apiKey: 'k' });
    await adapter.send({
      messages: [{
        role: 'user',
        content: [
          {
            type: 'document',
            source: { type: 'base64', media_type: 'application/pdf', data: 'JVBERi0x' },
            title: 'Bill of lading B/L 123',
            context: 'Uploaded by the consignee',
          },
          { type: 'text', text: 'Summarise this.' },
        ],
      }],
    });

    const block = mockCreate.mock.calls[0][0].messages[0].content[0];
    expect(block).toEqual({
      type: 'document',
      source: { type: 'base64', media_type: 'application/pdf', data: 'JVBERi0x' },
      title: 'Bill of lading B/L 123',
      context: 'Uploaded by the consignee',
    });
  });

  it('sends a CSV text document as text/plain (the only text media type Claude accepts)', async () => {
    const adapter = new ClaudeProviderAdapter({ apiKey: 'k' });
    await adapter.send({
      messages: [{
        role: 'user',
        content: [{
          type: 'document',
          source: { type: 'text', media_type: 'text/csv', data: 'item,qty\nbags,40' },
          title: 'Tally sheet',
        }],
      }],
    });

    const block = mockCreate.mock.calls[0][0].messages[0].content[0];
    expect(block).toEqual({
      type: 'document',
      source: { type: 'text', media_type: 'text/plain', data: 'item,qty\nbags,40' },
      title: 'Tally sheet',
    });
  });

  it('omits title/context when not given', async () => {
    const adapter = new ClaudeProviderAdapter({ apiKey: 'k' });
    await adapter.send({
      messages: [{
        role: 'user',
        content: [{ type: 'document', source: { type: 'text', media_type: 'text/plain', data: 'x' } }],
      }],
    });
    const block = mockCreate.mock.calls[0][0].messages[0].content[0];
    expect(block).not.toHaveProperty('title');
    expect(block).not.toHaveProperty('context');
  });

  it('rejects base64 payloads over the 32 MB request limit before sending', async () => {
    const adapter = new ClaudeProviderAdapter({ apiKey: 'k' });
    const big = 'A'.repeat(17 * 1024 * 1024);
    const send = adapter.send({
      messages: [{
        role: 'user',
        content: [
          { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: big } },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: big } },
        ],
      }],
    });
    await expect(send).rejects.toBeInstanceOf(InvalidRequestError);
    await expect(send).rejects.toThrow("Claude's request limit is 32 MB");
    expect(mockCreate).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// R5 — system prompt caching
// ---------------------------------------------------------------------------

describe('ClaudeProviderAdapter system prompt blocks', () => {
  beforeEach(() => {
    mockCreate.mockReset();
    mockCreate.mockResolvedValue(makeAnthropicTextResponse('ok'));
  });

  it('a plain string system prompt is not cached (unchanged default)', async () => {
    const adapter = new ClaudeProviderAdapter({ apiKey: 'k' });
    await adapter.send({ systemPrompt: 'Be brief.', messages: [{ role: 'user', content: 'Hi' }] });
    expect(mockCreate.mock.calls[0][0].system).toEqual([{ type: 'text', text: 'Be brief.' }]);
  });

  it('caches a stable prefix and leaves the variable suffix uncached', async () => {
    const adapter = new ClaudeProviderAdapter({ apiKey: 'k' });
    await adapter.send({
      systemPrompt: [
        { text: 'Knowledge pack', cacheBreakpoint: true },
        { text: 'Assignment J-42 context' },
      ],
      messages: [{ role: 'user', content: 'Hi' }],
    });
    expect(mockCreate.mock.calls[0][0].system).toEqual([
      { type: 'text', text: 'Knowledge pack', cache_control: { type: 'ephemeral' } },
      { type: 'text', text: 'Assignment J-42 context' },
    ]);
  });

  it('drops empty blocks and omits system entirely when nothing is left', async () => {
    const adapter = new ClaudeProviderAdapter({ apiKey: 'k' });
    await adapter.send({ systemPrompt: [{ text: '' }], messages: [{ role: 'user', content: 'Hi' }] });
    expect(mockCreate.mock.calls[0][0]).not.toHaveProperty('system');
  });

  it('rejects more than 4 cache breakpoints across system and messages', async () => {
    const adapter = new ClaudeProviderAdapter({ apiKey: 'k' });
    await expect(adapter.send({
      systemPrompt: [1, 2, 3, 4].map(i => ({ text: `part ${i}`, cacheBreakpoint: true })),
      messages: [
        { role: 'user', content: 'earlier', cacheBreakpoint: true },
        { role: 'user', content: 'Hi' },
      ],
    })).rejects.toThrow('5 cache breakpoints');
    expect(mockCreate).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// R4 — adapter options
// ---------------------------------------------------------------------------

describe('ClaudeProviderAdapter options', () => {
  beforeEach(() => {
    mockCreate.mockReset();
    vi.mocked(Anthropic).mockClear();
    mockCreate.mockResolvedValue(makeAnthropicTextResponse('ok'));
  });

  it('passes maxRetries and timeoutMs to the SDK client', () => {
    new ClaudeProviderAdapter({ apiKey: 'k', maxRetries: 0, timeoutMs: 30_000 });
    expect(vi.mocked(Anthropic)).toHaveBeenCalledWith({ apiKey: 'k', maxRetries: 0, timeout: 30_000 });
  });

  it('leaves SDK defaults alone when the options are omitted', async () => {
    const adapter = new ClaudeProviderAdapter({ apiKey: 'k' });
    expect(vi.mocked(Anthropic)).toHaveBeenCalledWith({ apiKey: 'k' });
    await adapter.send({ messages: [{ role: 'user', content: 'Hi' }] });
    expect(mockCreate.mock.calls[0][0]).not.toHaveProperty('temperature');
  });

  it('sends temperature on every request, including 0', async () => {
    const adapter = new ClaudeProviderAdapter({ apiKey: 'k', temperature: 0 });
    await adapter.send({ messages: [{ role: 'user', content: 'Hi' }] });
    expect(mockCreate.mock.calls[0][0].temperature).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// R3 — error mapping
// ---------------------------------------------------------------------------

describe('ClaudeProviderAdapter error mapping', () => {
  beforeEach(() => {
    mockCreate.mockReset();
    mockStream.mockReset();
  });

  const anthropicBody = (type: string, message: string) => ({ type: 'error', error: { type, message } });

  async function sendError(err: unknown): Promise<unknown> {
    mockCreate.mockRejectedValue(err);
    const adapter = new ClaudeProviderAdapter({ apiKey: 'k' });
    return adapter.send({ messages: [{ role: 'user', content: 'Hi' }] }).catch(e => e);
  }

  it('429 → RateLimitError with retryAfterMs from retry-after', async () => {
    const err = await sendError(new SdkRateLimitError(
      429, anthropicBody('rate_limit_error', 'Too many requests'), '429 rate limited', { 'retry-after': '12' },
    ));
    expect(err).toBeInstanceOf(RateLimitError);
    expect((err as RateLimitError).retryAfterMs).toBe(12_000);
    expect((err as RateLimitError).provider).toBe('claude');
    expect((err as RateLimitError).retryable).toBe(true);
    expect((err as RateLimitError).cause).toBeInstanceOf(SdkRateLimitError);
  });

  it('529 → OverloadedError', async () => {
    const err = await sendError(new APIError(529, anthropicBody('overloaded_error', 'Overloaded'), '529 Overloaded'));
    expect(err).toBeInstanceOf(OverloadedError);
  });

  it('401 → AuthenticationError (not retryable)', async () => {
    const err = await sendError(new APIError(401, anthropicBody('authentication_error', 'invalid x-api-key'), '401'));
    expect(err).toBeInstanceOf(AuthenticationError);
    expect((err as ProviderError).retryable).toBe(false);
  });

  it('400 "prompt is too long" → ContextLengthError', async () => {
    const err = await sendError(new BadRequestError(
      400, anthropicBody('invalid_request_error', 'prompt is too long: 250000 tokens > 200000 maximum'),
      '400 {"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: 250000 tokens > 200000 maximum"}}',
    ));
    expect(err).toBeInstanceOf(ContextLengthError);
  });

  it('other 400 → InvalidRequestError', async () => {
    const err = await sendError(new BadRequestError(400, anthropicBody('invalid_request_error', 'bad'), '400 bad'));
    expect(err).toBeInstanceOf(InvalidRequestError);
  });

  it('timeout → retryable ProviderError', async () => {
    const err = await sendError(new APIConnectionTimeoutError());
    expect((err as ProviderError).constructor).toBe(ProviderError);
    expect((err as ProviderError).retryable).toBe(true);
  });

  it('caller abort and non-SDK errors pass through unchanged', async () => {
    const abort = new APIUserAbortError();
    expect(await sendError(abort)).toBe(abort);
    const bug = new TypeError('x is undefined');
    expect(await sendError(bug)).toBe(bug);
  });

  it('maps an overloaded_error that arrives mid-stream (no HTTP status)', async () => {
    mockStream.mockReturnValue({
      [Symbol.asyncIterator]: () => (async function* () {
        yield { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hel' } };
        throw new APIError(undefined, anthropicBody('overloaded_error', 'Overloaded'), 'Overloaded');
      })(),
      finalMessage: vi.fn(),
    });
    const adapter = new ClaudeProviderAdapter({ apiKey: 'k' });
    const chunks: unknown[] = [];
    const err = await (async () => {
      for await (const c of adapter.stream({ messages: [{ role: 'user', content: 'Hi' }] })) chunks.push(c);
    })().catch(e => e);

    expect(chunks).toEqual([{ delta: 'Hel', done: false }]);
    expect(err).toBeInstanceOf(OverloadedError);
    expect((err as OverloadedError).status).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// R6 — thinking models
// ---------------------------------------------------------------------------

describe('ClaudeProviderAdapter thinking blocks (R6.1)', () => {
  beforeEach(() => {
    mockCreate.mockReset();
    mockStream.mockReset();
  });

  it('maps thinking and redacted_thinking verbatim and never invents empty text', async () => {
    mockCreate.mockResolvedValue({
      content: [
        { type: 'thinking', thinking: '', signature: 's1' },
        { type: 'redacted_thinking', data: 'enc' },
        { type: 'text', text: '140' },
      ],
      stop_reason: 'end_turn',
      usage: { input_tokens: 5, output_tokens: 3 },
    });
    const adapter = new ClaudeProviderAdapter({ apiKey: 'k' });
    const res = await adapter.send({ messages: [{ role: 'user', content: 'Count?' }] });

    expect(res.content).toEqual([
      { type: 'thinking', thinking: '', signature: 's1' },
      { type: 'redacted_thinking', data: 'enc' },
      { type: 'text', text: '140' },
    ]);
  });

  it('keeps an unrecognised block as provider_raw, not as empty text', async () => {
    const odd = { type: 'fallback', from: { model: 'a' }, to: { model: 'b' } };
    mockCreate.mockResolvedValue({
      content: [odd, { type: 'text', text: 'hi' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 5, output_tokens: 3 },
    });
    const adapter = new ClaudeProviderAdapter({ apiKey: 'k' });
    const res = await adapter.send({ messages: [{ role: 'user', content: 'x' }] });

    expect(res.content[0]).toEqual({ type: 'provider_raw', provider: 'claude', block: odd });
    expect(res.content.some(b => b.type === 'text' && b.text === '')).toBe(false);
  });

  it('sends thinking blocks back byte-for-byte, in order, and drops empty text blocks', async () => {
    mockCreate.mockResolvedValue(makeAnthropicTextResponse('ok'));
    const adapter = new ClaudeProviderAdapter({ apiKey: 'k' });
    await adapter.send({
      messages: [
        { role: 'user', content: 'Q1' },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: '' },
            { type: 'thinking', thinking: '', signature: 's1' },
            { type: 'redacted_thinking', data: 'enc' },
            { type: 'text', text: '   ' },
            { type: 'tool_use', id: 't1', name: 'x', input: {} },
          ],
        },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
      ],
    });

    expect(mockCreate.mock.calls[0][0].messages[1].content).toEqual([
      { type: 'thinking', thinking: '', signature: 's1' },
      { type: 'redacted_thinking', data: 'enc' },
      { type: 'tool_use', id: 't1', name: 'x', input: {} },
    ]);
  });

  it('re-sends claude provider_raw blocks verbatim and skips other providers’', async () => {
    mockCreate.mockResolvedValue(makeAnthropicTextResponse('ok'));
    const adapter = new ClaudeProviderAdapter({ apiKey: 'k' });
    await adapter.send({
      messages: [
        { role: 'user', content: 'Q' },
        {
          role: 'assistant',
          content: [
            { type: 'provider_raw', provider: 'claude', block: { type: 'server_thing', id: 'a' } },
            { type: 'provider_raw', provider: 'other', block: { type: 'x' } },
            { type: 'text', text: 'A' },
          ],
        },
        { role: 'user', content: 'Q2' },
      ],
    });
    expect(mockCreate.mock.calls[0][0].messages[1].content).toEqual([
      { type: 'server_thing', id: 'a' },
      { type: 'text', text: 'A' },
    ]);
  });

  it('drops an assistant message left empty (0.3.0 histories) but rejects an empty user message', async () => {
    mockCreate.mockResolvedValue(makeAnthropicTextResponse('ok'));
    const adapter = new ClaudeProviderAdapter({ apiKey: 'k' });

    await adapter.send({
      messages: [
        { role: 'user', content: 'Q1' },
        { role: 'assistant', content: [{ type: 'text', text: '' }] },
        { role: 'user', content: 'Q2' },
      ],
    });
    expect(mockCreate.mock.calls[0][0].messages.map((m: { role: string }) => m.role))
      .toEqual(['user', 'user']);

    await expect(adapter.send({ messages: [{ role: 'user', content: '  ' }] }))
      .rejects.toBeInstanceOf(InvalidRequestError);
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it('puts cache_control on the last non-thinking block', async () => {
    mockCreate.mockResolvedValue(makeAnthropicTextResponse('ok'));
    const adapter = new ClaudeProviderAdapter({ apiKey: 'k' });
    await adapter.send({
      messages: [
        { role: 'user', content: 'Q' },
        {
          role: 'assistant',
          cacheBreakpoint: true,
          content: [
            { type: 'text', text: 'partial' },
            { type: 'thinking', thinking: '', signature: 's' },
          ],
        },
        { role: 'user', content: 'Q2' },
      ],
    });
    const content = mockCreate.mock.calls[0][0].messages[1].content;
    expect(content[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(content[1]).not.toHaveProperty('cache_control');
  });
});

describe('ClaudeProviderAdapter stream final response (R6.2)', () => {
  beforeEach(() => {
    mockStream.mockReset();
  });

  it('returns every block in order with real stopReason/usage, and signals thinking', async () => {
    const events = [
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Hmm' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig-1' } },
      { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Hi' } },
    ];
    // Older SDKs leave thinking text and signature out of finalMessage().
    mockStream.mockReturnValue(makeFakeMessageStream(events, {
      content: [
        { type: 'thinking', thinking: '', signature: '' },
        { type: 'text', text: 'Hi' },
        { type: 'tool_use', id: 't1', name: 'x', input: { a: 1 } },
      ],
      stop_reason: 'tool_use',
      usage: { input_tokens: 50, output_tokens: 7, cache_read_input_tokens: 40 },
    }));

    const adapter = new ClaudeProviderAdapter({ apiKey: 'k' });
    const chunks = [];
    for await (const c of adapter.stream({ messages: [{ role: 'user', content: 'Q' }] })) chunks.push(c);

    expect(chunks[0]).toEqual({ delta: '', done: false, thinking: true });
    expect(chunks[1]).toEqual({ delta: '', done: false, thinking: true, thinkingDelta: 'Hmm' });
    expect(chunks.filter(c => typeof c.delta === 'string' && c.delta).map(c => c.delta)).toEqual(['Hi']);

    const done = chunks[chunks.length - 1];
    expect(done.done).toBe(true);
    expect(done.response).toEqual({
      content: [
        { type: 'thinking', thinking: 'Hmm', signature: 'sig-1' },
        { type: 'text', text: 'Hi' },
        { type: 'tool_use', id: 't1', name: 'x', input: { a: 1 } },
      ],
      stopReason: 'tool_use',
      usage: { inputTokens: 50, outputTokens: 7, cacheReadTokens: 40, cacheWriteTokens: undefined },
    });
  });
});

describe('ClaudeProviderAdapter stream stop_details (R6.6)', () => {
  it('takes stop_details from message_delta when finalMessage() lacks it', async () => {
    mockStream.mockReset();
    mockStream.mockReturnValue(makeFakeMessageStream(
      [{ type: 'message_delta', delta: { stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'bio' } } }],
      { content: [], stop_reason: 'refusal' },
    ));
    const adapter = new ClaudeProviderAdapter({ apiKey: 'k' });
    let response;
    for await (const c of adapter.stream({ messages: [{ role: 'user', content: 'q' }] })) response = c.response ?? response;
    expect(response?.stopReason).toBe('refusal');
    expect(response?.stopDetails).toEqual({ category: 'bio' });
  });
});

describe('ClaudeProviderAdapter thinking options (R6.3, R6.5)', () => {
  beforeEach(() => {
    mockCreate.mockReset();
    mockStream.mockReset();
    mockCreate.mockResolvedValue(makeAnthropicTextResponse('ok'));
  });

  const MSG = [{ role: 'user' as const, content: 'Hi' }];

  it('sends no thinking, output_config or beta header when the options are unset', async () => {
    const adapter = new ClaudeProviderAdapter({ apiKey: 'k' });
    await adapter.send({ messages: MSG });
    expect(mockCreate.mock.calls[0][0]).not.toHaveProperty('thinking');
    expect(mockCreate.mock.calls[0][0]).not.toHaveProperty('output_config');
    expect(mockCreate.mock.calls[0][1]).toBeUndefined();
  });

  it('maps adapter defaults, and per-call values override them', async () => {
    const adapter = new ClaudeProviderAdapter({
      apiKey: 'k',
      thinking: { type: 'adaptive', display: 'summarized' },
      effort: 'medium',
    });
    await adapter.send({ messages: MSG });
    expect(mockCreate.mock.calls[0][0].thinking).toEqual({ type: 'adaptive', display: 'summarized' });
    expect(mockCreate.mock.calls[0][0].output_config).toEqual({ effort: 'medium' });

    await adapter.send({ messages: MSG, thinking: { type: 'disabled' }, effort: 'low' });
    expect(mockCreate.mock.calls[1][0].thinking).toEqual({ type: 'disabled' });
    expect(mockCreate.mock.calls[1][0].output_config).toEqual({ effort: 'low' });
  });

  it('blockBinding adds block_binding (adaptive) and the beta header', async () => {
    const adapter = new ClaudeProviderAdapter({ apiKey: 'k', blockBinding: 'error' });
    await adapter.send({ messages: MSG });
    expect(mockCreate.mock.calls[0][0].thinking).toEqual({
      type: 'adaptive',
      block_binding: { prefix_mismatch_behavior: 'error' },
    });
    expect(mockCreate.mock.calls[0][1]).toEqual({
      headers: { 'anthropic-beta': 'thinking-binding-controls-2026-08-01' },
    });

    await adapter.send({ messages: MSG, blockBinding: 'drop_block', thinking: { type: 'adaptive', display: 'summarized' } });
    expect(mockCreate.mock.calls[1][0].thinking).toEqual({
      type: 'adaptive',
      display: 'summarized',
      block_binding: { prefix_mismatch_behavior: 'drop_block' },
    });
  });

  it('blockBinding also reaches stream()', async () => {
    mockStream.mockReturnValue(makeFakeMessageStream([], { content: [] }));
    const adapter = new ClaudeProviderAdapter({ apiKey: 'k' });
    for await (const _ of adapter.stream({ messages: MSG, blockBinding: 'error', effort: 'high' })) { /* drain */ }
    expect(mockStream.mock.calls[0][0].thinking.block_binding).toEqual({ prefix_mismatch_behavior: 'error' });
    expect(mockStream.mock.calls[0][0].output_config).toEqual({ effort: 'high' });
    expect(mockStream.mock.calls[0][1]).toEqual({
      headers: { 'anthropic-beta': 'thinking-binding-controls-2026-08-01' },
    });
  });

  it('rejects blockBinding with non-adaptive thinking, before sending', async () => {
    const adapter = new ClaudeProviderAdapter({ apiKey: 'k', thinking: { type: 'between_tools' } });
    await expect(adapter.send({ messages: MSG, blockBinding: 'error' }))
      .rejects.toBeInstanceOf(InvalidRequestError);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('surfaces input_transformations and stop_details', async () => {
    mockCreate.mockResolvedValue({
      content: [],
      stop_reason: 'refusal',
      stop_details: { type: 'refusal', category: 'cyber', explanation: 'no' },
      input_transformations: [
        { type: 'thinking_dropped', path: 'messages.1.content.0', reason: 'prefix_binding_mismatch' },
      ],
      usage: { input_tokens: 5, output_tokens: 0 },
    });
    const adapter = new ClaudeProviderAdapter({ apiKey: 'k' });
    const res = await adapter.send({ messages: MSG });
    expect(res.stopReason).toBe('refusal');
    expect(res.stopDetails).toEqual({ category: 'cyber', explanation: 'no' });
    expect(res.inputTransformations).toEqual([
      { type: 'thinking_dropped', path: 'messages.1.content.0', reason: 'prefix_binding_mismatch' },
    ]);
  });
});
