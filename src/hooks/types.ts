/**
 * Hook types for the engine extension point.
 * Zero runtime dependencies.
 */

import type { Thread, Message } from '../types.js';
import type { ProviderResponse, ToolDefinition } from '../adapters/provider/types.js';

export interface SendContext {
  thread: Thread;
  history: Message[];
  newMessage: Message;
  systemPrompt?: string;
  tools?: ToolDefinition[];
}

export interface ReceiveContext {
  thread: Thread;
  userMessage: Message;
  assistantMessage: Message;
  rawResponse: ProviderResponse;
}

export interface EngineHooks {
  /**
   * Runs after context assembly, before the provider call. Can mutate
   * systemPrompt, tools, or inject additional context (e.g. RAG results)
   * by returning a modified SendContext. Fires on every iteration of
   * agentLoop, not just the first.
   */
  beforeSend?: (ctx: SendContext) => Promise<SendContext> | SendContext;

  /**
   * Runs after the provider responds and the assistant message has been
   * persisted. Use for side effects: extraction logic, logging, analytics.
   * Does not mutate what's already stored.
   * In agentLoop, fires exactly once — on the final assistant message only.
   */
  afterReceive?: (ctx: ReceiveContext) => Promise<void> | void;

  /**
   * Called when an error occurs in any engine-managed phase.
   * For observability (logging, alerting) only — cannot recover from errors.
   * Must never throw — if it does, the engine swallows the hook error.
   */
  onError?: (
    err: unknown,
    phase: 'beforeSend' | 'provider' | 'toolExecutor' | 'afterReceive',
  ) => void;
}
