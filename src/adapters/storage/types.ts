/**
 * StorageAdapter interface.
 * The consumer implements this against their own database.
 * Zero runtime dependencies.
 */

import type { Thread, ThreadId, Message, MessageId } from '../../types.js';

export type { Thread, ThreadId, Message, MessageId };

export interface StorageAdapter {
  // ── Required ──────────────────────────────────────────────────────────────

  createThread(input: {
    type: string;
    ownerId: string;
    metadata?: Record<string, unknown>;
  }): Promise<Thread>;

  getThread(threadId: ThreadId): Promise<Thread | null>;

  appendMessage(
    threadId: ThreadId,
    message: Omit<Message, 'id' | 'createdAt'>,
  ): Promise<Message>;

  getMessages(
    threadId: ThreadId,
    opts?: { limit?: number; before?: Date },
  ): Promise<Message[]>;

  // ── Optional — engine calls these only if present ─────────────────────────

  /** List all threads owned by a given ownerId, newest first. */
  listThreads?(
    ownerId: string,
    opts?: { limit?: number; before?: Date },
  ): Promise<Thread[]>;

  /** Update mutable thread fields. Only `metadata` is mutable. */
  updateThread?(
    threadId: ThreadId,
    patch: Partial<Pick<Thread, 'metadata'>>,
  ): Promise<Thread>;

  /** Permanently delete a thread and all its messages. */
  deleteThread?(threadId: ThreadId): Promise<void>;
}
