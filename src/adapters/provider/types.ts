/**
 * ProviderAdapter interface and related types.
 * Zero runtime dependencies.
 */

import type { ContentBlock, MessageRole } from '../../types.js';
import type { ProviderName } from '../../errors.js';

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

/**
 * How much the model thinks (Claude). Which values a model accepts varies —
 * e.g. Sonnet 5.5 rejects 'disabled' and only it accepts 'between_tools'.
 * The engine doesn't check; the API's 400 surfaces as InvalidRequestError.
 */
export type ThinkingConfig =
  | { type: 'adaptive'; display?: 'omitted' | 'summarized' }
  | { type: 'disabled' }
  | { type: 'between_tools' };

/** Claude's `output_config.effort`: the main lever on thinking depth and cost. */
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/**
 * What Claude does when a replayed thinking block no longer matches the
 * conversation that produced it: fail the request, or drop that block and
 * every later one. Setting either value also opts an older account into the
 * check.
 */
export type BlockBinding = 'error' | 'drop_block';

/** One entry of Claude's `input_transformations` (e.g. a dropped thinking block). */
export interface InputTransformation {
  type: string;
  path?: string;
  reason?: string;
  [key: string]: unknown;
}

/** What every ProviderAdapter.send() / stream() call receives. */
export interface ProviderInput {
  systemPrompt?: SystemPrompt;
  messages: ProviderMessage[];
  tools?: ToolDefinition[];
  /** Default 'auto'. Requires `tools` unless it is 'auto' or 'none'. */
  toolChoice?: ToolChoice;
  /** Overrides the adapter's default for this call. Claude only; others ignore it. */
  thinking?: ThinkingConfig;
  /** Overrides the adapter's default for this call. Claude only; others ignore it. */
  effort?: Effort;
  /** Overrides the adapter's default for this call. Claude only; others ignore it. */
  blockBinding?: BlockBinding;
}

export interface ProviderResponse {
  content: ContentBlock[];
  /** The provider's own value, e.g. Claude's 'end_turn' | 'tool_use' | 'max_tokens' | 'refusal'. */
  stopReason: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  };
  /** Set when stopReason is 'refusal' and the provider says why. */
  stopDetails?: { category?: string; explanation?: string };
  /** Claude, with blockBinding set: what the API changed in the request. */
  inputTransformations?: InputTransformation[];
}

export interface ProviderStreamChunk {
  delta: string | ContentBlock;
  done: boolean;
  /**
   * On the `done: true` chunk: the complete response — every block in order,
   * the real stopReason and usage. Adapters that can't supply it leave it unset.
   */
  response?: ProviderResponse;
  /** True on chunks sent while the model is thinking (`delta` is then ''). */
  thinking?: boolean;
  /** Summarised reasoning text, when the provider streams it (Claude, display 'summarized'). */
  thinkingDelta?: string;
}

export interface ProviderAdapter {
  /** Used to label errors the engine raises from a response (e.g. RefusalError). */
  readonly name?: ProviderName;

  send(input: ProviderInput): Promise<ProviderResponse>;

  stream(input: ProviderInput): AsyncIterable<ProviderStreamChunk>;
}
