/**
 * @soumitrm/convo-engine — public exports
 *
 * This is the only root-level import consumers need:
 *   import { ConversationEngine } from '@soumitrm/convo-engine';
 *
 * Provider adapters are behind subpath exports (so they don't force peer dep installs):
 *   import { ClaudeProviderAdapter }   from '@soumitrm/convo-engine/adapters/claude';
 *   import { OpenAIProviderAdapter }   from '@soumitrm/convo-engine/adapters/openai';
 *   import { GatewayProviderAdapter }  from '@soumitrm/convo-engine/adapters/gateway';
 *   import { InMemoryStorageAdapter }  from '@soumitrm/convo-engine/adapters/storage/memory';
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
} from './engine.js';

// ── Core types ────────────────────────────────────────────────────────────
export type {
  Thread,
  ThreadId,
  Message,
  MessageId,
  MessageRole,
  ContentBlock,
} from './types.js';

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
  ToolDefinition,
} from './adapters/provider/types.js';

// ── Context strategy ───────────────────────────────────────────────────────
export type { ContextStrategy } from './context/strategy.js';

// ── Hooks ─────────────────────────────────────────────────────────────────
export type {
  EngineHooks,
  SendContext,
  ReceiveContext,
} from './hooks/types.js';

// ── Gateway adapter — no peer dep, safe to re-export from root ────────────
export {
  GatewayProviderAdapter,
  createGatewayProviderAdapter,
} from './adapters/provider/gateway.js';

export type { GatewayProviderAdapterOptions } from './adapters/provider/gateway.js';
