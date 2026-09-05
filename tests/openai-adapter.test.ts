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

import { OpenAIProviderAdapter } from '../src/adapters/provider/openai.js';

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
