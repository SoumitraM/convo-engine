/**
 * Core types for @soumitrm/convo-engine.
 * Zero runtime dependencies — pure TypeScript types.
 */

export type ThreadId = string;
export type MessageId = string;
export type MessageRole = 'user' | 'assistant' | 'system';

/**
 * Discriminated union — each content block type has a precise, fully-typed shape.
 * Narrow on `type` using a switch statement; no index-signature casting needed.
 */
export type ContentBlock =
  | { type: 'text';        text: string }
  | { type: 'tool_use';    id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string }
  | { type: 'image';       source: { type: 'base64'; media_type: string; data: string } };

/**
 * Executes a single tool call requested by the model and returns the result.
 * Supplied by the consumer — the engine has no knowledge of what tools do.
 * Throw to signal a tool execution error; the engine will catch it, format an
 * error result, and continue the loop.
 */
export type ToolExecutor = (
  toolName: string,
  toolInput: Record<string, unknown>,
) => Promise<unknown>;

export interface Message {
  id: MessageId;
  threadId: ThreadId;
  role: MessageRole;
  content: string | ContentBlock[];
  /** Opaque to the engine — consumer can stash anything here. */
  metadata?: Record<string, unknown>;
  createdAt: Date;
}

export interface Thread {
  id: ThreadId;
  /** Opaque label set by the consumer. Engine does not branch on this value. */
  type: string;
  /** Opaque external owner id — engine does not enforce anything based on it. */
  ownerId: string;
  /** Opaque consumer-defined metadata, e.g. { jobId, workspaceId }. */
  metadata?: Record<string, unknown>;
  createdAt: Date;
}
