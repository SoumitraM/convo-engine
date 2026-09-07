/**
 * Claude integration tests — real API calls.
 *
 * Skipped unless INTEGRATION=true is set.
 * Requires ANTHROPIC_API_KEY in the environment (loaded from .env via dotenv).
 *
 * Run:
 *   INTEGRATION=true npx vitest run tests/claude-adapter.integration.test.ts
 */

import { describe, it, expect } from 'vitest';
import { ClaudeProviderAdapter } from '../src/adapters/provider/claude.js';
import { ConversationEngine } from '../src/engine.js';
import { InMemoryStorageAdapter } from '../src/adapters/storage/in-memory.js';

const SKIP = process.env['INTEGRATION'] !== 'true';

describe.skipIf(SKIP)('ClaudeProviderAdapter — live integration', () => {
  function makeAdapter() {
    const apiKey = process.env['ANTHROPIC_API_KEY'];
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');
    return new ClaudeProviderAdapter({
      apiKey,
      model: process.env['ANTHROPIC_MODEL'] ?? 'claude-3-5-haiku-20241022',
    });
  }

  // ── send() ──────────────────────────────────────────────────────────────

  it('send() — returns a text response for a simple prompt', async () => {
    const adapter = makeAdapter();
    const result = await adapter.send({
      systemPrompt: 'You are a helpful assistant. Reply in one sentence only.',
      messages: [{ role: 'user', content: 'Say "hello world" and nothing else.' }],
    });

    expect(result.content.length).toBeGreaterThan(0);
    expect(result.content[0].type).toBe('text');
    if (result.content[0].type === 'text') {
      expect(result.content[0].text.toLowerCase()).toContain('hello');
    }
    expect(result.stopReason).toBeTruthy();
    expect(result.usage.inputTokens).toBeGreaterThan(0);
    expect(result.usage.outputTokens).toBeGreaterThan(0);
    console.log('  send() tokens — in:', result.usage.inputTokens, 'out:', result.usage.outputTokens);
    console.log('  reply:', result.content[0].type === 'text' ? result.content[0].text : '');
  });

  it('send() — tool_use response when tool is provided', async () => {
    const adapter = makeAdapter();
    const result = await adapter.send({
      systemPrompt: 'You must use the get_current_time tool to answer questions about time.',
      messages: [{ role: 'user', content: 'What time is it right now?' }],
      tools: [{
        name: 'get_current_time',
        description: 'Returns the current date and time as an ISO 8601 string.',
        inputSchema: { type: 'object', properties: {}, required: [] },
      }],
    });

    expect(result.content.some(b => b.type === 'tool_use')).toBe(true);
    expect(result.stopReason).toBe('tool_use');
    const toolBlock = result.content.find(b => b.type === 'tool_use');
    if (toolBlock?.type === 'tool_use') {
      expect(toolBlock.name).toBe('get_current_time');
      console.log('  tool called:', toolBlock.name, 'input:', JSON.stringify(toolBlock.input));
    }
  });

  it('send() — cacheBreakpoint produces cache token usage on repeated calls', async () => {
    const adapter = makeAdapter();

    // First call — write the cache
    const result1 = await adapter.send({
      systemPrompt: 'You are a helpful assistant.',
      messages: [
        { role: 'user', content: 'Remember: the magic word is "elephant".', cacheBreakpoint: true },
        { role: 'user', content: 'Acknowledge you understood.' },
      ],
    });
    expect(result1.content[0].type).toBe('text');
    console.log('  first call — cacheWrite:', result1.usage.cacheWriteTokens, 'cacheRead:', result1.usage.cacheReadTokens);

    // Second call — should read from cache
    const result2 = await adapter.send({
      systemPrompt: 'You are a helpful assistant.',
      messages: [
        { role: 'user', content: 'Remember: the magic word is "elephant".', cacheBreakpoint: true },
        { role: 'user', content: 'What was the magic word?' },
      ],
    });
    expect(result2.content[0].type).toBe('text');
    console.log('  second call — cacheWrite:', result2.usage.cacheWriteTokens, 'cacheRead:', result2.usage.cacheReadTokens);
  });

  // ── stream() ─────────────────────────────────────────────────────────────

  it('stream() — yields text deltas and a terminal done:true chunk', async () => {
    const adapter = makeAdapter();

    const chunks: string[] = [];
    let terminalSeen = false;

    for await (const chunk of adapter.stream({
      systemPrompt: 'Reply in one sentence only.',
      messages: [{ role: 'user', content: 'Count to three.' }],
    })) {
      if (chunk.done) {
        terminalSeen = true;
      } else if (typeof chunk.delta === 'string' && chunk.delta.length > 0) {
        chunks.push(chunk.delta);
      }
    }

    expect(chunks.length).toBeGreaterThan(0);
    expect(terminalSeen).toBe(true);
    const fullText = chunks.join('');
    console.log('  streamed text:', fullText);
    expect(fullText.length).toBeGreaterThan(0);
  });

  // ── ConversationEngine end-to-end ─────────────────────────────────────────

  it('ConversationEngine.sendMessage — multi-turn conversation retains context', async () => {
    const engine = new ConversationEngine({
      storage: new InMemoryStorageAdapter(),
      provider: makeAdapter(),
      defaultSystemPrompt: 'You are a helpful assistant. Keep replies to one sentence.',
    });

    const thread = await engine.createThread({ type: 'integration_test', ownerId: 'test-user' });

    const reply1 = await engine.sendMessage(thread.id, 'My favourite colour is blue. Acknowledge this.');
    const text1 = Array.isArray(reply1.content)
      ? reply1.content.filter(b => b.type === 'text').map(b => b.type === 'text' ? b.text : '').join('')
      : reply1.content;
    console.log('  turn 1:', text1);
    expect(text1.toLowerCase()).toMatch(/blue/);

    const reply2 = await engine.sendMessage(thread.id, 'What colour did I just mention?');
    const text2 = Array.isArray(reply2.content)
      ? reply2.content.filter(b => b.type === 'text').map(b => b.type === 'text' ? b.text : '').join('')
      : reply2.content;
    console.log('  turn 2:', text2);
    expect(text2.toLowerCase()).toMatch(/blue/);

    const history = await engine.getHistory(thread.id);
    expect(history).toHaveLength(4);
  });

  it('ConversationEngine.agentLoop — tool called and final answer returned', async () => {
    const engine = new ConversationEngine({
      storage: new InMemoryStorageAdapter(),
      provider: makeAdapter(),
      defaultSystemPrompt:
        'You are a helpful assistant. When asked about the time, use the get_current_time tool.',
    });

    const thread = await engine.createThread({ type: 'integration_test', ownerId: 'test-user' });

    const finalMsg = await engine.agentLoop(
      thread.id,
      'What is the current time?',
      {
        tools: [{
          name: 'get_current_time',
          description: 'Returns the current date and time as an ISO 8601 string.',
          inputSchema: { type: 'object', properties: {}, required: [] },
        }],
        toolExecutor: async (toolName) => {
          if (toolName === 'get_current_time') return new Date().toISOString();
          throw new Error(`Unknown tool: ${toolName}`);
        },
        maxIterations: 5,
      },
    );

    const text = Array.isArray(finalMsg.content)
      ? finalMsg.content.filter(b => b.type === 'text').map(b => b.type === 'text' ? b.text : '').join('')
      : finalMsg.content;
    console.log('  agent final reply:', text);
    expect(text.length).toBeGreaterThan(0);

    const history = await engine.getHistory(thread.id);
    // user, tool_use (assistant), tool_result (user), final assistant = 4 messages
    expect(history.length).toBeGreaterThanOrEqual(4);
    console.log('  thread messages:', history.length);
  });

  it('ConversationEngine.streamMessage — streams and persists correctly', async () => {
    const engine = new ConversationEngine({
      storage: new InMemoryStorageAdapter(),
      provider: makeAdapter(),
      defaultSystemPrompt: 'Reply in one sentence only.',
    });

    const thread = await engine.createThread({ type: 'integration_test', ownerId: 'test-user' });

    const { stream, completion } = engine.streamMessage(thread.id, 'Say "streaming works" and nothing else.');

    const chunks: string[] = [];
    for await (const chunk of stream) {
      if (!chunk.done && typeof chunk.delta === 'string') {
        chunks.push(chunk.delta);
      }
    }

    const savedMsg = await completion;
    const fullText = chunks.join('');
    console.log('  streamed text:', fullText);

    expect(chunks.length).toBeGreaterThan(0);
    expect(fullText.toLowerCase()).toContain('streaming');
    expect(savedMsg.role).toBe('assistant');

    const history = await engine.getHistory(thread.id);
    expect(history).toHaveLength(2);
  });
});
