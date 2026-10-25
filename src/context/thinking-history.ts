/**
 * Which stored thinking blocks are sent back to the provider.
 * Zero runtime dependencies.
 */

import type { ContentBlock } from '../types.js';
import type { ProviderMessage } from '../adapters/provider/types.js';

/**
 * - 'all' — send every stored thinking block. Use when the conversation is
 *   append-only (same system prompt and tools every turn).
 * - 'current-turn' — strip thinking from every message before the latest
 *   user message that isn't a tool result; keep the current turn's. Use when
 *   the system prompt or tools change between turns: Claude rejects a
 *   replayed thinking block whose conversation changed, but allows removing
 *   blocks from the front of the history.
 * - 'none' — strip all thinking blocks.
 *
 * Applies only to what is sent; storage always keeps the blocks.
 */
export type ThinkingHistory = 'all' | 'current-turn' | 'none';

function isThinking(block: ContentBlock): boolean {
  return block.type === 'thinking' || block.type === 'redacted_thinking';
}

function isToolResultOnly(content: ProviderMessage['content']): boolean {
  return typeof content !== 'string' &&
    content.length > 0 &&
    content.every(b => b.type === 'tool_result');
}

/**
 * Returns the messages to send under `mode`. Never mutates its input. A
 * message left with no blocks is removed, and its cache breakpoint moves to
 * the message before it.
 */
export function applyThinkingHistory(
  messages: ProviderMessage[],
  mode: ThinkingHistory,
): ProviderMessage[] {
  if (mode === 'all') return messages;

  let boundary = messages.length;
  if (mode === 'current-turn') {
    boundary = 0;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'user' && !isToolResultOnly(messages[i].content)) {
        boundary = i;
        break;
      }
    }
  }

  const result: ProviderMessage[] = [];
  messages.forEach((msg, idx) => {
    if (idx >= boundary || typeof msg.content === 'string' || !msg.content.some(isThinking)) {
      result.push(msg);
      return;
    }

    const content = msg.content.filter(b => !isThinking(b));
    if (content.length > 0) {
      result.push({ ...msg, content });
    } else if (msg.cacheBreakpoint && result.length > 0) {
      result[result.length - 1] = { ...result[result.length - 1], cacheBreakpoint: true };
    }
  });
  return result;
}
