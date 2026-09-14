/**
 * demo.ts — sendMessage demo
 *
 * Demonstrates the basic send/receive cycle using ConversationEngine
 * with GatewayProviderAdapter (IBM gateway) or ClaudeProviderAdapter.
 *
 * Run: npm run demo
 */

import 'dotenv/config';
import { ConversationEngine, InMemoryStorageAdapter } from '@smsoumitra/convo-engine';
import { createGatewayProviderAdapter } from '@smsoumitra/convo-engine/adapters/gateway';

async function main() {
  // ── Provider ──────────────────────────────────────────────────────────────
  // Uses GatewayProviderAdapter if LLM_BASE_URL is set (IBM gateway).
  // Swap for ClaudeProviderAdapter when an Anthropic key is available.
  const provider = createGatewayProviderAdapter();

  // ── Engine ────────────────────────────────────────────────────────────────
  const engine = new ConversationEngine({
    storage: new InMemoryStorageAdapter(),
    provider,
    defaultSystemPrompt: 'You are a concise, helpful assistant. Keep replies to 1–2 sentences.',
    hooks: {
      beforeSend: (ctx) => {
        // Example: log the outgoing message
        const content = typeof ctx.newMessage.content === 'string'
          ? ctx.newMessage.content
          : '[content blocks]';
        console.log(`[beforeSend] Sending: "${content.slice(0, 80)}"`);
        return ctx;
      },
      afterReceive: (ctx) => {
        // Example: log token usage
        const { inputTokens, outputTokens } = ctx.rawResponse.usage;
        console.log(`[afterReceive] Tokens — in: ${inputTokens}, out: ${outputTokens}`);
      },
      onError: (err, phase) => {
        console.error(`[onError] Error in phase "${phase}":`, err);
      },
    },
  });

  // ── Thread ────────────────────────────────────────────────────────────────
  const thread = await engine.createThread({
    type:    'demo_chat',
    ownerId: 'demo-user-1',
  });
  console.log(`\nCreated thread: ${thread.id}\n`);

  // ── Turn 1 ────────────────────────────────────────────────────────────────
  console.log('User: What is the capital of France?');
  const reply1 = await engine.sendMessage(thread.id, 'What is the capital of France?');
  const text1 = Array.isArray(reply1.content)
    ? reply1.content.filter(b => b.type === 'text').map(b => b.type === 'text' ? b.text : '').join('')
    : reply1.content;
  console.log(`Assistant: ${text1}\n`);

  // ── Turn 2 — proving history is retained ─────────────────────────────────
  console.log('User: And what is the population of that city?');
  const reply2 = await engine.sendMessage(thread.id, 'And what is the population of that city?');
  const text2 = Array.isArray(reply2.content)
    ? reply2.content.filter(b => b.type === 'text').map(b => b.type === 'text' ? b.text : '').join('')
    : reply2.content;
  console.log(`Assistant: ${text2}\n`);

  // ── Full history ──────────────────────────────────────────────────────────
  const history = await engine.getHistory(thread.id);
  console.log(`Thread now has ${history.length} messages.`);
}

main().catch(err => {
  console.error('Demo failed:', err);
  process.exit(1);
});
