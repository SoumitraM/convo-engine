/**
 * InMemoryStorageAdapter
 *
 * Reference implementation of StorageAdapter — all 7 methods, backed by Maps.
 * Not for production use. Useful for testing and prototyping.
 */

import type { StorageAdapter } from './types.js';
import type { Thread, ThreadId, Message } from '../../types.js';

function randomId(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export class InMemoryStorageAdapter implements StorageAdapter {
  private threads = new Map<string, Thread>();
  private messages = new Map<string, Message[]>(); // threadId → Message[]

  // ── Required ──────────────────────────────────────────────────────────────

  async createThread(input: {
    type: string;
    ownerId: string;
    metadata?: Record<string, unknown>;
  }): Promise<Thread> {
    const thread: Thread = {
      id: randomId(),
      type: input.type,
      ownerId: input.ownerId,
      metadata: input.metadata,
      createdAt: new Date(),
    };
    this.threads.set(thread.id, thread);
    this.messages.set(thread.id, []);
    return thread;
  }

  async getThread(threadId: ThreadId): Promise<Thread | null> {
    return this.threads.get(threadId) ?? null;
  }

  async appendMessage(
    threadId: ThreadId,
    message: Omit<Message, 'id' | 'createdAt'>,
  ): Promise<Message> {
    const stored: Message = {
      ...message,
      id: randomId(),
      createdAt: new Date(),
    };
    const list = this.messages.get(threadId);
    if (!list) throw new Error(`InMemoryStorageAdapter: thread ${threadId} not found`);
    list.push(stored);
    return stored;
  }

  async getMessages(
    threadId: ThreadId,
    opts?: { limit?: number; before?: Date },
  ): Promise<Message[]> {
    let msgs = this.messages.get(threadId) ?? [];
    if (opts?.before) {
      msgs = msgs.filter(m => m.createdAt < opts.before!);
    }
    if (opts?.limit !== undefined) {
      msgs = msgs.slice(-opts.limit);
    }
    return [...msgs];
  }

  // ── Optional ──────────────────────────────────────────────────────────────

  async listThreads(
    ownerId: string,
    opts?: { limit?: number; before?: Date },
  ): Promise<Thread[]> {
    let list = Array.from(this.threads.values())
      .filter(t => t.ownerId === ownerId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

    if (opts?.before) {
      list = list.filter(t => t.createdAt < opts.before!);
    }
    if (opts?.limit !== undefined) {
      list = list.slice(0, opts.limit);
    }
    return list;
  }

  async updateThread(
    threadId: ThreadId,
    patch: Partial<Pick<Thread, 'metadata'>>,
  ): Promise<Thread> {
    const thread = this.threads.get(threadId);
    if (!thread) throw new Error(`InMemoryStorageAdapter: thread ${threadId} not found`);
    const updated: Thread = { ...thread, ...patch };
    this.threads.set(threadId, updated);
    return updated;
  }

  async deleteThread(threadId: ThreadId): Promise<void> {
    this.threads.delete(threadId);
    this.messages.delete(threadId);
  }
}
