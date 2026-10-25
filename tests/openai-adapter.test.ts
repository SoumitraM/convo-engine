/**
 * OpenAIProviderAdapter unit tests
 * Uses vi.mock to avoid loading the real openai SDK at test time.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock openai before importing the adapter
// ---------------------------------------------------------------------------

const mockChatCreate = vi.fn();

vi.mock('openai', () => {
  return {
    default: vi.fn().mockImplementation(() => ({
      chat: {
        completions: {
          create: mockChatCreate,
        },
      },
    })),
  };
});

import OpenAI from 'openai';
import { OpenAIProviderAdapter } from '../src/adapters/provider/openai.js';
import {
  RateLimitError,
  ContextLengthError,
  AuthenticationError,
  InvalidRequestError,
  ProviderError,
} from '../src/errors.js';
import { OpenAIAPIError, APIConnectionError } from './helpers/fake-sdk-errors.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeOpenAITextResponse(text: string) {
  return {
    choices: [{
      message:       { role: 'assistant', content: text, tool_calls: null },
      finish_reason: 'stop',
    }],
    usage: { prompt_tokens: 15, completion_tokens: 7, total_tokens: 22 },
  };
}

function makeOpenAIToolCallResponse(id: string, name: string, args: string) {
  return {
    choices: [{
      message: {
        role:    'assistant',
        content: null,
        tool_calls: [{
          id,
          type: 'function',
          function: { name, arguments: args },
        }],
      },
      finish_reason: 'tool_calls',
    }],
    usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
  };
}

// ---------------------------------------------------------------------------
// send()
// ---------------------------------------------------------------------------

describe('OpenAIProviderAdapter.send', () => {
  beforeEach(() => mockChatCreate.mockReset());

  it('returns a text ProviderResponse', async () => {
    mockChatCreate.mockResolvedValue(makeOpenAITextResponse('Hi there'));
    const adapter = new OpenAIProviderAdapter({ apiKey: 'test' });

    const result = await adapter.send({ messages: [{ role: 'user', content: 'Hello' }] });

    expect(result.content[0].type).toBe('text');
    if (result.content[0].type === 'text') expect(result.content[0].text).toBe('Hi there');
    expect(result.stopReason).toBe('stop');
    expect(result.usage.inputTokens).toBe(15);
    expect(result.usage.outputTokens).toBe(7);
  });

  it('returns a tool_use ProviderResponse on tool call', async () => {
    mockChatCreate.mockResolvedValue(
      makeOpenAIToolCallResponse('call_1', 'get_weather', '{"city":"Paris"}'),
    );
    const adapter = new OpenAIProviderAdapter({ apiKey: 'test' });

    const result = await adapter.send({ messages: [{ role: 'user', content: 'Weather?' }] });

    expect(result.content[0].type).toBe('tool_use');
    if (result.content[0].type === 'tool_use') {
      expect(result.content[0].name).toBe('get_weather');
      expect(result.content[0].input).toEqual({ city: 'Paris' });
    }
    expect(result.stopReason).toBe('tool_use');
  });

  it('prepends systemPrompt as a system message', async () => {
    mockChatCreate.mockResolvedValue(makeOpenAITextResponse('ok'));
    const adapter = new OpenAIProviderAdapter({ apiKey: 'test' });

    await adapter.send({
      systemPrompt: 'You are a bot.',
      messages: [{ role: 'user', content: 'Hi' }],
    });

    const call = mockChatCreate.mock.calls[0][0];
    expect(call.messages[0].role).toBe('system');
    expect(call.messages[0].content).toBe('You are a bot.');
  });

  it('silently ignores cacheBreakpoint', async () => {
    mockChatCreate.mockResolvedValue(makeOpenAITextResponse('ok'));
    const adapter = new OpenAIProviderAdapter({ apiKey: 'test' });

    await expect(
      adapter.send({
        messages: [{ role: 'user', content: 'Hi', cacheBreakpoint: true }],
      }),
    ).resolves.toBeDefined();
  });

  it('translates tool_result ContentBlock into a role:tool message', async () => {
    mockChatCreate.mockResolvedValue(makeOpenAITextResponse('ok'));
    const adapter = new OpenAIProviderAdapter({ apiKey: 'test' });

    await adapter.send({
      messages: [{
        role:    'user',
        content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'London' }],
      }],
    });

    const call = mockChatCreate.mock.calls[0][0];
    const toolMsg = call.messages.find((m: { role: string }) => m.role === 'tool');
    expect(toolMsg).toBeDefined();
    expect(toolMsg.tool_call_id).toBe('call_1');
    expect(toolMsg.content).toBe('London');
  });

  it('translates tools into OpenAI format', async () => {
    mockChatCreate.mockResolvedValue(makeOpenAITextResponse('ok'));
    const adapter = new OpenAIProviderAdapter({ apiKey: 'test' });

    await adapter.send({
      messages: [{ role: 'user', content: 'Use tools' }],
      tools: [{ name: 'my_tool', description: 'Does X', inputSchema: { type: 'object' } }],
    });

    const call = mockChatCreate.mock.calls[0][0];
    expect(call.tools[0].type).toBe('function');
    expect(call.tools[0].function.name).toBe('my_tool');
    expect(call.tools[0].function.parameters).toEqual({ type: 'object' });
  });

  it('omits tools key when no tools provided', async () => {
    mockChatCreate.mockResolvedValue(makeOpenAITextResponse('ok'));
    const adapter = new OpenAIProviderAdapter({ apiKey: 'test' });

    await adapter.send({ messages: [{ role: 'user', content: 'Hi' }] });

    const call = mockChatCreate.mock.calls[0][0];
    expect(call.tools).toBeUndefined();
    expect(call.tool_choice).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// stream()
// ---------------------------------------------------------------------------

describe('OpenAIProviderAdapter.stream', () => {
  beforeEach(() => mockChatCreate.mockReset());

  it('yields text deltas and terminal done:true chunk', async () => {
    const fakeChunks = [
      { choices: [{ delta: { content: 'Hello' } }] },
      { choices: [{ delta: { content: ' world' } }] },
      { choices: [{ delta: {} }] },
    ];
    mockChatCreate.mockReturnValue((async function* () { yield* fakeChunks; })());

    const adapter = new OpenAIProviderAdapter({ apiKey: 'test' });
    const chunks = [];
    for await (const c of adapter.stream({ messages: [{ role: 'user', content: 'Hi' }] })) {
      chunks.push(c);
    }

    expect(chunks.filter(c => !c.done).map(c => c.delta)).toContain('Hello');
    expect(chunks[chunks.length - 1].done).toBe(true);
  });

  it('buffers tool call deltas and flushes as single chunk', async () => {
    const fakeChunks = [
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'tc_1', type: 'function', function: { name: 'search', arguments: '{"q' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '":"hi"}' } }] } }] },
      { choices: [{ delta: {} }] },
    ];
    mockChatCreate.mockReturnValue((async function* () { yield* fakeChunks; })());

    const adapter = new OpenAIProviderAdapter({ apiKey: 'test' });
    const chunks = [];
    for await (const c of adapter.stream({ messages: [{ role: 'user', content: 'Search' }] })) {
      chunks.push(c);
    }

    const toolChunks = chunks.filter(c => !c.done && typeof c.delta !== 'string');
    expect(toolChunks).toHaveLength(1);
    const toolDelta = toolChunks[0].delta;
    if (typeof toolDelta !== 'string' && toolDelta.type === 'tool_use') {
      expect(toolDelta.name).toBe('search');
      expect(toolDelta.input).toEqual({ q: 'hi' });
    }
    expect(chunks[chunks.length - 1].done).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// R1 — toolChoice
// ---------------------------------------------------------------------------

const TOOLS = [{ name: 'record_facts', description: 'Record facts', inputSchema: { type: 'object' } }];

describe('OpenAIProviderAdapter toolChoice', () => {
  beforeEach(() => {
    mockChatCreate.mockReset();
    mockChatCreate.mockResolvedValue(makeOpenAITextResponse('ok'));
  });

  it.each([
    [undefined, 'auto'],
    ['auto', 'auto'],
    ['any', 'required'],
    ['none', 'none'],
    [{ type: 'tool', name: 'record_facts' }, { type: 'function', function: { name: 'record_facts' } }],
  ] as const)('maps %j → %j', async (choice, expected) => {
    const adapter = new OpenAIProviderAdapter({ apiKey: 'k' });
    await adapter.send({ messages: [{ role: 'user', content: 'Hi' }], tools: TOOLS, toolChoice: choice });
    expect(mockChatCreate.mock.calls[0][0].tool_choice).toEqual(expected);
  });

  it('rejects a forced choice without tools', async () => {
    const adapter = new OpenAIProviderAdapter({ apiKey: 'k' });
    await expect(adapter.send({ messages: [{ role: 'user', content: 'Hi' }], toolChoice: { type: 'tool', name: 'x' } }))
      .rejects.toBeInstanceOf(InvalidRequestError);
    expect(mockChatCreate).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// R2 — images and documents
// ---------------------------------------------------------------------------

describe('OpenAIProviderAdapter images and documents', () => {
  beforeEach(() => {
    mockChatCreate.mockReset();
    mockChatCreate.mockResolvedValue(makeOpenAITextResponse('ok'));
  });

  it('sends images as image_url data URLs instead of dropping them', async () => {
    const adapter = new OpenAIProviderAdapter({ apiKey: 'k' });
    await adapter.send({
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'What is damaged?' },
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'abc' } },
        ],
      }],
    });
    expect(mockChatCreate.mock.calls[0][0].messages[0]).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: 'What is damaged?' },
        { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,abc' } },
      ],
    });
  });

  it('sends a PDF as a file content part named after the title', async () => {
    const adapter = new OpenAIProviderAdapter({ apiKey: 'k' });
    await adapter.send({
      messages: [{
        role: 'user',
        content: [{
          type: 'document',
          source: { type: 'base64', media_type: 'application/pdf', data: 'JVBERi0x' },
          title: 'invoice.pdf',
        }],
      }],
    });
    expect(mockChatCreate.mock.calls[0][0].messages[0].content).toEqual([
      { type: 'file', file: { filename: 'invoice.pdf', file_data: 'data:application/pdf;base64,JVBERi0x' } },
    ]);
  });

  it('inlines a text document (with title and context) as text', async () => {
    const adapter = new OpenAIProviderAdapter({ apiKey: 'k' });
    await adapter.send({
      messages: [{
        role: 'user',
        content: [
          { type: 'document', source: { type: 'text', media_type: 'text/csv', data: 'a,b\n1,2' }, title: 'Tally', context: 'Sheet 1' },
          { type: 'text', text: 'Check it.' },
        ],
      }],
    });
    expect(mockChatCreate.mock.calls[0][0].messages[0]).toEqual({
      role: 'user',
      content: '<document title="Tally" media_type="text/csv">\nSheet 1\n\na,b\n1,2\n</document>\nCheck it.',
    });
  });

  it('rejects media in a non-user message', async () => {
    const adapter = new OpenAIProviderAdapter({ apiKey: 'k' });
    await expect(adapter.send({
      messages: [{
        role: 'assistant',
        content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'x' } }],
      }],
    })).rejects.toBeInstanceOf(InvalidRequestError);
  });
});

// ---------------------------------------------------------------------------
// R5 — system prompt blocks / R4 — options
// ---------------------------------------------------------------------------

describe('OpenAIProviderAdapter system blocks and options', () => {
  beforeEach(() => {
    mockChatCreate.mockReset();
    vi.mocked(OpenAI).mockClear();
    mockChatCreate.mockResolvedValue(makeOpenAITextResponse('ok'));
  });

  it('joins system prompt blocks with a blank line', async () => {
    const adapter = new OpenAIProviderAdapter({ apiKey: 'k' });
    await adapter.send({
      systemPrompt: [{ text: 'Prefix', cacheBreakpoint: true }, { text: 'Suffix' }],
      messages: [{ role: 'user', content: 'Hi' }],
    });
    expect(mockChatCreate.mock.calls[0][0].messages[0]).toEqual({ role: 'system', content: 'Prefix\n\nSuffix' });
  });

  it('passes maxRetries / timeoutMs to the client and temperature to the request', async () => {
    const adapter = new OpenAIProviderAdapter({ apiKey: 'k', maxRetries: 1, timeoutMs: 5000, temperature: 0 });
    expect(vi.mocked(OpenAI)).toHaveBeenCalledWith({ apiKey: 'k', maxRetries: 1, timeout: 5000 });
    await adapter.send({ messages: [{ role: 'user', content: 'Hi' }] });
    expect(mockChatCreate.mock.calls[0][0].temperature).toBe(0);
  });

  it('leaves defaults alone when options are omitted', async () => {
    const adapter = new OpenAIProviderAdapter({ apiKey: 'k' });
    expect(vi.mocked(OpenAI)).toHaveBeenCalledWith({ apiKey: 'k' });
    await adapter.send({ messages: [{ role: 'user', content: 'Hi' }] });
    expect(mockChatCreate.mock.calls[0][0]).not.toHaveProperty('temperature');
  });
});

// ---------------------------------------------------------------------------
// R3 — error mapping
// ---------------------------------------------------------------------------

describe('OpenAIProviderAdapter error mapping', () => {
  beforeEach(() => { mockChatCreate.mockReset(); });

  async function sendError(err: unknown): Promise<unknown> {
    mockChatCreate.mockRejectedValue(err);
    const adapter = new OpenAIProviderAdapter({ apiKey: 'k' });
    return adapter.send({ messages: [{ role: 'user', content: 'Hi' }] }).catch(e => e);
  }

  it('429 → RateLimitError, honouring retry-after-ms', async () => {
    const err = await sendError(new OpenAIAPIError(
      429, { message: 'Rate limit reached', type: 'requests', code: 'rate_limit_exceeded' }, { 'retry-after-ms': '250' },
    ));
    expect(err).toBeInstanceOf(RateLimitError);
    expect((err as RateLimitError).retryAfterMs).toBe(250);
    expect((err as RateLimitError).provider).toBe('openai');
  });

  it('context_length_exceeded → ContextLengthError', async () => {
    const err = await sendError(new OpenAIAPIError(
      400, { message: "This model's maximum context length is 128000 tokens.", type: 'invalid_request_error', code: 'context_length_exceeded' },
    ));
    expect(err).toBeInstanceOf(ContextLengthError);
  });

  it('401 → AuthenticationError', async () => {
    const err = await sendError(new OpenAIAPIError(401, { message: 'Incorrect API key', code: 'invalid_api_key' }));
    expect(err).toBeInstanceOf(AuthenticationError);
  });

  it('connection error → retryable ProviderError', async () => {
    const err = await sendError(new APIConnectionError());
    expect((err as ProviderError).constructor).toBe(ProviderError);
    expect((err as ProviderError).retryable).toBe(true);
  });

  it('maps errors thrown while streaming', async () => {
    mockChatCreate.mockResolvedValue({
      [Symbol.asyncIterator]: () => (async function* () {
        yield { choices: [{ delta: { content: 'Hi' } }] };
        throw new OpenAIAPIError(undefined, { message: 'server overloaded', type: 'server_error' });
      })(),
    });
    const adapter = new OpenAIProviderAdapter({ apiKey: 'k' });
    const err = await (async () => {
      for await (const _ of adapter.stream({ messages: [{ role: 'user', content: 'Hi' }] })) { /* drain */ }
    })().catch(e => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).retryable).toBe(true);
  });
});

describe('OpenAIProviderAdapter thinking blocks (R6.8)', () => {
  beforeEach(() => {
    mockChatCreate.mockReset();
    mockChatCreate.mockResolvedValue(makeOpenAITextResponse('ok'));
  });

  it('drops thinking, redacted_thinking and provider_raw blocks from requests', async () => {
    const adapter = new OpenAIProviderAdapter({ apiKey: 'k' });
    await adapter.send({
      messages: [
        { role: 'user', content: 'Q' },
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'secret', signature: 's' },
            { type: 'redacted_thinking', data: 'enc' },
            { type: 'provider_raw', provider: 'claude', block: { type: 'x' } },
            { type: 'text', text: 'A' },
          ],
        },
        { role: 'assistant', content: [{ type: 'thinking', thinking: '', signature: 's2' }] },
        { role: 'user', content: 'Q2' },
      ],
    });
    expect(mockChatCreate.mock.calls[0][0].messages).toEqual([
      { role: 'user', content: 'Q' },
      { role: 'assistant', content: 'A' },
      { role: 'user', content: 'Q2' },
    ]);
  });
});
