/**
 * GatewayProviderAdapter unit tests
 * Mocks global fetch — no real network calls.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GatewayProviderAdapter, createGatewayProviderAdapter } from '../src/adapters/provider/gateway.js';

// ---------------------------------------------------------------------------
// Fetch mock helpers
// ---------------------------------------------------------------------------

function mockFetchJson(body: unknown, status = 200) {
  const response = {
    ok:     status >= 200 && status < 300,
    status,
    json:   vi.fn(async () => body),
    text:   vi.fn(async () => JSON.stringify(body)),
    body:   null,
  };
  vi.stubGlobal('fetch', vi.fn(async () => response));
  return response;
}

function mockFetchSse(lines: string[], status = 200) {
  const encoder = new TextEncoder();
  const sseBody = lines.join('\n') + '\n';
  const encoded = encoder.encode(sseBody);

  const reader = {
    read: vi.fn()
      .mockResolvedValueOnce({ value: encoded, done: false })
      .mockResolvedValueOnce({ value: undefined, done: true }),
  };
  const readableBody = { getReader: () => reader };

  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok:     status >= 200 && status < 300,
    status,
    body:   readableBody,
    text:   vi.fn(async () => ''),
  })));
}

// ---------------------------------------------------------------------------
// send() tests
// ---------------------------------------------------------------------------

describe('GatewayProviderAdapter.send', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('1. text response — returns text ContentBlock with correct tokens', async () => {
    mockFetchJson({
      choices: [{ message: { role: 'assistant', content: 'The answer is 4.', tool_calls: null }, finish_reason: 'stop' }],
      usage:   { prompt_tokens: 42, completion_tokens: 8, total_tokens: 50 },
    });

    const adapter = new GatewayProviderAdapter({ baseUrl: 'https://example.com', apiKey: 'key' });
    const result = await adapter.send({ messages: [{ role: 'user', content: 'What is 2+2?' }] });

    expect(result.content[0].type).toBe('text');
    if (result.content[0].type === 'text') expect(result.content[0].text).toBe('The answer is 4.');
    expect(result.stopReason).toBe('stop');
    expect(result.usage.inputTokens).toBe(42);
    expect(result.usage.outputTokens).toBe(8);
  });

  it('2. tool call response — returns tool_use ContentBlock, stopReason tool_use', async () => {
    mockFetchJson({
      choices: [{
        message: {
          role:    'assistant',
          content: null,
          tool_calls: [{ id: 'call_abc', type: 'function', function: { name: 'get_weather', arguments: '{"location":"London"}' } }],
        },
        finish_reason: 'tool_calls',
      }],
      usage: { prompt_tokens: 55, completion_tokens: 18 },
    });

    const adapter = new GatewayProviderAdapter({ baseUrl: 'https://example.com' });
    const result = await adapter.send({ messages: [{ role: 'user', content: 'Weather?' }] });

    expect(result.content[0].type).toBe('tool_use');
    if (result.content[0].type === 'tool_use') {
      expect(result.content[0].id).toBe('call_abc');
      expect(result.content[0].name).toBe('get_weather');
      expect(result.content[0].input).toEqual({ location: 'London' });
    }
    expect(result.stopReason).toBe('tool_use');
  });

  it('3. HTTP error — throws with status in message', async () => {
    mockFetchJson({ error: 'internal' }, 500);

    const adapter = new GatewayProviderAdapter({ baseUrl: 'https://example.com' });
    await expect(adapter.send({ messages: [{ role: 'user', content: 'Hi' }] }))
      .rejects.toThrow('HTTP 500');
  });

  it('4. empty choices — throws "empty choices"', async () => {
    mockFetchJson({ choices: [] });

    const adapter = new GatewayProviderAdapter({ baseUrl: 'https://example.com' });
    await expect(adapter.send({ messages: [{ role: 'user', content: 'Hi' }] }))
      .rejects.toThrow('empty choices');
  });

  it('5. systemPrompt is prepended as role:system message', async () => {
    mockFetchJson({
      choices: [{ message: { content: 'ok', tool_calls: null }, finish_reason: 'stop' }],
      usage:   {},
    });

    const adapter = new GatewayProviderAdapter({ baseUrl: 'https://example.com' });
    await adapter.send({ systemPrompt: 'You are X', messages: [{ role: 'user', content: 'Hi' }] });

    const fetchCall = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const requestBody = JSON.parse(fetchCall[1].body);
    expect(requestBody.messages[0].role).toBe('system');
    expect(requestBody.messages[0].content).toBe('You are X');
  });

  it('6. tools are translated to OpenAI function format', async () => {
    mockFetchJson({
      choices: [{ message: { content: 'ok', tool_calls: null }, finish_reason: 'stop' }],
      usage:   {},
    });

    const adapter = new GatewayProviderAdapter({ baseUrl: 'https://example.com' });
    await adapter.send({
      messages: [{ role: 'user', content: 'Hi' }],
      tools: [{ name: 'my_tool', description: 'Does X', inputSchema: { type: 'object' } }],
    });

    const fetchCall = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse(fetchCall[1].body);
    expect(body.tools[0].type).toBe('function');
    expect(body.tools[0].function.name).toBe('my_tool');
    expect(body.tools[0].function.parameters).toEqual({ type: 'object' });
  });

  it('7. no tools → no tools/tool_choice key in request body', async () => {
    mockFetchJson({
      choices: [{ message: { content: 'ok', tool_calls: null }, finish_reason: 'stop' }],
      usage:   {},
    });

    const adapter = new GatewayProviderAdapter({ baseUrl: 'https://example.com' });
    await adapter.send({ messages: [{ role: 'user', content: 'Hi' }] });

    const fetchCall = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse(fetchCall[1].body);
    expect(body.tools).toBeUndefined();
    expect(body.tool_choice).toBeUndefined();
  });

  it('8. cacheBreakpoint is silently ignored — message appears normally', async () => {
    mockFetchJson({
      choices: [{ message: { content: 'ok', tool_calls: null }, finish_reason: 'stop' }],
      usage:   {},
    });

    const adapter = new GatewayProviderAdapter({ baseUrl: 'https://example.com' });
    await expect(
      adapter.send({ messages: [{ role: 'user', content: 'Hi', cacheBreakpoint: true }] }),
    ).resolves.toBeDefined();

    const fetchCall = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse(fetchCall[1].body);
    expect(body.messages[0].content).toBe('Hi');
  });

  it('9. tool_result ContentBlock emitted as role:tool message', async () => {
    mockFetchJson({
      choices: [{ message: { content: 'ok', tool_calls: null }, finish_reason: 'stop' }],
      usage:   {},
    });

    const adapter = new GatewayProviderAdapter({ baseUrl: 'https://example.com' });
    await adapter.send({
      messages: [{
        role:    'user',
        content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'London' }],
      }],
    });

    const fetchCall = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse(fetchCall[1].body);
    const toolMsg = body.messages.find((m: { role: string }) => m.role === 'tool');
    expect(toolMsg).toBeDefined();
    expect(toolMsg.tool_call_id).toBe('call_1');
    expect(toolMsg.content).toBe('London');
  });

  it('10. image ContentBlock throws unsupported error', async () => {
    mockFetchJson({ choices: [], usage: {} });

    const adapter = new GatewayProviderAdapter({ baseUrl: 'https://example.com' });
    await expect(
      adapter.send({
        messages: [{
          role:    'user',
          content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'abc' } }],
        }],
      }),
    ).rejects.toThrow('image content blocks are not supported');
  });
});

// ---------------------------------------------------------------------------
// stream() tests
// ---------------------------------------------------------------------------

describe('GatewayProviderAdapter.stream', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('11. text chunks — yields delta strings and terminal done:true', async () => {
    mockFetchSse([
      'data: {"choices":[{"delta":{"role":"assistant","content":"The "},"finish_reason":null}]}',
      'data: {"choices":[{"delta":{"content":"answer"},"finish_reason":null}]}',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
      'data: [DONE]',
    ]);

    const adapter = new GatewayProviderAdapter({ baseUrl: 'https://example.com' });
    const chunks = [];
    for await (const c of adapter.stream({ messages: [{ role: 'user', content: 'Hi' }] })) {
      chunks.push(c);
    }

    const textChunks = chunks.filter(c => !c.done);
    expect(textChunks.map(c => c.delta)).toContain('The ');
    expect(textChunks.map(c => c.delta)).toContain('answer');
    expect(chunks[chunks.length - 1].done).toBe(true);
  });

  it('12. tool call buffered — no intermediate tool_use; final flushed before done', async () => {
    mockFetchSse([
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"tc_1","type":"function","function":{"name":"get_weather","arguments":"{\\"loc"}}]},"finish_reason":null}]}',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"ation\\":\\"London\\"}"}}]},"finish_reason":null}]}',
      'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
      'data: [DONE]',
    ]);

    const adapter = new GatewayProviderAdapter({ baseUrl: 'https://example.com' });
    const chunks = [];
    for await (const c of adapter.stream({ messages: [{ role: 'user', content: 'Weather?' }] })) {
      chunks.push(c);
    }

    const toolChunks = chunks.filter(c => !c.done && typeof c.delta !== 'string');
    expect(toolChunks).toHaveLength(1);

    const toolDelta = toolChunks[0].delta;
    if (typeof toolDelta !== 'string' && toolDelta.type === 'tool_use') {
      expect(toolDelta.name).toBe('get_weather');
      expect(toolDelta.input).toEqual({ location: 'London' });
    }
    expect(chunks[chunks.length - 1].done).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// createGatewayProviderAdapter() factory
// ---------------------------------------------------------------------------

describe('createGatewayProviderAdapter', () => {
  afterEach(() => {
    delete process.env['LLM_BASE_URL'];
    delete process.env['LLM_API_KEY'];
    delete process.env['LLM_MODEL'];
    delete process.env['LLM_TLS_REJECT_UNAUTHORIZED'];
  });

  it('13. throws when LLM_BASE_URL is missing', () => {
    delete process.env['LLM_BASE_URL'];
    expect(() => createGatewayProviderAdapter()).toThrow('LLM_BASE_URL');
  });

  it('14. constructs adapter successfully when LLM_BASE_URL is set', () => {
    process.env['LLM_BASE_URL']  = 'https://example.com';
    process.env['LLM_API_KEY']   = 'mykey';
    process.env['LLM_MODEL']     = 'my-model';
    expect(() => createGatewayProviderAdapter()).not.toThrow();
  });
});
