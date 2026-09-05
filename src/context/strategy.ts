/**
 * Context assembly strategy.
 * Zero runtime dependencies.
 */

import type { Message } from '../types.js';
import type { ProviderMessage } from '../adapters/provider/types.js';

export interface ContextStrategy {
  /**
   * Given the full stored history (NOT including newMessage) and the new
   * user message, return the ProviderMessage[] to send to the provider.
   *
   * The implementation is responsible for appending newMessage as the final
   * element in the returned array.
   */
  assemble(history: Message[], newMessage: Message): ProviderMessage[];
}

/**
 * Default strategy: send the full history, with `cacheBreakpoint: true` set
 * on the last message before the newest user message. This creates a stable,
 * cacheable prefix that benefits from provider-side prompt caching.
 */
export class SendAllWithTrailingCacheBreakpoint implements ContextStrategy {
  assemble(history: Message[], newMessage: Message): ProviderMessage[] {
    const result: ProviderMessage[] = history.map(msg => ({
      role: msg.role,
      content: msg.content,
    }));

    // Place the cache breakpoint on the last history message (just before the
    // new user message), making the full prior conversation the cacheable prefix.
    if (result.length > 0) {
      result[result.length - 1] = {
        ...result[result.length - 1],
        cacheBreakpoint: true,
      };
    }

    result.push({
      role: newMessage.role,
      content: newMessage.content,
    });

    return result;
  }
}
