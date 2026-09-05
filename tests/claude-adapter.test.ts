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

import { ClaudeProviderAdapter } from '../src/adapters/provider/claude.js';

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
    // stream() returns an async iterable
    mockStream.mockReturnValue((async function* () { yield* fakeEvents; })());

    const adapter = new ClaudeProviderAdapter({ apiKey: 'test-key' });
    const chunks = [];
    for await (const chunk of adapter.stream({ messages: [{ role: 'user', content: 'Hi' }] })) {
      chunks.push(chunk);
    }

    expect(chunks.filter(c => !c.done).map(c => c.delta)).toEqual(['Hello', ' world']);
    expect(chunks[chunks.length - 1].done).toBe(true);
  });
});
