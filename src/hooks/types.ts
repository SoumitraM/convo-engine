/**
 * Hook types for the engine extension point.
 * Zero runtime dependencies.
 */

import type { Thread, Message } from '../types.js';
import type {
  BlockBinding,
  Effort,
  ProviderResponse,
  SystemPrompt,
  ThinkingConfig,
  ToolChoice,
  ToolDefinition,
} from '../adapters/provider/types.js';

export interface SendContext {
  thread: Thread;
  history: Message[];
  /** The message this call answers. In agentLoop iterations after the first
   *  it is the latest tool_result message, not the user's message. */
  newMessage: Message;
  systemPrompt?: SystemPrompt;
  tools?: ToolDefinition[];
  /** The tool choice for this provider call (agentLoop: already resolved for
   *  this iteration). A hook may change it. */
  toolChoice?: ToolChoice;
  /** 1-based provider-call number within this turn. Always 1 for sendMessage
   *  and streamMessage; counts up across agentLoop tool round-trips. */
  iteration: number;
  /** Per-call provider settings (Claude). A hook may change them. */
  thinking?: ThinkingConfig;
  effort?: Effort;
  blockBinding?: BlockBinding;
}

export interface ProviderCallContext {
  thread: Thread;
  userMessage: Message;
  /** Same numbering as SendContext.iteration. */
  iteration: number;
  /** The complete response, with real stopReason and usage — streamed calls
   *  included when the adapter supplies a final response. */
  response: ProviderResponse;
  /** The stored assistant message; undefined when nothing was stored
   *  (a refusal, or an IncompleteResponseError). */
  assistantMessage?: Message;
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
   * `rawResponse` is that final provider call's response; for usage across
   * every call in a loop, use afterProviderCall.
   */
  afterReceive?: (ctx: ReceiveContext) => Promise<void> | void;

  /**
   * Runs after every provider call — once per agentLoop iteration, and once
   * for sendMessage/streamMessage — including calls that end in a refusal or
   * an IncompleteResponseError (they are billed too). Use it to meter usage.
   * Errors are reported to onError and don't propagate.
   */
  afterProviderCall?: (ctx: ProviderCallContext) => Promise<void> | void;

  /**
   * Called when an error occurs in any engine-managed phase.
   * For observability (logging, alerting) only — cannot recover from errors.
   * Must never throw — if it does, the engine swallows the hook error.
   */
  onError?: (
    err: unknown,
    phase: 'beforeSend' | 'provider' | 'toolExecutor' | 'afterReceive' | 'afterProviderCall',
  ) => void;
}
