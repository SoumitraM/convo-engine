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

/**
 * Which tool, if any, the model must call.
 * - 'auto' — the model decides (default)
 * - 'any'  — the model must call one of the supplied tools
 * - 'none' — tools stay visible but none may be called
 * - { type: 'tool', name } — the model must call exactly this tool
 */
export type ToolChoice =
  | 'auto'
  | 'any'
  | 'none'
  | { type: 'tool'; name: string };

/** One segment of a system prompt sent as blocks. */
export interface SystemPromptBlock {
  text: string;
  /** Marks the end of a cacheable prefix (Claude: cache_control on this block).
   *  Adapters for providers without caching ignore it. */
  cacheBreakpoint?: boolean;
}

/**
 * A system prompt is either a plain string or a list of blocks. Blocks let a
 * stable prefix be cached while a variable suffix changes, e.g.
 * `[{ text: knowledgePack, cacheBreakpoint: true }, { text: perAssignmentContext }]`.
 * Providers without block support receive the blocks joined by a blank line.
 */
export type SystemPrompt = string | SystemPromptBlock[];

/** What every ProviderAdapter.send() / stream() call receives. */
export interface ProviderInput {
  systemPrompt?: SystemPrompt;
  messages: ProviderMessage[];
  tools?: ToolDefinition[];
  /** Default 'auto'. Requires `tools` unless it is 'auto' or 'none'. */
  toolChoice?: ToolChoice;
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
  send(input: ProviderInput): Promise<ProviderResponse>;

  stream(input: ProviderInput): AsyncIterable<ProviderStreamChunk>;
}
