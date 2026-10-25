/**
 * ConversationEngine — the main class.
 * Zero runtime dependencies.
 */

import type { Thread, ThreadId, Message, ContentBlock, ToolExecutor } from './types.js';
import type { StorageAdapter } from './adapters/storage/types.js';
import type {
  BlockBinding,
  Effort,
  ProviderAdapter,
  ProviderInput,
  ProviderMessage,
  ProviderResponse,
  ProviderStreamChunk,
  SystemPrompt,
  ThinkingConfig,
  ToolChoice,
  ToolDefinition,
} from './adapters/provider/types.js';
import type { ContextStrategy } from './context/strategy.js';
import { SendAllWithTrailingCacheBreakpoint } from './context/strategy.js';
import { applyThinkingHistory, type ThinkingHistory } from './context/thinking-history.js';
import type {
  EngineHooks,
  SendContext,
  ReceiveContext,
  ProviderCallContext,
} from './hooks/types.js';
import { IncompleteResponseError, RefusalError } from './errors.js';

export { SendAllWithTrailingCacheBreakpoint };
export type { ToolExecutor, ThinkingHistory };

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
  defaultSystemPrompt?: SystemPrompt;
  /**
   * Which stored thinking blocks are sent back (default 'all'). Use
   * 'current-turn' when the system prompt or tools change between turns.
   * Overridable per call.
   */
  thinkingHistory?: ThinkingHistory;
}

/** Thinking settings accepted by every send method. Provider settings are Claude-only. */
export interface ThinkingOptions {
  /** Overrides the adapter's default thinking setting for this call. */
  thinking?: ThinkingConfig;
  /** Overrides the adapter's default effort for this call. */
  effort?: Effort;
  /** Overrides the adapter's default blockBinding for this call. */
  blockBinding?: BlockBinding;
  /** Overrides the engine's thinkingHistory for this call. */
  thinkingHistory?: ThinkingHistory;
}

export interface SendMessageOptions extends ThinkingOptions {
  tools?: ToolDefinition[];
  systemPrompt?: SystemPrompt;
  toolChoice?: ToolChoice;
}

export interface StreamMessageOptions extends ThinkingOptions {
  tools?: ToolDefinition[];
  systemPrompt?: SystemPrompt;
}

export interface AgentLoopOptions extends ThinkingOptions {
  tools: ToolDefinition[];
  toolExecutor: ToolExecutor;
  systemPrompt?: SystemPrompt;
  maxIterations?: number;
  /**
   * A fixed value applies to the FIRST iteration only; later iterations use
   * the provider default ('auto'). Forcing a tool on every iteration would
   * leave the model no way to give its final answer, so the loop would run
   * until MaxIterationsExceededError. For per-iteration control pass a
   * function — it receives the 1-based iteration number and its result is
   * used as-is (undefined = provider default).
   */
  toolChoice?: ToolChoice | ((iteration: number) => ToolChoice | undefined);
}

function toolChoiceForIteration(
  option: AgentLoopOptions['toolChoice'],
  iteration: number,
): ToolChoice | undefined {
  if (typeof option === 'function') return option(iteration);
  return iteration === 1 ? option : undefined;
}

type ToolUseBlock = Extract<ContentBlock, { type: 'tool_use' }>;

function toolUseBlocksOf(content: ContentBlock[]): ToolUseBlock[] {
  return content.filter((b): b is ToolUseBlock => b.type === 'tool_use');
}

/**
 * The response for a streamed call whose adapter didn't supply one on the
 * done chunk: the text, then any tool_use blocks. Usage is unknown.
 */
function assembleStreamedResponse(text: string, blocks: ContentBlock[]): ProviderResponse {
  return {
    content: [...(text.length > 0 ? [{ type: 'text' as const, text }] : []), ...blocks],
    stopReason: blocks.some(b => b.type === 'tool_use') ? 'tool_use' : 'stop',
    usage: { inputTokens: 0, outputTokens: 0 },
  };
}

export class ConversationEngine {
  private readonly storage: StorageAdapter;
  private readonly provider: ProviderAdapter;
  private readonly hooks: EngineHooks;
  private readonly strategy: ContextStrategy;
  private readonly defaultSystemPrompt?: SystemPrompt;
  private readonly thinkingHistory: ThinkingHistory;

  constructor(config: ConversationEngineConfig) {
    this.storage = config.storage;
    this.provider = config.provider;
    this.hooks = config.hooks ?? {};
    this.strategy = config.contextStrategy ?? new SendAllWithTrailingCacheBreakpoint();
    this.defaultSystemPrompt = config.defaultSystemPrompt;
    this.thinkingHistory = config.thinkingHistory ?? 'all';
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
    opts?: SendMessageOptions,
  ): Promise<Message> {
    const { thread, userMessage, history } = await this._prepareUserMessage(
      threadId,
      userContent,
    );

    let ctx: SendContext = {
      thread,
      history,
      newMessage: userMessage,
      systemPrompt: opts?.systemPrompt ?? this.defaultSystemPrompt,
      tools: opts?.tools,
      toolChoice: opts?.toolChoice,
      iteration: 1,
      thinking: opts?.thinking,
      effort: opts?.effort,
      blockBinding: opts?.blockBinding,
    };

    ctx = await this._runBeforeSend(ctx);

    let rawResponse: ProviderResponse;
    try {
      rawResponse = await this.provider.send(this._providerInput(ctx, opts?.thinkingHistory));
    } catch (err) {
      this._callOnError(err, 'provider');
      throw err;
    }

    const assistantMessage = await this._storeResponse(threadId, ctx, userMessage, rawResponse);

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
    opts?: StreamMessageOptions,
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

        let ctx: SendContext = {
          thread,
          history,
          newMessage: userMessage,
          systemPrompt: opts?.systemPrompt ?? engine.defaultSystemPrompt,
          tools: opts?.tools,
          iteration: 1,
          thinking: opts?.thinking,
          effort: opts?.effort,
          blockBinding: opts?.blockBinding,
        };

        ctx = await engine._runBeforeSend(ctx);

        let providerStream: AsyncIterable<ProviderStreamChunk>;
        try {
          providerStream = engine.provider.stream(
            engine._providerInput(ctx, opts?.thinkingHistory),
          );
        } catch (err) {
          engine._callOnError(err, 'provider');
          rejectCompletion(err);
          throw err;
        }

        const contentBlocks: ContentBlock[] = [];
        let textBuffer = '';
        let finalResponse: ProviderResponse | undefined;

        try {
          for await (const chunk of providerStream) {
            yield chunk;
            if (chunk.done) {
              finalResponse = chunk.response;
            } else if (typeof chunk.delta === 'string') {
              textBuffer += chunk.delta;
            } else {
              // ContentBlock delta (e.g. tool_use from streaming)
              contentBlocks.push(chunk.delta);
            }
          }
        } catch (err) {
          engine._callOnError(err, 'provider');
          throw err;
        }

        // Prefer the adapter's complete response (every block, in order, with
        // real stopReason/usage). Otherwise assemble one from the deltas, and
        // keep storing plain text as a string, as before.
        const rawResponse = finalResponse ?? assembleStreamedResponse(textBuffer, contentBlocks);
        const storedContent = finalResponse || contentBlocks.length > 0
          ? rawResponse.content
          : textBuffer;

        const assistantMessage = await engine._storeResponse(
          threadId, ctx, userMessage, rawResponse, storedContent,
        );

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
    opts: AgentLoopOptions,
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
        toolChoice: toolChoiceForIteration(opts.toolChoice, iteration),
        iteration,
        thinking: opts.thinking,
        effort: opts.effort,
        blockBinding: opts.blockBinding,
      };

      ctx = await this._runBeforeSend(ctx);

      let rawResponse: ProviderResponse;
      try {
        rawResponse = await this.provider.send(this._providerInput(ctx, opts.thinkingHistory));
      } catch (err) {
        this._callOnError(err, 'provider');
        throw err;
      }

      // Persist the assistant's response (could be tool_use or final answer)
      const assistantMessage = await this._storeResponse(threadId, ctx, userMessage, rawResponse);

      // pause_turn: the provider stopped mid-turn; sending the conversation
      // back (now ending with this assistant message) lets it continue.
      if (rawResponse.stopReason === 'pause_turn') continue;

      const toolUseBlocks = toolUseBlocksOf(rawResponse.content);

      // If the model is done (no tool calls), fire afterReceive and return
      if (rawResponse.stopReason !== 'tool_use' || toolUseBlocks.length === 0) {
        await this._runAfterReceive({
          thread,
          userMessage,
          assistantMessage,
          rawResponse,
        });
        return assistantMessage;
      }

      // Execute all requested tools and persist results
      await this._runTools(threadId, toolUseBlocks, opts.toolExecutor);
    }

    throw new MaxIterationsExceededError(maxIterations);
  }

  // ── streamAgentLoop ───────────────────────────────────────────────────────

  /**
   * Like agentLoop, but streams each iteration's text deltas as they arrive
   * instead of waiting for the full turn. Tool calls are still executed and
   * looped internally — the stream goes quiet during tool execution and
   * resumes once the next iteration starts producing text. Exactly one
   * `{ done: true }` chunk is yielded, at the very end of the whole turn
   * (not after each iteration), so callers see one continuous stream per
   * user message regardless of how many tool round-trips happened inside it.
   * That chunk carries the final iteration's `response`, when available.
   */
  streamAgentLoop(
    threadId: ThreadId,
    userContent: string | ContentBlock[],
    opts: AgentLoopOptions,
  ): { stream: AsyncIterable<ProviderStreamChunk>; completion: Promise<Message> } {
    const maxIterations = opts.maxIterations ?? 10;
    const systemPrompt = opts.systemPrompt ?? this.defaultSystemPrompt;

    let resolveCompletion!: (msg: Message) => void;
    let rejectCompletion!: (err: unknown) => void;
    const completion = new Promise<Message>((res, rej) => {
      resolveCompletion = res;
      rejectCompletion = rej;
    });

    const engine = this;

    async function* generateStream(): AsyncIterable<ProviderStreamChunk> {
      try {
        const { thread, userMessage } = await engine._prepareUserMessage(
          threadId,
          userContent,
        );

        let iteration = 0;

        while (iteration < maxIterations) {
          iteration++;

          // Re-fetch history every iteration so intermediate tool messages are included
          const history = await engine.storage.getMessages(threadId);
          const priorHistory = history.slice(0, -1);
          const currentMessage = history[history.length - 1];

          let ctx: SendContext = {
            thread,
            history: priorHistory,
            newMessage: currentMessage,
            systemPrompt,
            tools: opts.tools,
            toolChoice: toolChoiceForIteration(opts.toolChoice, iteration),
            iteration,
            thinking: opts.thinking,
            effort: opts.effort,
            blockBinding: opts.blockBinding,
          };

          ctx = await engine._runBeforeSend(ctx);

          let providerStream: AsyncIterable<ProviderStreamChunk>;
          try {
            providerStream = engine.provider.stream(
              engine._providerInput(ctx, opts.thinkingHistory),
            );
          } catch (err) {
            engine._callOnError(err, 'provider');
            rejectCompletion(err);
            throw err;
          }

          // Accumulate this iteration's output. Text arrives as string deltas;
          // tool_use arrives as a ContentBlock delta (see provider adapters'
          // stream() implementations) — never mixed into the same delta.
          const blockDeltas: ContentBlock[] = [];
          let textBuffer = '';
          let finalResponse: ProviderResponse | undefined;

          try {
            for await (const chunk of providerStream) {
              // Swallow each iteration's own terminal chunk — only one `done`
              // is surfaced to the caller, at the end of the whole loop.
              if (chunk.done) {
                finalResponse = chunk.response;
                continue;
              }
              if (typeof chunk.delta === 'string') {
                textBuffer += chunk.delta;
              } else {
                blockDeltas.push(chunk.delta);
              }
              yield chunk;
            }
          } catch (err) {
            engine._callOnError(err, 'provider');
            throw err;
          }

          const rawResponse = finalResponse ?? assembleStreamedResponse(textBuffer, blockDeltas);

          const assistantMessage = await engine._storeResponse(
            threadId, ctx, userMessage, rawResponse,
          );

          if (rawResponse.stopReason === 'pause_turn') continue;

          const toolUseBlocks = toolUseBlocksOf(rawResponse.content);

          if (rawResponse.stopReason !== 'tool_use' || toolUseBlocks.length === 0) {
            // No tool calls this iteration — the turn is over.
            await engine._runAfterReceive({
              thread,
              userMessage,
              assistantMessage,
              rawResponse,
            });

            yield { delta: '', done: true, ...(finalResponse ? { response: finalResponse } : {}) };
            resolveCompletion(assistantMessage);
            return;
          }

          // Execute all requested tools and persist results, then loop again.
          await engine._runTools(threadId, toolUseBlocks, opts.toolExecutor);
        }

        throw new MaxIterationsExceededError(maxIterations);
      } catch (err) {
        rejectCompletion(err);
        throw err;
      }
    }

    return { stream: generateStream(), completion };
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

  /** Context assembly, then the thinkingHistory step — custom strategies included. */
  private _providerInput(ctx: SendContext, thinkingHistory?: ThinkingHistory): ProviderInput {
    const messages = applyThinkingHistory(
      this.strategy.assemble(ctx.history, ctx.newMessage),
      thinkingHistory ?? this.thinkingHistory,
    );
    return {
      systemPrompt: ctx.systemPrompt,
      messages,
      tools: ctx.tools,
      toolChoice: ctx.toolChoice,
      ...(ctx.thinking !== undefined ? { thinking: ctx.thinking } : {}),
      ...(ctx.effort !== undefined ? { effort: ctx.effort } : {}),
      ...(ctx.blockBinding !== undefined ? { blockBinding: ctx.blockBinding } : {}),
    };
  }

  /**
   * Stores a provider response as the assistant message, with its stopReason
   * and usage in `metadata`, and fires afterProviderCall. Refusals and
   * responses cut off before anything usable are not stored: they throw
   * RefusalError / IncompleteResponseError instead.
   */
  private async _storeResponse(
    threadId: ThreadId,
    ctx: SendContext,
    userMessage: Message,
    response: ProviderResponse,
    content: string | ContentBlock[] = response.content,
  ): Promise<Message> {
    const provider = this.provider.name ?? 'custom';
    let failure: Error | undefined;

    if (response.stopReason === 'refusal') {
      const category = response.stopDetails?.category;
      failure = new RefusalError(
        `The model declined to respond${category ? ` (category: ${category})` : ''}.`,
        { provider, category, explanation: response.stopDetails?.explanation },
      );
    } else if (response.stopReason === 'max_tokens') {
      // Text that was cut off is still an answer. A cut-off tool call can't
      // be run (and a stored tool_use without a result breaks the next
      // request); a thinking-only response has nothing to show.
      const hasText = response.content.some(b => b.type === 'text' && b.text.trim() !== '');
      const hasToolUse = response.content.some(b => b.type === 'tool_use');
      if (!hasText || hasToolUse) {
        failure = new IncompleteResponseError(
          hasToolUse
            ? 'The response hit maxTokens in the middle of a tool call.'
            : 'The response hit maxTokens before producing any text — raise maxTokens or lower effort.',
          { provider, stopReason: response.stopReason },
        );
      }
    }

    if (failure) {
      await this._runAfterProviderCall({
        thread: ctx.thread, userMessage, iteration: ctx.iteration, response,
      });
      this._callOnError(failure, 'provider');
      throw failure;
    }

    const assistantMessage = await this.storage.appendMessage(threadId, {
      threadId,
      role: 'assistant',
      content,
      metadata: { stopReason: response.stopReason, usage: response.usage },
    });

    await this._runAfterProviderCall({
      thread: ctx.thread, userMessage, iteration: ctx.iteration, response, assistantMessage,
    });

    return assistantMessage;
  }

  /** Runs each requested tool and stores its result as a user message. */
  private async _runTools(
    threadId: ThreadId,
    toolUseBlocks: ToolUseBlock[],
    toolExecutor: ToolExecutor,
  ): Promise<void> {
    for (const toolUse of toolUseBlocks) {
      let resultContent: string;
      try {
        const result = await toolExecutor(toolUse.name, toolUse.input);
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

  private async _runAfterProviderCall(ctx: ProviderCallContext): Promise<void> {
    if (!this.hooks.afterProviderCall) return;
    try {
      await this.hooks.afterProviderCall(ctx);
    } catch (err) {
      this._callOnError(err, 'afterProviderCall');
    }
  }

  private _callOnError(
    err: unknown,
    phase: 'beforeSend' | 'provider' | 'toolExecutor' | 'afterReceive' | 'afterProviderCall',
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
  ProviderCallContext,
};
