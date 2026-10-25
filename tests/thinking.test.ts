/**
 * R6 — thinking models: thinkingHistory, stop reasons, streamed responses,
 * usage. Uses InMemoryStorageAdapter and mock providers — no real API calls.
 */

import { describe, it, expect, vi } from 'vitest';
import { ConversationEngine } from '../src/engine.js';
import { InMemoryStorageAdapter } from '../src/adapters/storage/in-memory.js';
import { applyThinkingHistory } from '../src/context/thinking-history.js';
import type {
  ProviderAdapter,
  ProviderInput,
  ProviderMessage,
  ProviderResponse,
  ProviderStreamChunk,
} from '../src/adapters/provider/types.js';
import type { ContentBlock } from '../src/types.js';
import { IncompleteResponseError, RefusalError } from '../src/errors.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TOOL = { name: 'record_quantity', description: 'Record', inputSchema: { type: 'object' } };
const think = (sig: string): ContentBlock => ({ type: 'thinking', thinking: '', signature: sig });

function resp(
  content: ContentBlock[],
  stopReason: string,
  extra: Partial<ProviderResponse> = {},
): ProviderResponse {
  return { content, stopReason, usage: { inputTokens: 100, outputTokens: 20 }, ...extra };
}

function makeSendProvider(responses: ProviderResponse[]): ProviderAdapter & { inputs: ProviderInput[] } {
  const inputs: ProviderInput[] = [];
  let i = 0;
  return {
    name: 'claude',
    inputs,
    send: vi.fn(async (input: ProviderInput) => {
      // Snapshot: the engine must not hand the adapter stored arrays it later mutates.
      inputs.push(structuredClone(input));
      return responses[Math.min(i++, responses.length - 1)];
    }),
    stream: vi.fn(),
  };
}

/** A provider whose stream() supplies the complete response on the done chunk. */
function makeStreamProvider(
  scripts: { deltas: string[]; response: ProviderResponse }[],
): ProviderAdapter & { inputs: ProviderInput[] } {
  const inputs: ProviderInput[] = [];
  let i = 0;
  return {
    name: 'claude',
    inputs,
    send: vi.fn(),
    stream: vi.fn((input: ProviderInput): AsyncIterable<ProviderStreamChunk> => {
      inputs.push(structuredClone(input));
      const script = scripts[Math.min(i++, scripts.length - 1)];
      return (async function* () {
        yield { delta: '', done: false, thinking: true };
        for (const d of script.deltas) yield { delta: d, done: false };
        for (const b of script.response.content) {
          if (b.type === 'tool_use') yield { delta: b, done: false };
        }
        yield { delta: '', done: true, response: script.response };
      })();
    }),
  };
}

function thinkingSignatures(messages: ProviderMessage[]): string[] {
  return messages.flatMap(m =>
    typeof m.content === 'string'
      ? []
      : m.content.flatMap(b => (b.type === 'thinking' ? [b.signature] : [])),
  );
}

async function drain(stream: AsyncIterable<ProviderStreamChunk>): Promise<ProviderStreamChunk[]> {
  const chunks: ProviderStreamChunk[] = [];
  for await (const c of stream) chunks.push(c);
  return chunks;
}

// Turn 1: tool round then answer. Turn 2: tool round then answer.
function twoTurnResponses(): ProviderResponse[] {
  return [
    resp([think('t1a'), { type: 'tool_use', id: 'u1', name: 'record_quantity', input: { n: 140 } }], 'tool_use'),
    resp([think('t1b'), { type: 'text', text: 'done' }], 'end_turn'),
    resp([think('t2a'), { type: 'tool_use', id: 'u2', name: 'record_quantity', input: { n: 63 } }], 'tool_use'),
    resp([think('t2b'), { type: 'text', text: 'ok' }], 'end_turn'),
  ];
}

// ---------------------------------------------------------------------------
// applyThinkingHistory
// ---------------------------------------------------------------------------

describe('applyThinkingHistory', () => {
  const history: ProviderMessage[] = [
    { role: 'user', content: 'turn 1' },
    { role: 'assistant', content: [think('a'), { type: 'tool_use', id: 'u1', name: 'x', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'u1', content: 'r' }] },
    { role: 'assistant', content: [think('b'), { type: 'text', text: 'answer 1' }], cacheBreakpoint: true },
    { role: 'user', content: 'turn 2' },
    { role: 'assistant', content: [think('c'), { type: 'tool_use', id: 'u2', name: 'x', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'u2', content: 'r' }] },
  ];

  it("'all' returns the messages unchanged", () => {
    expect(applyThinkingHistory(history, 'all')).toBe(history);
  });

  it("'current-turn' strips earlier turns' thinking and keeps the current turn's", () => {
    const out = applyThinkingHistory(history, 'current-turn');
    expect(thinkingSignatures(out)).toEqual(['c']);
    expect(out).toHaveLength(history.length);
    expect(out[3].cacheBreakpoint).toBe(true);
    // Input untouched.
    expect(thinkingSignatures(history)).toEqual(['a', 'b', 'c']);
  });

  it("'none' strips every thinking block, redacted included", () => {
    const withRedacted: ProviderMessage[] = [
      ...history,
      { role: 'assistant', content: [{ type: 'redacted_thinking', data: 'x' }, { type: 'text', text: 'y' }] },
    ];
    const out = applyThinkingHistory(withRedacted, 'none');
    expect(out.every(m => typeof m.content === 'string' ||
      m.content.every(b => b.type !== 'thinking' && b.type !== 'redacted_thinking'))).toBe(true);
  });

  it('removes a message left empty and moves its cache breakpoint back', () => {
    const msgs: ProviderMessage[] = [
      { role: 'user', content: 'q' },
      { role: 'assistant', content: [think('only')], cacheBreakpoint: true },
      { role: 'user', content: 'q2' },
    ];
    const out = applyThinkingHistory(msgs, 'current-turn');
    expect(out).toEqual([
      { role: 'user', content: 'q', cacheBreakpoint: true },
      { role: 'user', content: 'q2' },
    ]);
  });
});

// ---------------------------------------------------------------------------
// thinkingHistory through the engine (R6.4)
// ---------------------------------------------------------------------------

describe('engine thinkingHistory', () => {
  async function runTwoTurns(engineMode?: 'all' | 'current-turn' | 'none', callMode?: 'all' | 'current-turn' | 'none') {
    const storage = new InMemoryStorageAdapter();
    const provider = makeSendProvider(twoTurnResponses());
    const engine = new ConversationEngine({ storage, provider, thinkingHistory: engineMode });
    const thread = await engine.createThread({ type: 't', ownerId: 'o' });
    const opts = { tools: [TOOL], toolExecutor: async () => 'recorded', thinkingHistory: callMode };
    await engine.agentLoop(thread.id, 'We counted 140 cartons.', opts);
    await engine.agentLoop(thread.id, 'Now 63 crushed cartons too.', opts);
    return { provider, history: await engine.getHistory(thread.id) };
  }

  it("default 'all' replays every stored thinking block", async () => {
    const { provider } = await runTwoTurns();
    // 4th call: turn 2's second iteration.
    expect(thinkingSignatures(provider.inputs[3].messages)).toEqual(['t1a', 't1b', 't2a']);
  });

  it("'current-turn' strips turn 1's thinking, keeps turn 2's, and leaves storage intact", async () => {
    const { provider, history } = await runTwoTurns('current-turn');
    expect(thinkingSignatures(provider.inputs[1].messages)).toEqual(['t1a']); // within turn 1
    expect(thinkingSignatures(provider.inputs[2].messages)).toEqual([]);
    expect(thinkingSignatures(provider.inputs[3].messages)).toEqual(['t2a']);

    const stored = history.flatMap(m =>
      typeof m.content === 'string' ? [] : m.content.filter(b => b.type === 'thinking'));
    expect(stored).toHaveLength(4);
  });

  it("'none' strips all thinking; a per-call value overrides the engine's", async () => {
    const { provider } = await runTwoTurns('current-turn', 'none');
    expect(provider.inputs.every(i => thinkingSignatures(i.messages).length === 0)).toBe(true);
  });

  it('passes thinking/effort/blockBinding through to the provider, and beforeSend can change them', async () => {
    const storage = new InMemoryStorageAdapter();
    const provider = makeSendProvider([resp([{ type: 'text', text: 'hi' }], 'end_turn')]);
    const engine = new ConversationEngine({
      storage,
      provider,
      hooks: { beforeSend: ctx => ({ ...ctx, effort: ctx.effort === 'low' ? 'high' : ctx.effort }) },
    });
    const thread = await engine.createThread({ type: 't', ownerId: 'o' });

    await engine.sendMessage(thread.id, 'q', {
      thinking: { type: 'adaptive', display: 'summarized' }, effort: 'low', blockBinding: 'error',
    });
    expect(provider.inputs[0]).toMatchObject({
      thinking: { type: 'adaptive', display: 'summarized' }, effort: 'high', blockBinding: 'error',
    });

    await engine.sendMessage(thread.id, 'q2');
    expect(provider.inputs[1]).not.toHaveProperty('thinking');
    expect(provider.inputs[1]).not.toHaveProperty('effort');
  });
});

// ---------------------------------------------------------------------------
// Stop reasons (R6.6) and usage (R6.7)
// ---------------------------------------------------------------------------

describe('engine stop reasons', () => {
  async function setup(responses: ProviderResponse[]) {
    const storage = new InMemoryStorageAdapter();
    const provider = makeSendProvider(responses);
    const onError = vi.fn();
    const afterProviderCall = vi.fn();
    const afterReceive = vi.fn();
    const engine = new ConversationEngine({
      storage, provider, hooks: { onError, afterProviderCall, afterReceive },
    });
    const thread = await engine.createThread({ type: 't', ownerId: 'o' });
    return { engine, thread, onError, afterProviderCall, afterReceive };
  }

  it('refusal: agentLoop throws RefusalError, stores nothing for the assistant', async () => {
    const { engine, thread, onError, afterProviderCall, afterReceive } = await setup([
      resp([], 'refusal', { stopDetails: { category: 'cyber' } }),
    ]);
    const err = await engine
      .agentLoop(thread.id, 'q', { tools: [TOOL], toolExecutor: async () => 'x' })
      .catch(e => e);

    expect(err).toBeInstanceOf(RefusalError);
    expect(err.retryable).toBe(false);
    expect(err.category).toBe('cyber');
    expect(err.provider).toBe('claude');
    const history = await engine.getHistory(thread.id);
    expect(history.map(m => m.role)).toEqual(['user']);
    expect(onError).toHaveBeenCalledWith(err, 'provider');
    expect(afterProviderCall).toHaveBeenCalledTimes(1);
    expect(afterProviderCall.mock.calls[0][0].assistantMessage).toBeUndefined();
    expect(afterReceive).not.toHaveBeenCalled();
  });

  it('refusal: sendMessage throws too', async () => {
    const { engine, thread } = await setup([resp([{ type: 'text', text: 'part' }], 'refusal')]);
    await expect(engine.sendMessage(thread.id, 'q')).rejects.toBeInstanceOf(RefusalError);
  });

  it('max_tokens with thinking only: IncompleteResponseError, nothing stored', async () => {
    const { engine, thread } = await setup([resp([think('s')], 'max_tokens')]);
    const err = await engine
      .agentLoop(thread.id, 'q', { tools: [TOOL], toolExecutor: async () => 'x' })
      .catch(e => e);
    expect(err).toBeInstanceOf(IncompleteResponseError);
    expect(err.stopReason).toBe('max_tokens');
    expect((await engine.getHistory(thread.id)).map(m => m.role)).toEqual(['user']);
  });

  it('max_tokens mid tool call: IncompleteResponseError (a stored tool_use would break the next turn)', async () => {
    const { engine, thread } = await setup([
      resp([{ type: 'text', text: 'Recording' }, { type: 'tool_use', id: 'u', name: 'record_quantity', input: {} }], 'max_tokens'),
    ]);
    await expect(engine.agentLoop(thread.id, 'q', { tools: [TOOL], toolExecutor: async () => 'x' }))
      .rejects.toBeInstanceOf(IncompleteResponseError);
  });

  it('max_tokens with text: stored and returned, with metadata.stopReason', async () => {
    const { engine, thread } = await setup([resp([think('s'), { type: 'text', text: 'cut o' }], 'max_tokens')]);
    const msg = await engine.agentLoop(thread.id, 'q', { tools: [TOOL], toolExecutor: async () => 'x' });
    expect(msg.metadata).toEqual({ stopReason: 'max_tokens', usage: { inputTokens: 100, outputTokens: 20 } });
  });

  it('pause_turn: agentLoop stores the partial turn and calls the provider again', async () => {
    const { engine, thread } = await setup([
      resp([{ type: 'text', text: 'working' }], 'pause_turn'),
      resp([{ type: 'text', text: 'finished' }], 'end_turn'),
    ]);
    const msg = await engine.agentLoop(thread.id, 'q', { tools: [TOOL], toolExecutor: async () => 'x' });
    expect(msg.content).toEqual([{ type: 'text', text: 'finished' }]);
    expect((await engine.getHistory(thread.id)).map(m => m.role)).toEqual(['user', 'assistant', 'assistant']);
  });

  it('records stopReason and usage on every stored assistant message, and afterProviderCall per call', async () => {
    const { engine, thread, afterProviderCall, afterReceive } = await setup(twoTurnResponses());
    await engine.agentLoop(thread.id, 'q', { tools: [TOOL], toolExecutor: async () => 'x' });

    const assistants = (await engine.getHistory(thread.id)).filter(m => m.role === 'assistant');
    expect(assistants.map(m => m.metadata?.['stopReason'])).toEqual(['tool_use', 'end_turn']);
    expect(afterProviderCall).toHaveBeenCalledTimes(2);
    expect(afterProviderCall.mock.calls.map(c => c[0].iteration)).toEqual([1, 2]);
    expect(afterProviderCall.mock.calls[0][0].response.usage.inputTokens).toBe(100);
    expect(afterReceive).toHaveBeenCalledTimes(1);
  });

  it('afterProviderCall errors go to onError and do not propagate', async () => {
    const storage = new InMemoryStorageAdapter();
    const onError = vi.fn();
    const engine = new ConversationEngine({
      storage,
      provider: makeSendProvider([resp([{ type: 'text', text: 'hi' }], 'end_turn')]),
      hooks: { onError, afterProviderCall: () => { throw new Error('meter down'); } },
    });
    const thread = await engine.createThread({ type: 't', ownerId: 'o' });
    await expect(engine.sendMessage(thread.id, 'q')).resolves.toBeDefined();
    expect(onError).toHaveBeenCalledWith(expect.any(Error), 'afterProviderCall');
  });

  it("a custom adapter without a name labels engine errors 'custom'", async () => {
    const storage = new InMemoryStorageAdapter();
    const provider: ProviderAdapter = {
      send: async () => resp([], 'refusal'),
      stream: vi.fn(),
    };
    const engine = new ConversationEngine({ storage, provider });
    const thread = await engine.createThread({ type: 't', ownerId: 'o' });
    const err = await engine.sendMessage(thread.id, 'q').catch(e => e);
    expect(err.provider).toBe('custom');
  });
});

// ---------------------------------------------------------------------------
// Streaming (R6.2)
// ---------------------------------------------------------------------------

describe('engine streaming with a final response', () => {
  it('streamMessage stores the response blocks as-is and afterReceive sees real stopReason/usage', async () => {
    const storage = new InMemoryStorageAdapter();
    const final = resp([think('s1'), { type: 'text', text: 'Hello world' }], 'end_turn', {
      usage: { inputTokens: 321, outputTokens: 9, cacheReadTokens: 300 },
    });
    const provider = makeStreamProvider([{ deltas: ['Hello', ' world'], response: final }]);
    const afterReceive = vi.fn();
    const engine = new ConversationEngine({ storage, provider, hooks: { afterReceive } });
    const thread = await engine.createThread({ type: 't', ownerId: 'o' });

    const { stream, completion } = engine.streamMessage(thread.id, 'Hi', { effort: 'low' });
    const chunks = await drain(stream);
    const msg = await completion;

    expect(chunks.some(c => c.thinking)).toBe(true);
    expect(msg.content).toEqual(final.content);
    expect(msg.metadata).toEqual({ stopReason: 'end_turn', usage: final.usage });
    expect(afterReceive.mock.calls[0][0].rawResponse).toBe(final);
    expect(provider.inputs[0].effort).toBe('low');
  });

  it('streamAgentLoop stores each iteration’s blocks with their thinking, and loops on tool_use', async () => {
    const storage = new InMemoryStorageAdapter();
    const r1 = resp(
      [think('a'), { type: 'text', text: 'Recording.' }, { type: 'tool_use', id: 'u1', name: 'record_quantity', input: {} }],
      'tool_use',
    );
    const r2 = resp([think('b'), { type: 'text', text: 'done' }], 'end_turn', {
      usage: { inputTokens: 500, outputTokens: 4 },
    });
    const provider = makeStreamProvider([
      { deltas: ['Recording.'], response: r1 },
      { deltas: ['done'], response: r2 },
    ]);
    const afterReceive = vi.fn();
    const afterProviderCall = vi.fn();
    const engine = new ConversationEngine({
      storage, provider, thinkingHistory: 'current-turn', hooks: { afterReceive, afterProviderCall },
    });
    const thread = await engine.createThread({ type: 't', ownerId: 'o' });

    const toolExecutor = vi.fn(async () => 'recorded');
    const { stream, completion } = engine.streamAgentLoop(thread.id, 'q', { tools: [TOOL], toolExecutor });
    const chunks = await drain(stream);
    await completion;

    expect(chunks.filter(c => c.done)).toHaveLength(1);
    expect(chunks[chunks.length - 1].response).toBe(r2);
    expect(toolExecutor).toHaveBeenCalledTimes(1);

    const history = await engine.getHistory(thread.id);
    expect(history[1].content).toEqual(r1.content);
    expect(history[3].content).toEqual(r2.content);
    // The current turn's thinking is replayed inside the loop.
    expect(thinkingSignatures(provider.inputs[1].messages)).toEqual(['a']);
    expect(afterReceive.mock.calls[0][0].rawResponse.usage.inputTokens).toBe(500);
    expect(afterProviderCall).toHaveBeenCalledTimes(2);
  });

  it('streamMessage refusal: completion rejects with RefusalError and nothing is stored', async () => {
    const storage = new InMemoryStorageAdapter();
    const provider = makeStreamProvider([
      { deltas: ['I'], response: resp([{ type: 'text', text: 'I' }], 'refusal', { stopDetails: { category: 'bio' } }) },
    ]);
    const engine = new ConversationEngine({ storage, provider });
    const thread = await engine.createThread({ type: 't', ownerId: 'o' });

    const { stream, completion } = engine.streamMessage(thread.id, 'q');
    completion.catch(() => {});
    await expect(drain(stream)).rejects.toBeInstanceOf(RefusalError);
    await expect(completion).rejects.toMatchObject({ category: 'bio' });
    expect((await engine.getHistory(thread.id)).map(m => m.role)).toEqual(['user']);
  });

  it('streamMessage without a final response keeps the text when a tool_use block also arrives', async () => {
    const storage = new InMemoryStorageAdapter();
    const provider: ProviderAdapter = {
      send: vi.fn(),
      stream: async function* () {
        yield { delta: 'Checking', done: false };
        yield { delta: { type: 'tool_use', id: 'u', name: 'x', input: {} }, done: false };
        yield { delta: '', done: true };
      },
    };
    const engine = new ConversationEngine({ storage, provider });
    const thread = await engine.createThread({ type: 't', ownerId: 'o' });
    const { stream, completion } = engine.streamMessage(thread.id, 'q');
    await drain(stream);
    expect((await completion).content).toEqual([
      { type: 'text', text: 'Checking' },
      { type: 'tool_use', id: 'u', name: 'x', input: {} },
    ]);
  });
});
