/**
 * @smsoumitra/convo-engine — public exports
 *
 * This is the only root-level import consumers need:
 *   import { ConversationEngine } from '@smsoumitra/convo-engine';
 *
 * Provider adapters are behind subpath exports (so they don't force peer dep installs):
 *   import { ClaudeProviderAdapter }   from '@smsoumitra/convo-engine/adapters/claude';
 *   import { OpenAIProviderAdapter }   from '@smsoumitra/convo-engine/adapters/openai';
 *   import { GatewayProviderAdapter }  from '@smsoumitra/convo-engine/adapters/gateway';
 *   import { InMemoryStorageAdapter }  from '@smsoumitra/convo-engine/adapters/storage/memory';
 */

// ── Engine ────────────────────────────────────────────────────────────────
export {
  ConversationEngine,
  MaxIterationsExceededError,
  SendAllWithTrailingCacheBreakpoint,
} from './engine.js';

export type {
  ConversationEngineConfig,
  ToolExecutor,
  AgentLoopOptions,
  SendMessageOptions,
  StreamMessageOptions,
  ThinkingOptions,
  ThinkingHistory,
} from './engine.js';

export { applyThinkingHistory } from './context/thinking-history.js';

// ── Core types ────────────────────────────────────────────────────────────
export type {
  Thread,
  ThreadId,
  Message,
  MessageId,
  MessageRole,
  ContentBlock,
  DocumentSource,
} from './types.js';

// ── Provider errors ───────────────────────────────────────────────────────
export {
  ProviderError,
  RateLimitError,
  OverloadedError,
  ContextLengthError,
  AuthenticationError,
  InvalidRequestError,
  RefusalError,
  IncompleteResponseError,
} from './errors.js';

export type { ProviderName, ProviderErrorOptions } from './errors.js';

// ── StorageAdapter ─────────────────────────────────────────────────────────
export type { StorageAdapter } from './adapters/storage/types.js';

// InMemoryStorageAdapter re-exported at root for convenience
export { InMemoryStorageAdapter } from './adapters/storage/in-memory.js';

// ── ProviderAdapter ────────────────────────────────────────────────────────
export type {
  ProviderAdapter,
  ProviderMessage,
  ProviderResponse,
  ProviderStreamChunk,
  ProviderInput,
  ToolDefinition,
  ToolChoice,
  SystemPrompt,
  SystemPromptBlock,
  ThinkingConfig,
  Effort,
  BlockBinding,
  InputTransformation,
} from './adapters/provider/types.js';

// ── Context strategy ───────────────────────────────────────────────────────
export type { ContextStrategy } from './context/strategy.js';

// ── Hooks ─────────────────────────────────────────────────────────────────
export type {
  EngineHooks,
  SendContext,
  ReceiveContext,
  ProviderCallContext,
} from './hooks/types.js';

// ── Gateway adapter — no peer dep, safe to re-export from root ────────────
export {
  GatewayProviderAdapter,
  createGatewayProviderAdapter,
} from './adapters/provider/gateway.js';

export type { GatewayProviderAdapterOptions } from './adapters/provider/gateway.js';
