/**
 * demo-agent.ts — agentLoop demo
 *
 * Demonstrates the multi-call tool loop using a trivial get_current_time tool.
 * The engine automatically handles: tool_use request → toolExecutor call →
 * tool_result → model produces final answer.
 *
 * Run: npm run demo:agent
 */

import 'dotenv/config';
import { ConversationEngine, InMemoryStorageAdapter } from '@soumitrm/convo-engine';
import type { ToolDefinition } from '@soumitrm/convo-engine';
import { createGatewayProviderAdapter } from '@soumitrm/convo-engine/adapters/gateway';

// ── Tool definitions ──────────────────────────────────────────────────────

const tools: ToolDefinition[] = [
  {
    name:        'get_current_time',
    description: 'Returns the current date and time as an ISO 8601 string.',
    inputSchema: {
      type:       'object',
      properties: {},
      required:   [],
    },
  },
];

// ── Tool executor ─────────────────────────────────────────────────────────

async function toolExecutor(toolName: string, _toolInput: Record<string, unknown>): Promise<unknown> {
  if (toolName === 'get_current_time') {
    const now = new Date().toISOString();
    console.log(`[toolExecutor] Executing ${toolName} → ${now}`);
    return now;
  }
  throw new Error(`Unknown tool: ${toolName}`);
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main() {
  const engine = new ConversationEngine({
    storage: new InMemoryStorageAdapter(),
    provider: createGatewayProviderAdapter(),
    defaultSystemPrompt:
      'You are a helpful assistant. When asked about the current time, use the get_current_time tool.',
    hooks: {
      beforeSend: (ctx) => {
        console.log(`[beforeSend] iteration — history length: ${ctx.history.length}`);
        return ctx;
      },
      afterReceive: (ctx) => {
        const { inputTokens, outputTokens } = ctx.rawResponse.usage;
        console.log(`[afterReceive] Final message saved. Tokens — in: ${inputTokens}, out: ${outputTokens}`);
      },
      onError: (err, phase) => {
        console.error(`[onError] phase="${phase}"`, err);
      },
    },
  });

  const thread = await engine.createThread({ type: 'demo_agent', ownerId: 'demo-user-1' });
  console.log(`\nCreated thread: ${thread.id}\n`);

  console.log('User: What is the current time? Please tell me in a friendly way.\n');

  const finalMessage = await engine.agentLoop(
    thread.id,
    'What is the current time? Please tell me in a friendly way.',
    { tools, toolExecutor, maxIterations: 5 },
  );

  const text = Array.isArray(finalMessage.content)
    ? finalMessage.content.filter(b => b.type === 'text').map(b => b.type === 'text' ? b.text : '').join('')
    : finalMessage.content;

  console.log(`\nAssistant: ${text}\n`);

  // Show the full thread — includes tool_use and tool_result messages
  const history = await engine.getHistory(thread.id);
  console.log(`Thread has ${history.length} messages total (including intermediate tool messages):`);
  for (const msg of history) {
    const preview = Array.isArray(msg.content)
      ? `[${msg.content.map(b => b.type).join(', ')}]`
      : msg.content.slice(0, 60);
    console.log(`  ${msg.role}: ${preview}`);
  }
}

main().catch(err => {
  console.error('Demo failed:', err);
  process.exit(1);
});
