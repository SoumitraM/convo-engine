/**
 * ConversationEngine — the main class.
 * Zero runtime dependencies.
 */

import type { Thread, ThreadId, Message, ContentBlock, ToolExecutor } from './types.js';
import type { StorageAdapter } from './adapters/storage/types.js';
import type {
  ProviderAdapter,
  ProviderMessage,
  ProviderResponse,
  ProviderStreamChunk,
  ToolDefinition,
} from './adapters/provider/types.js';
import type { ContextStrategy } from './context/strategy.js';
import { SendAllWithTrailingCacheBreakpoint } from './context/strategy.js';
import type { EngineHooks, SendContext, ReceiveContext } from './hooks/types.js';

export { SendAllWithTrailingCacheBreakpoint };
export type { ToolExecutor };

/** Thrown by agentLoop when maxIterations is exceeded. */
export class MaxIterationsExceededError extends Error {
  constructor(maxIterations: number) {
    super(
      `ConversationEngine: agentLoop exceeded maxIterations (${maxIterations}). ` +
      `The model kept requesting tools beyond the allowed limit.`,
    );
    this.name = 'MaxIterationsExceededError';
  }
}

export interface ConversationEngineConfig {
  storage: StorageAdapter;
  provider: ProviderAdapter;
  hooks?: EngineHooks;
  contextStrategy?: ContextStrategy;
  defaultSystemPrompt?: string;
}

export class ConversationEngine {
  private readonly storage: StorageAdapter;
  private readonly provider: ProviderAdapter;
  private readonly hooks: EngineHooks;
  private readonly strategy: ContextStrategy;
  private readonly defaultSystemPrompt?: string;

  constructor(config: ConversationEngineConfig) {
    this.storage = config.storage;
    this.provider = config.provider;
    this.hooks = config.hooks ?? {};
    this.strategy = config.contextStrategy ?? new SendAllWithTrailingCacheBreakpoint();
    this.defaultSystemPrompt = config.defaultSystemPrompt;
  }

  // ── Public thread/history methods ─────────────────────────────────────────

  createThread(input: {
    type: string;
    ownerId: string;
    metadata?: Record<string, unknown>;
  }): Promise<Thread> {
    return this.storage.createThread(input);
  }

  getThread(threadId: ThreadId): Promise<Thread | null> {
    return this.storage.getThread(threadId);
  }

  getHistory(threadId: ThreadId): Promise<Message[]> {
    return this.storage.getMessages(threadId);
  }

  // ── sendMessage ───────────────────────────────────────────────────────────

  async sendMessage(
    threadId: ThreadId,
    userContent: string | ContentBlock[],
    opts?: { tools?: ToolDefinition[]; systemPrompt?: string },
  ): Promise<Message> {
    const { thread, userMessage, history } = await this._prepareUserMessage(
      threadId,
      userContent,
    );

    const systemPrompt = opts?.systemPrompt ?? this.defaultSystemPrompt;

    let ctx: SendContext = {
      thread,
      history,
      newMessage: userMessage,
      systemPrompt,
      tools: opts?.tools,
    };

    ctx = await this._runBeforeSend(ctx);

    const messages = this.strategy.assemble(ctx.history, ctx.newMessage);

    let rawResponse: ProviderResponse;
    try {
      rawResponse = await this.provider.send({
        systemPrompt: ctx.systemPrompt,
        messages,
        tools: ctx.tools,
      });
    } catch (err) {
      this._callOnError(err, 'provider');
      throw err;
    }

    const assistantMessage = await this.storage.appendMessage(threadId, {
      threadId,
      role: 'assistant',
      content: rawResponse.content,
    });

    await this._runAfterReceive({
      thread,
      userMessage,
      assistantMessage,
      rawResponse,
    });

    return assistantMessage;
  }

  // ── streamMessage ─────────────────────────────────────────────────────────

  streamMessage(
    threadId: ThreadId,
    userContent: string | ContentBlock[],
    opts?: { tools?: ToolDefinition[]; systemPrompt?: string },
  ): { stream: AsyncIterable<ProviderStreamChunk>; completion: Promise<Message> } {
    // completion is driven by consuming the stream
    let resolveCompletion!: (msg: Message) => void;
    let rejectCompletion!: (err: unknown) => void;
    const completion = new Promise<Message>((res, rej) => {
      resolveCompletion = res;
      rejectCompletion = rej;
    });

    const engine = this;

    async function* generateStream(): AsyncIterable<ProviderStreamChunk> {
      try {
        const { thread, userMessage, history } = await engine._prepareUserMessage(
          threadId,
          userContent,
        );

        const systemPrompt = opts?.systemPrompt ?? engine.defaultSystemPrompt;

        let ctx: SendContext = {
          thread,
          history,
          newMessage: userMessage,
          systemPrompt,
          tools: opts?.tools,
        };

        ctx = await engine._runBeforeSend(ctx);

        const messages = engine.strategy.assemble(ctx.history, ctx.newMessage);

        let providerStream: AsyncIterable<ProviderStreamChunk>;
        try {
          providerStream = engine.provider.stream({
            systemPrompt: ctx.systemPrompt,
            messages,
            tools: ctx.tools,
          });
        } catch (err) {
          engine._callOnError(err, 'provider');
          rejectCompletion(err);
          throw err;
        }

        const contentBlocks: ContentBlock[] = [];
        let textBuffer = '';

        for await (const chunk of providerStream) {
          yield chunk;
          if (!chunk.done) {
            if (typeof chunk.delta === 'string') {
              textBuffer += chunk.delta;
            } else {
              // ContentBlock delta (e.g. tool_use from streaming)
              contentBlocks.push(chunk.delta);
            }
          }
        }

        // Assemble the final content: if we have a text buffer, use it as text block
        let finalContent: string | ContentBlock[];
        if (contentBlocks.length > 0) {
          finalContent = contentBlocks;
        } else {
          finalContent = textBuffer;
        }

        const assistantMessage = await engine.storage.appendMessage(threadId, {
          threadId,
          role: 'assistant',
          content: finalContent,
        });

        const rawResponse: ProviderResponse = {
          content: typeof finalContent === 'string'
            ? [{ type: 'text', text: finalContent }]
            : finalContent,
          stopReason: 'stop',
          usage: { inputTokens: 0, outputTokens: 0 },
        };

        await engine._runAfterReceive({
          thread,
          userMessage,
          assistantMessage,
          rawResponse,
        });

        resolveCompletion(assistantMessage);
      } catch (err) {
        rejectCompletion(err);
        throw err;
      }
    }

    return { stream: generateStream(), completion };
  }

  // ── agentLoop ─────────────────────────────────────────────────────────────

  async agentLoop(
    threadId: ThreadId,
    userContent: string | ContentBlock[],
    opts: {
      tools: ToolDefinition[];
      toolExecutor: ToolExecutor;
      systemPrompt?: string;
      maxIterations?: number;
    },
  ): Promise<Message> {
    const maxIterations = opts.maxIterations ?? 10;
    const systemPrompt = opts.systemPrompt ?? this.defaultSystemPrompt;

    const { thread, userMessage } = await this._prepareUserMessage(
      threadId,
      userContent,
    );

    let iteration = 0;

    while (iteration < maxIterations) {
      iteration++;

      // Re-fetch history every iteration so intermediate tool messages are included
      const history = await this.storage.getMessages(threadId);
      // The last message is the one we're processing (userMessage or a tool_result),
      // so history for context assembly is everything except the last message.
      const priorHistory = history.slice(0, -1);
      const currentMessage = history[history.length - 1];

      let ctx: SendContext = {
        thread,
        history: priorHistory,
        newMessage: currentMessage,
        systemPrompt,
        tools: opts.tools,
      };

      ctx = await this._runBeforeSend(ctx);

      const messages = this.strategy.assemble(ctx.history, ctx.newMessage);

      let rawResponse: ProviderResponse;
      try {
        rawResponse = await this.provider.send({
          systemPrompt: ctx.systemPrompt,
          messages,
          tools: ctx.tools,
        });
      } catch (err) {
        this._callOnError(err, 'provider');
        throw err;
      }

      // Persist the assistant's response (could be tool_use or final answer)
      const assistantMessage = await this.storage.appendMessage(threadId, {
        threadId,
        role: 'assistant',
        content: rawResponse.content,
      });

      // If the model is done (no tool calls), fire afterReceive and return
      if (rawResponse.stopReason !== 'tool_use') {
        await this._runAfterReceive({
          thread,
          userMessage,
          assistantMessage,
          rawResponse,
        });
        return assistantMessage;
      }

      // Execute all requested tools and persist results
      const toolUseBlocks = rawResponse.content.filter(
        (b): b is Extract<ContentBlock, { type: 'tool_use' }> => b.type === 'tool_use',
      );

      for (const toolUse of toolUseBlocks) {
        let resultContent: string;
        try {
          const result = await opts.toolExecutor(toolUse.name, toolUse.input);
          resultContent = typeof result === 'string' ? result : JSON.stringify(result);
        } catch (err) {
          this._callOnError(err, 'toolExecutor');
          throw err;
        }

        await this.storage.appendMessage(threadId, {
          threadId,
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: toolUse.id,
              content: resultContent,
            },
          ],
        });
      }
    }

    throw new MaxIterationsExceededError(maxIterations);
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  /** Persist the user message and fetch the history that existed before it. */
  private async _prepareUserMessage(
    threadId: ThreadId,
    userContent: string | ContentBlock[],
  ): Promise<{ thread: Thread; userMessage: Message; history: Message[] }> {
    const thread = await this.storage.getThread(threadId);
    if (!thread) {
      throw new Error(`ConversationEngine: thread ${threadId} not found`);
    }

    // Fetch prior history before appending the new message
    const history = await this.storage.getMessages(threadId);

    const userMessage = await this.storage.appendMessage(threadId, {
      threadId,
      role: 'user',
      content: userContent,
    });

    return { thread, userMessage, history };
  }

  private async _runBeforeSend(ctx: SendContext): Promise<SendContext> {
    if (!this.hooks.beforeSend) return ctx;
    try {
      return await this.hooks.beforeSend(ctx);
    } catch (err) {
      this._callOnError(err, 'beforeSend');
      throw err;
    }
  }

  private async _runAfterReceive(ctx: ReceiveContext): Promise<void> {
    if (!this.hooks.afterReceive) return;
    try {
      await this.hooks.afterReceive(ctx);
    } catch (err) {
      this._callOnError(err, 'afterReceive');
      // afterReceive errors are observed via onError but do NOT propagate to the caller
    }
  }

  private _callOnError(
    err: unknown,
    phase: 'beforeSend' | 'provider' | 'toolExecutor' | 'afterReceive',
  ): void {
    if (!this.hooks.onError) return;
    try {
      this.hooks.onError(err, phase);
    } catch {
      // onError must never throw — swallow the hook error silently
    }
  }
}

// Re-export types consumers commonly need when using the engine
export type {
  Thread,
  ThreadId,
  Message,
  ContentBlock,
  StorageAdapter,
  ProviderAdapter,
  ProviderMessage,
  ProviderResponse,
  ProviderStreamChunk,
  ToolDefinition,
  ContextStrategy,
  EngineHooks,
  SendContext,
  ReceiveContext,
};
