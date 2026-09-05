/**
 * ProviderAdapter interface and related types.
 * Zero runtime dependencies.
 */

import type { ContentBlock, MessageRole } from '../../types.js';

export type { ContentBlock, MessageRole };

export interface ProviderMessage {
  role: MessageRole;
  content: string | ContentBlock[];
  /** Set by the engine's context-assembly step when this message should be
   *  the end of a cacheable prefix. Adapter is responsible for translating
   *  this into the provider's actual caching mechanism (e.g. Claude's cache_control).
   *  Adapters that target providers with no caching support silently ignore this field. */
  cacheBreakpoint?: boolean;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ProviderResponse {
  content: ContentBlock[];
  stopReason: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  };
}

export interface ProviderStreamChunk {
  delta: string | ContentBlock;
  done: boolean;
}

export interface ProviderAdapter {
  send(input: {
    systemPrompt?: string;
    messages: ProviderMessage[];
    tools?: ToolDefinition[];
  }): Promise<ProviderResponse>;

  stream(input: {
    systemPrompt?: string;
    messages: ProviderMessage[];
    tools?: ToolDefinition[];
  }): AsyncIterable<ProviderStreamChunk>;
}
