/**
 * ConversationEngine unit tests
 * Uses InMemoryStorageAdapter and a mock ProviderAdapter — no real API calls.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ConversationEngine, MaxIterationsExceededError } from '../src/engine.js';
import { InMemoryStorageAdapter } from '../src/adapters/storage/in-memory.js';
import type { ProviderAdapter, ProviderResponse, ProviderStreamChunk } from '../src/adapters/provider/types.js';
import type { ContentBlock } from '../src/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTextResponse(text: string): ProviderResponse {
  return {
    content: [{ type: 'text', text }],
    stopReason: 'stop',
    usage: { inputTokens: 10, outputTokens: 5 },
  };
}

function makeToolUseResponse(id: string, name: string, input: Record<string, unknown>): ProviderResponse {
  return {
    content: [{ type: 'tool_use', id, name, input }],
    stopReason: 'tool_use',
    usage: { inputTokens: 10, outputTokens: 5 },
  };
}

function makeMockProvider(responses: ProviderResponse[]): ProviderAdapter {
  let callCount = 0;
  return {
    send: vi.fn(async () => {
      const resp = responses[callCount] ?? responses[responses.length - 1];
      callCount++;
      return resp;
    }),
    stream: vi.fn(async function* (): AsyncIterable<ProviderStreamChunk> {
      yield { delta: 'Hello', done: false };
      yield { delta: ' world', done: false };
      yield { delta: '', done: true };
    }),
  };
}

/**
 * A provider whose stream() replays one scripted chunk sequence per call
 * (matching how a real adapter's stream() yields text deltas followed by
 * any tool_use ContentBlock deltas, then a terminal done:true — see
 * claude.ts/openai.ts/gateway.ts stream()). Used to test streamAgentLoop's
 * multi-iteration tool loop.
 */
function makeMockStreamingProvider(scripts: ProviderStreamChunk[][]): ProviderAdapter {
  let callCount = 0;
  return {
    send: vi.fn(async () => {
      throw new Error('send() should not be called by streamAgentLoop');
    }),
    stream: vi.fn(function (): AsyncIterable<ProviderStreamChunk> {
      const script = scripts[callCount] ?? scripts[scripts.length - 1];
      callCount++;
      return (async function* () {
        yield* script;
      })();
    }),
  };
}

// ---------------------------------------------------------------------------
// sendMessage
// ---------------------------------------------------------------------------

describe('ConversationEngine.sendMessage', () => {
  it('sends a message and returns the assistant reply', async () => {
    const storage = new InMemoryStorageAdapter();
    const provider = makeMockProvider([makeTextResponse('Hi there!')]);
    const engine = new ConversationEngine({ storage, provider });

    const thread = await engine.createThread({ type: 'test', ownerId: 'user1' });
    const reply = await engine.sendMessage(thread.id, 'Hello');

    expect(reply.role).toBe('assistant');
    const firstBlock = Array.isArray(reply.content) ? reply.content[0] : null;
    expect(firstBlock?.type).toBe('text');
    if (firstBlock?.type === 'text') expect(firstBlock.text).toBe('Hi there!');
  });

  it('persists user and assistant messages in the thread', async () => {
    const storage = new InMemoryStorageAdapter();
    const provider = makeMockProvider([makeTextResponse('Reply')]);
    const engine = new ConversationEngine({ storage, provider });

    const thread = await engine.createThread({ type: 'test', ownerId: 'user1' });
    await engine.sendMessage(thread.id, 'Hello');

    const history = await engine.getHistory(thread.id);
    expect(history).toHaveLength(2);
    expect(history[0].role).toBe('user');
    expect(history[1].role).toBe('assistant');
  });

  it('retains context across multiple turns', async () => {
    const storage = new InMemoryStorageAdapter();
    const provider = makeMockProvider([makeTextResponse('First'), makeTextResponse('Second')]);
    const engine = new ConversationEngine({ storage, provider });

    const thread = await engine.createThread({ type: 'test', ownerId: 'user1' });
    await engine.sendMessage(thread.id, 'Turn 1');
    await engine.sendMessage(thread.id, 'Turn 2');

    const history = await engine.getHistory(thread.id);
    expect(history).toHaveLength(4);
  });

  it('throws if thread does not exist', async () => {
    const storage = new InMemoryStorageAdapter();
    const provider = makeMockProvider([makeTextResponse('x')]);
    const engine = new ConversationEngine({ storage, provider });

    await expect(engine.sendMessage('nonexistent', 'Hello')).rejects.toThrow('thread nonexistent not found');
  });

  it('uses defaultSystemPrompt when no override is given', async () => {
    const storage = new InMemoryStorageAdapter();
    const sendSpy = vi.fn(async () => makeTextResponse('ok'));
    const provider: ProviderAdapter = { send: sendSpy, stream: vi.fn() as unknown as ProviderAdapter['stream'] };
    const engine = new ConversationEngine({ storage, provider, defaultSystemPrompt: 'Be helpful.' });

    const thread = await engine.createThread({ type: 'test', ownerId: 'user1' });
    await engine.sendMessage(thread.id, 'Hi');

    expect(sendSpy).toHaveBeenCalledWith(
      expect.objectContaining({ systemPrompt: 'Be helpful.' }),
    );
  });

  it('per-call systemPrompt overrides defaultSystemPrompt', async () => {
    const storage = new InMemoryStorageAdapter();
    const sendSpy = vi.fn(async () => makeTextResponse('ok'));
    const provider: ProviderAdapter = { send: sendSpy, stream: vi.fn() as unknown as ProviderAdapter['stream'] };
    const engine = new ConversationEngine({ storage, provider, defaultSystemPrompt: 'Default.' });

    const thread = await engine.createThread({ type: 'test', ownerId: 'user1' });
    await engine.sendMessage(thread.id, 'Hi', { systemPrompt: 'Override.' });

    expect(sendSpy).toHaveBeenCalledWith(
      expect.objectContaining({ systemPrompt: 'Override.' }),
    );
  });
});

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

describe('ConversationEngine hooks', () => {
  it('beforeSend can mutate systemPrompt', async () => {
    const storage = new InMemoryStorageAdapter();
    const sendSpy = vi.fn(async () => makeTextResponse('ok'));
    const provider: ProviderAdapter = { send: sendSpy, stream: vi.fn() as unknown as ProviderAdapter['stream'] };
    const engine = new ConversationEngine({
      storage,
      provider,
      hooks: {
        beforeSend: (ctx) => ({ ...ctx, systemPrompt: 'Mutated by hook.' }),
      },
    });

    const thread = await engine.createThread({ type: 'test', ownerId: 'u1' });
    await engine.sendMessage(thread.id, 'Hi');

    expect(sendSpy).toHaveBeenCalledWith(
      expect.objectContaining({ systemPrompt: 'Mutated by hook.' }),
    );
  });

  it('afterReceive fires after sendMessage with correct context', async () => {
    const storage = new InMemoryStorageAdapter();
    const provider = makeMockProvider([makeTextResponse('answer')]);
    const afterReceive = vi.fn();
    const engine = new ConversationEngine({ storage, provider, hooks: { afterReceive } });

    const thread = await engine.createThread({ type: 'test', ownerId: 'u1' });
    await engine.sendMessage(thread.id, 'question');

    expect(afterReceive).toHaveBeenCalledTimes(1);
    const ctx = afterReceive.mock.calls[0][0];
    expect(ctx.assistantMessage.role).toBe('assistant');
    expect(ctx.userMessage.role).toBe('user');
  });

  it('onError is called when beforeSend throws, and error propagates', async () => {
    const storage = new InMemoryStorageAdapter();
    const provider = makeMockProvider([makeTextResponse('x')]);
    const onError = vi.fn();
    const engine = new ConversationEngine({
      storage,
      provider,
      hooks: {
        beforeSend: () => { throw new Error('hook error'); },
        onError,
      },
    });

    const thread = await engine.createThread({ type: 'test', ownerId: 'u1' });
    await expect(engine.sendMessage(thread.id, 'Hi')).rejects.toThrow('hook error');
    expect(onError).toHaveBeenCalledWith(expect.any(Error), 'beforeSend');
  });

  it('afterReceive errors are swallowed and reported via onError', async () => {
    const storage = new InMemoryStorageAdapter();
    const provider = makeMockProvider([makeTextResponse('ok')]);
    const onError = vi.fn();
    const engine = new ConversationEngine({
      storage,
      provider,
      hooks: {
        afterReceive: () => { throw new Error('after error'); },
        onError,
      },
    });

    const thread = await engine.createThread({ type: 'test', ownerId: 'u1' });
    // Should NOT throw — afterReceive errors are swallowed
    await expect(engine.sendMessage(thread.id, 'Hi')).resolves.toBeDefined();
    expect(onError).toHaveBeenCalledWith(expect.any(Error), 'afterReceive');
  });
});

// ---------------------------------------------------------------------------
// streamMessage
// ---------------------------------------------------------------------------

describe('ConversationEngine.streamMessage', () => {
  it('yields text chunks and resolves completion with persisted message', async () => {
    const storage = new InMemoryStorageAdapter();
    const provider = makeMockProvider([makeTextResponse('unused')]);
    const engine = new ConversationEngine({ storage, provider });

    const thread = await engine.createThread({ type: 'test', ownerId: 'u1' });
    const { stream, completion } = engine.streamMessage(thread.id, 'Hi');

    const chunks: string[] = [];
    for await (const chunk of stream) {
      if (!chunk.done && typeof chunk.delta === 'string') {
        chunks.push(chunk.delta);
      }
    }

    const msg = await completion;

    expect(chunks).toContain('Hello');
    expect(chunks).toContain(' world');
    expect(msg.role).toBe('assistant');

    const history = await engine.getHistory(thread.id);
    expect(history).toHaveLength(2);
  });

  it('afterReceive fires exactly once after streamMessage completes', async () => {
    const storage = new InMemoryStorageAdapter();
    const provider = makeMockProvider([makeTextResponse('x')]);
    const afterReceive = vi.fn();
    const engine = new ConversationEngine({ storage, provider, hooks: { afterReceive } });

    const thread = await engine.createThread({ type: 'test', ownerId: 'u1' });
    const { stream, completion } = engine.streamMessage(thread.id, 'Hi');

    // Must consume stream for completion to resolve
    for await (const _ of stream) { /* drain */ }
    await completion;

    expect(afterReceive).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// agentLoop
// ---------------------------------------------------------------------------

describe('ConversationEngine.agentLoop', () => {
  it('single tool call: persists user, tool_use, tool_result, and final assistant messages', async () => {
    const storage = new InMemoryStorageAdapter();
    const provider = makeMockProvider([
      makeToolUseResponse('call_1', 'get_time', {}),
      makeTextResponse('It is noon.'),
    ]);
    const toolExecutor = vi.fn(async () => '12:00');
    const engine = new ConversationEngine({ storage, provider });

    const thread = await engine.createThread({ type: 'test', ownerId: 'u1' });
    const finalMsg = await engine.agentLoop(thread.id, 'What time is it?', {
      tools: [{ name: 'get_time', description: 'Get the current time', inputSchema: {} }],
      toolExecutor,
    });

    expect(finalMsg.role).toBe('assistant');
    const history = await engine.getHistory(thread.id);

    // user, tool_use (assistant), tool_result (user), final assistant
    expect(history).toHaveLength(4);
    expect(history[0].role).toBe('user');
    expect(history[1].role).toBe('assistant');
    expect(history[2].role).toBe('user');
    expect(history[3].role).toBe('assistant');

    // The tool_result message should have the result embedded
    const toolResultMsg = history[2];
    expect(Array.isArray(toolResultMsg.content)).toBe(true);
    const block = (toolResultMsg.content as ContentBlock[])[0];
    expect(block.type).toBe('tool_result');

    expect(toolExecutor).toHaveBeenCalledWith('get_time', {});
  });

  it('afterReceive fires exactly once on the final message, not on intermediate tool_use', async () => {
    const storage = new InMemoryStorageAdapter();
    const provider = makeMockProvider([
      makeToolUseResponse('c1', 'tool_a', {}),
      makeTextResponse('Done.'),
    ]);
    const afterReceive = vi.fn();
    const engine = new ConversationEngine({
      storage,
      provider,
      hooks: { afterReceive },
    });

    const thread = await engine.createThread({ type: 'test', ownerId: 'u1' });
    await engine.agentLoop(thread.id, 'Go', {
      tools: [{ name: 'tool_a', description: 'x', inputSchema: {} }],
      toolExecutor: async () => 'result',
    });

    expect(afterReceive).toHaveBeenCalledTimes(1);
  });

  it('beforeSend fires on every iteration', async () => {
    const storage = new InMemoryStorageAdapter();
    const provider = makeMockProvider([
      makeToolUseResponse('c1', 'tool_a', {}),
      makeToolUseResponse('c2', 'tool_a', {}),
      makeTextResponse('Done.'),
    ]);
    const beforeSend = vi.fn((ctx) => ctx);
    const engine = new ConversationEngine({
      storage,
      provider,
      hooks: { beforeSend },
    });

    const thread = await engine.createThread({ type: 'test', ownerId: 'u1' });
    await engine.agentLoop(thread.id, 'Go', {
      tools: [{ name: 'tool_a', description: 'x', inputSchema: {} }],
      toolExecutor: async () => 'result',
    });

    // Should be called once per loop iteration: 3 total (2 tool_use + 1 final)
    expect(beforeSend).toHaveBeenCalledTimes(3);
  });

  it('toolExecutor throws: onError called with toolExecutor phase, error propagates', async () => {
    const storage = new InMemoryStorageAdapter();
    const provider = makeMockProvider([makeToolUseResponse('c1', 'bad_tool', {})]);
    const onError = vi.fn();
    const engine = new ConversationEngine({ storage, provider, hooks: { onError } });

    const thread = await engine.createThread({ type: 'test', ownerId: 'u1' });
    await expect(
      engine.agentLoop(thread.id, 'Go', {
        tools: [{ name: 'bad_tool', description: 'x', inputSchema: {} }],
        toolExecutor: async () => { throw new Error('tool failure'); },
      }),
    ).rejects.toThrow('tool failure');

    expect(onError).toHaveBeenCalledWith(expect.any(Error), 'toolExecutor');
  });

  it('throws MaxIterationsExceededError when loop runs too long', async () => {
    const storage = new InMemoryStorageAdapter();
    // Always returns tool_use — will loop forever if not bounded
    const provider = makeMockProvider(
      Array(15).fill(makeToolUseResponse('c1', 'tool_a', {})),
    );
    const engine = new ConversationEngine({ storage, provider });

    const thread = await engine.createThread({ type: 'test', ownerId: 'u1' });
    await expect(
      engine.agentLoop(thread.id, 'Go', {
        tools: [{ name: 'tool_a', description: 'x', inputSchema: {} }],
        toolExecutor: async () => 'result',
        maxIterations: 3,
      }),
    ).rejects.toThrow(MaxIterationsExceededError);
  });
});

// ---------------------------------------------------------------------------
// streamAgentLoop
// ---------------------------------------------------------------------------

describe('ConversationEngine.streamAgentLoop', () => {
  it('streams text-only turns like streamMessage and persists the final message', async () => {
    const storage = new InMemoryStorageAdapter();
    const provider = makeMockStreamingProvider([
      [
        { delta: 'It is ', done: false },
        { delta: 'noon.', done: false },
        { delta: '', done: true },
      ],
    ]);
    const engine = new ConversationEngine({ storage, provider });

    const thread = await engine.createThread({ type: 'test', ownerId: 'u1' });
    const { stream, completion } = engine.streamAgentLoop(thread.id, 'What time is it?', {
      tools: [{ name: 'get_time', description: 'Get the current time', inputSchema: {} }],
      toolExecutor: vi.fn(async () => '12:00'),
    });

    const chunks: ProviderStreamChunk[] = [];
    for await (const chunk of stream) chunks.push(chunk);
    const finalMsg = await completion;

    expect(chunks.filter(c => !c.done).map(c => c.delta)).toEqual(['It is ', 'noon.']);
    // Exactly one done:true for the whole turn
    expect(chunks.filter(c => c.done)).toHaveLength(1);
    expect(chunks[chunks.length - 1].done).toBe(true);

    expect(finalMsg.role).toBe('assistant');
    const history = await engine.getHistory(thread.id);
    expect(history).toHaveLength(2); // user, assistant
  });

  it('streams across a tool call without an intermediate done:true, then resolves', async () => {
    const storage = new InMemoryStorageAdapter();
    const provider = makeMockStreamingProvider([
      [
        { delta: 'Let me check.', done: false },
        { delta: { type: 'tool_use', id: 'call_1', name: 'get_time', input: {} }, done: false },
        { delta: '', done: true },
      ],
      [
        { delta: 'It is noon.', done: false },
        { delta: '', done: true },
      ],
    ]);
    const toolExecutor = vi.fn(async () => '12:00');
    const engine = new ConversationEngine({ storage, provider });

    const thread = await engine.createThread({ type: 'test', ownerId: 'u1' });
    const { stream, completion } = engine.streamAgentLoop(thread.id, 'What time is it?', {
      tools: [{ name: 'get_time', description: 'Get the current time', inputSchema: {} }],
      toolExecutor,
    });

    const chunks: ProviderStreamChunk[] = [];
    for await (const chunk of stream) chunks.push(chunk);
    const finalMsg = await completion;

    // Only one done:true across both iterations, and it's the last chunk
    expect(chunks.filter(c => c.done)).toHaveLength(1);
    expect(chunks[chunks.length - 1].done).toBe(true);

    const textDeltas = chunks.filter(c => !c.done && typeof c.delta === 'string').map(c => c.delta);
    expect(textDeltas).toEqual(['Let me check.', 'It is noon.']);

    expect(toolExecutor).toHaveBeenCalledWith('get_time', {});
    expect(finalMsg.role).toBe('assistant');

    // user, assistant(text+tool_use), tool_result(user), final assistant
    const history = await engine.getHistory(thread.id);
    expect(history).toHaveLength(4);
    expect(history[1].role).toBe('assistant');
    expect(Array.isArray(history[1].content)).toBe(true);
    const iterationOneBlocks = history[1].content as ContentBlock[];
    expect(iterationOneBlocks.map(b => b.type)).toEqual(['text', 'tool_use']);
    expect(history[2].role).toBe('user');
    expect((history[2].content as ContentBlock[])[0].type).toBe('tool_result');
  });

  it('afterReceive fires exactly once, on the final message only', async () => {
    const storage = new InMemoryStorageAdapter();
    const provider = makeMockStreamingProvider([
      [{ delta: { type: 'tool_use', id: 'c1', name: 'tool_a', input: {} }, done: false }, { delta: '', done: true }],
      [{ delta: 'Done.', done: false }, { delta: '', done: true }],
    ]);
    const afterReceive = vi.fn();
    const engine = new ConversationEngine({ storage, provider, hooks: { afterReceive } });

    const thread = await engine.createThread({ type: 'test', ownerId: 'u1' });
    const { stream, completion } = engine.streamAgentLoop(thread.id, 'Go', {
      tools: [{ name: 'tool_a', description: 'x', inputSchema: {} }],
      toolExecutor: async () => 'result',
    });

    for await (const _ of stream) { /* drain */ }
    await completion;

    expect(afterReceive).toHaveBeenCalledTimes(1);
  });

  it('toolExecutor throws: onError called with toolExecutor phase, completion rejects', async () => {
    const storage = new InMemoryStorageAdapter();
    const provider = makeMockStreamingProvider([
      [{ delta: { type: 'tool_use', id: 'c1', name: 'bad_tool', input: {} }, done: false }, { delta: '', done: true }],
    ]);
    const onError = vi.fn();
    const engine = new ConversationEngine({ storage, provider, hooks: { onError } });

    const thread = await engine.createThread({ type: 'test', ownerId: 'u1' });
    const { stream, completion } = engine.streamAgentLoop(thread.id, 'Go', {
      tools: [{ name: 'bad_tool', description: 'x', inputSchema: {} }],
      toolExecutor: async () => { throw new Error('tool failure'); },
    });

    await expect((async () => { for await (const _ of stream) { /* drain */ } })()).rejects.toThrow('tool failure');
    await expect(completion).rejects.toThrow('tool failure');
    expect(onError).toHaveBeenCalledWith(expect.any(Error), 'toolExecutor');
  });

  it('throws MaxIterationsExceededError when the tool loop runs too long', async () => {
    const storage = new InMemoryStorageAdapter();
    const toolUseScript: ProviderStreamChunk[] = [
      { delta: { type: 'tool_use', id: 'c1', name: 'tool_a', input: {} }, done: false },
      { delta: '', done: true },
    ];
    const provider = makeMockStreamingProvider(Array(15).fill(toolUseScript));
    const engine = new ConversationEngine({ storage, provider });

    const thread = await engine.createThread({ type: 'test', ownerId: 'u1' });
    const { stream, completion } = engine.streamAgentLoop(thread.id, 'Go', {
      tools: [{ name: 'tool_a', description: 'x', inputSchema: {} }],
      toolExecutor: async () => 'result',
      maxIterations: 3,
    });

    await expect((async () => { for await (const _ of stream) { /* drain */ } })()).rejects.toThrow(
      MaxIterationsExceededError,
    );
    await expect(completion).rejects.toThrow(MaxIterationsExceededError);
  });
});
