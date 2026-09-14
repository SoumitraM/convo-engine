/**
 * demo-stream.ts — streamMessage demo
 *
 * Demonstrates the { stream, completion } pattern.
 * stream yields text deltas in real time; completion resolves when the
 * full message is persisted and afterReceive has run.
 *
 * NOTE: The IBM TADN gateway does not support SSE streaming (returns HTTP 500).
 * This demo catches that error and falls back to sendMessage so the script still
 * runs successfully. When using a gateway that supports streaming (or Claude),
 * the streaming path will work as shown.
 *
 * Run: npm run demo:stream
 */

import 'dotenv/config';
import { ConversationEngine, InMemoryStorageAdapter } from '@smsoumitra/convo-engine';
import { createGatewayProviderAdapter } from '@smsoumitra/convo-engine/adapters/gateway';

async function main() {
  const engine = new ConversationEngine({
    storage: new InMemoryStorageAdapter(),
    provider: createGatewayProviderAdapter(),
    defaultSystemPrompt: 'You are a helpful assistant. Keep replies to 2–3 sentences.',
    hooks: {
      afterReceive: (ctx) => {
        // Fires after the full message is persisted
        const { inputTokens, outputTokens } = ctx.rawResponse.usage;
        console.log(`\n[afterReceive] Message ID: ${ctx.assistantMessage.id} — tokens in: ${inputTokens}, out: ${outputTokens}`);
      },
    },
  });

  const thread = await engine.createThread({ type: 'demo_stream', ownerId: 'demo-user-1' });
  console.log(`\nCreated thread: ${thread.id}`);

  const userMessage = 'Tell me a one-sentence fun fact about the ocean.';
  console.log(`\nUser: ${userMessage}\n`);

  // Attempt streaming — fall back to sendMessage if the gateway doesn't support SSE
  const { stream, completion } = engine.streamMessage(thread.id, userMessage);

  try {
    process.stdout.write('Assistant (streaming): ');
    process.stdout.write('\x1b[32m'); // green

    for await (const chunk of stream) {
      if (!chunk.done && typeof chunk.delta === 'string') {
        process.stdout.write(chunk.delta);
      }
    }

    process.stdout.write('\x1b[0m\n'); // reset
    const savedMessage = await completion;
    console.log(`\nMessage persisted. Role: ${savedMessage.role}`);
  } catch (err: unknown) {
    // Gateway doesn't support streaming — fall back to non-streaming
    process.stdout.write('\x1b[0m\n');
    const errMsg = err instanceof Error ? err.message : String(err);
    if (errMsg.includes('HTTP 500') || errMsg.includes('HTTP 4')) {
      console.log(`[note] Streaming not supported by this gateway (${errMsg.slice(0, 80)}...)`);
      console.log('[note] Falling back to sendMessage...\n');

      const thread2 = await engine.createThread({ type: 'demo_stream_fallback', ownerId: 'demo-user-1' });
      const reply = await engine.sendMessage(thread2.id, userMessage);
      const text = Array.isArray(reply.content)
        ? reply.content.filter(b => b.type === 'text').map(b => b.type === 'text' ? b.text : '').join('')
        : reply.content;
      console.log(`Assistant: ${text}`);
    } else {
      throw err;
    }
  }
}

main().catch(err => {
  console.error('Demo failed:', err);
  process.exit(1);
});
