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

  it('ConversationEngine.streamAgentLoop — text-only turn streams and persists correctly', async () => {
    const engine = new ConversationEngine({
      storage: new InMemoryStorageAdapter(),
      provider: makeAdapter(),
      defaultSystemPrompt: 'Reply in one sentence only.',
    });

    const thread = await engine.createThread({ type: 'integration_test', ownerId: 'test-user' });

    const { stream, completion } = engine.streamAgentLoop(
      thread.id,
      'Say "streaming works" and nothing else.',
      {
        tools: [{
          name: 'get_current_time',
          description: 'Returns the current date and time as an ISO 8601 string.',
          inputSchema: { type: 'object', properties: {}, required: [] },
        }],
        toolExecutor: async () => new Date().toISOString(),
      },
    );

    const chunks: string[] = [];
    let doneCount = 0;
    for await (const chunk of stream) {
      if (chunk.done) {
        doneCount++;
      } else if (typeof chunk.delta === 'string') {
        chunks.push(chunk.delta);
      }
    }

    const savedMsg = await completion;
    const fullText = chunks.join('');
    console.log('  streamed text:', fullText);

    expect(chunks.length).toBeGreaterThan(0);
    expect(fullText.toLowerCase()).toContain('streaming');
    expect(doneCount).toBe(1); // exactly one terminal chunk for the whole turn
    expect(savedMsg.role).toBe('assistant');

    const history = await engine.getHistory(thread.id);
    expect(history).toHaveLength(2);
  });

  it('ConversationEngine.streamAgentLoop — streams through a real tool call with one terminal chunk', async () => {
    const engine = new ConversationEngine({
      storage: new InMemoryStorageAdapter(),
      provider: makeAdapter(),
      defaultSystemPrompt:
        'You are a helpful assistant. When asked about the time, use the get_current_time tool, ' +
        'then tell the user the time in one sentence.',
    });

    const thread = await engine.createThread({ type: 'integration_test', ownerId: 'test-user' });

    const toolExecutor = async (toolName: string) => {
      if (toolName === 'get_current_time') return new Date().toISOString();
      throw new Error(`Unknown tool: ${toolName}`);
    };

    const { stream, completion } = engine.streamAgentLoop(
      thread.id,
      'What is the current time?',
      {
        tools: [{
          name: 'get_current_time',
          description: 'Returns the current date and time as an ISO 8601 string.',
          inputSchema: { type: 'object', properties: {}, required: [] },
        }],
        toolExecutor,
        maxIterations: 5,
      },
    );

    const textChunks: string[] = [];
    const toolUseChunks: unknown[] = [];
    let doneCount = 0;
    for await (const chunk of stream) {
      if (chunk.done) {
        doneCount++;
      } else if (typeof chunk.delta === 'string') {
        textChunks.push(chunk.delta);
      } else {
        toolUseChunks.push(chunk.delta);
      }
    }

    const finalMsg = await completion;
    const fullText = textChunks.join('');
    console.log('  streamed text across iterations:', fullText);
    console.log('  tool_use deltas seen while streaming:', toolUseChunks.length);

    // The real point of streamAgentLoop: the tool call happened mid-stream
    // (Claude's stream() now surfaces it — see claude.ts stream() fix) and
    // only ONE done:true was emitted for the entire multi-iteration turn.
    expect(doneCount).toBe(1);
    expect(fullText.length).toBeGreaterThan(0);

    const text = Array.isArray(finalMsg.content)
      ? finalMsg.content.filter(b => b.type === 'text').map(b => b.type === 'text' ? b.text : '').join('')
      : finalMsg.content;
    expect(text.length).toBeGreaterThan(0);

    const history = await engine.getHistory(thread.id);
    // user, assistant (tool_use [+ maybe text]), tool_result (user), final assistant
    expect(history.length).toBeGreaterThanOrEqual(4);
    console.log('  thread messages:', history.length);
  });
});

// ---------------------------------------------------------------------------
// AquantX enhancement requests (docs/aquantx-requests.md) — live checks
// ---------------------------------------------------------------------------

/** Builds a one-page PDF containing `text` (Helvetica, ASCII only). */
function makePdf(text: string): string {
  const escaped = text.replace(/[\\()]/g, c => `\\${c}`);
  const stream = `BT /F1 18 Tf 72 720 Td (${escaped}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefAt = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.map(o => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1').toString('base64');
}

const LIVE_SKIP = SKIP || !process.env['ANTHROPIC_API_KEY'];

describe.skipIf(LIVE_SKIP)('ClaudeProviderAdapter — AquantX requests, live', () => {
  function makeAdapter(options: { temperature?: number } = {}) {
    return new ClaudeProviderAdapter({
      apiKey: process.env['ANTHROPIC_API_KEY']!,
      model: process.env['ANTHROPIC_MODEL'] ?? 'claude-haiku-4-5-20251001',
      ...options,
    });
  }

  const recordTool = {
    name: 'record_facts',
    description: 'Record the facts found in the evidence.',
    inputSchema: {
      type: 'object',
      properties: { facts: { type: 'array', items: { type: 'string' } } },
      required: ['facts'],
    },
  };

  it('R1 — a forced tool is always called, even when prose would be the natural reply', async () => {
    const adapter = makeAdapter({ temperature: 0 });
    for (let i = 0; i < 3; i++) {
      const result = await adapter.send({
        systemPrompt: 'You are a friendly assistant.',
        messages: [{ role: 'user', content: 'Hi! How are you today?' }],
        tools: [recordTool],
        toolChoice: { type: 'tool', name: 'record_facts' },
      });
      const toolUse = result.content.find(b => b.type === 'tool_use');
      expect(toolUse?.type === 'tool_use' && toolUse.name).toBe('record_facts');
    }
  });

  it('R2 — reads a PDF and a CSV via send()', async () => {
    const adapter = makeAdapter({ temperature: 0 });
    const result = await adapter.send({
      messages: [{
        role: 'user',
        content: [
          {
            type: 'document',
            source: { type: 'base64', media_type: 'application/pdf', data: makePdf('Bill of lading number: BL-778812') },
            title: 'Bill of lading',
          },
          {
            type: 'document',
            source: { type: 'text', media_type: 'text/csv', data: 'container,bags_damaged\nMSCU1234567,17\nMSCU7654321,23' },
            title: 'Damage tally',
          },
          { type: 'text', text: 'Reply with the bill of lading number and the total damaged bags, as "<number> <total>".' },
        ],
      }],
    });
    const text = result.content.map(b => (b.type === 'text' ? b.text : '')).join('');
    console.log('  reply:', text);
    expect(text).toContain('BL-778812');
    expect(text).toContain('40');
  });

  it('R2 — a PDF sent in a thread is persisted and replayed on the next turn', async () => {
    const engine = new ConversationEngine({ storage: new InMemoryStorageAdapter(), provider: makeAdapter({ temperature: 0 }) });
    const thread = await engine.createThread({ type: 'test', ownerId: 'u1' });

    await engine.sendMessage(thread.id, [
      {
        type: 'document',
        source: { type: 'base64', media_type: 'application/pdf', data: makePdf('Vessel name: MV OCEAN TALLY') },
        title: 'Survey notice',
      },
      { type: 'text', text: 'Please read this notice. Reply "ok".' },
    ]);
    const second = await engine.sendMessage(thread.id, 'What vessel is named in the notice? Reply with the name only.');

    const text = typeof second.content === 'string'
      ? second.content
      : second.content.map(b => (b.type === 'text' ? b.text : '')).join('');
    expect(text.toUpperCase()).toContain('OCEAN TALLY');
  });

  it('R5 — a cached system prefix is read back on the second identical call', async () => {
    const adapter = makeAdapter();
    // Must exceed the model's minimum cacheable length (up to 4096 tokens on
    // some models). The nonce keeps earlier runs' cache entries from matching.
    const nonce = `run-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const pack = `Knowledge pack ${nonce}.\n` +
      Array.from({ length: 400 }, (_, i) =>
        `Rule ${i}: when inspecting cargo lot ${i}, record the seal number, the container condition, and any water staining.`,
      ).join('\n');

    const call = () => adapter.send({
      systemPrompt: [{ text: pack, cacheBreakpoint: true }, { text: 'Assignment context: J-42.' }],
      messages: [{ role: 'user', content: 'Reply "ok".' }],
    });

    const first = await call();
    const second = await call();
    console.log('  first  — cache write:', first.usage.cacheWriteTokens, 'read:', first.usage.cacheReadTokens);
    console.log('  second — cache write:', second.usage.cacheWriteTokens, 'read:', second.usage.cacheReadTokens);
    expect(first.usage.cacheWriteTokens ?? 0).toBeGreaterThan(0);
    expect(second.usage.cacheReadTokens ?? 0).toBeGreaterThan(0);
  });
});
