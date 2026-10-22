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
  finalMessage: { content: unknown[] },
) {
  return {
    [Symbol.asyncIterator]: () => (async function* () { yield* events; })(),
    finalMessage: vi.fn().mockResolvedValue(finalMessage),
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
