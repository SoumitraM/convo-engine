/**
 * ClaudeProviderAdapter
 *
 * ProviderAdapter implementation for the Anthropic Claude API.
 * Peer dependency: @anthropic-ai/sdk >= 0.20.0
 *
 * Translates cacheBreakpoint markers (on messages and system prompt blocks)
 * → cache_control: { type: 'ephemeral' }.
 * SDK errors are rethrown as ProviderError subclasses (see src/errors.ts).
 */

// eslint-disable-next-line import/no-extraneous-dependencies
import Anthropic from '@anthropic-ai/sdk';

import type {
  BlockBinding,
  Effort,
  InputTransformation,
  ProviderAdapter,
  ProviderInput,
  ProviderMessage,
  ProviderResponse,
  ProviderStreamChunk,
  SystemPrompt,
  ThinkingConfig,
  ToolChoice,
  ToolDefinition,
} from './types.js';
import type { ContentBlock } from '../../types.js';
import { InvalidRequestError } from '../../errors.js';
import { mapSdkError, systemPromptBlocks, validateToolChoice } from './shared.js';

export interface ClaudeProviderAdapterOptions {
  apiKey: string;
  model?: string;
  maxTokens?: number;
  /** SDK-level retries on 408/409/429/5xx and connection errors. SDK default: 2. */
  maxRetries?: number;
  /** Per-request timeout in milliseconds. SDK default: 10 minutes. */
  timeoutMs?: number;
  /**
   * Sampling temperature (0–1). Omitted from the request when unset.
   * Only valid on API version 2023-06-01 (@anthropic-ai/sdk 0.x): on
   * 2026-10-21 (@anthropic-ai/sdk 1.0+ by default) any temperature returns a
   * 400 on every model.
   */
  temperature?: number;
  /**
   * Default thinking setting; omitted from the request when unset (the model's
   * own default applies — adaptive on the 5.x models). Overridable per call.
   */
  thinking?: ThinkingConfig;
  /** Default `output_config.effort`; omitted when unset. Overridable per call. */
  effort?: Effort;
  /**
   * Sends `thinking.block_binding.prefix_mismatch_behavior` with the
   * `thinking-binding-controls-2026-08-01` beta header. Requires adaptive
   * thinking (sent as `{ type: 'adaptive' }` when `thinking` is unset).
   * Overridable per call.
   */
  blockBinding?: BlockBinding;
}

/** Anthropic's maximum request size. Base64 payloads (PDFs, images) count toward it. */
export const CLAUDE_MAX_REQUEST_BYTES = 32 * 1024 * 1024;

/** Anthropic allows at most this many cache_control breakpoints per request. */
const MAX_CACHE_BREAKPOINTS = 4;

const BLOCK_BINDING_BETA = 'thinking-binding-controls-2026-08-01';

/** Blocks that can't carry cache_control, so a breakpoint goes on the block before them. */
const NO_CACHE_CONTROL = new Set(['thinking', 'redacted_thinking']);

export class ClaudeProviderAdapter implements ProviderAdapter {
  readonly name = 'claude' as const;
  private readonly client: Anthropic;
  private readonly model: string;
  private readonly maxTokens: number;
  private readonly temperature?: number;
  private readonly thinking?: ThinkingConfig;
  private readonly effort?: Effort;
  private readonly blockBinding?: BlockBinding;

  constructor(options: ClaudeProviderAdapterOptions) {
    this.client = new Anthropic({
      apiKey: options.apiKey,
      ...(options.maxRetries !== undefined ? { maxRetries: options.maxRetries } : {}),
      ...(options.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
    });
    this.model = options.model ?? 'claude-haiku-4-5-20251001';
    this.maxTokens = options.maxTokens ?? 8192;
    this.temperature = options.temperature;
    this.thinking = options.thinking;
    this.effort = options.effort;
    this.blockBinding = options.blockBinding;
  }

  async send(input: ProviderInput): Promise<ProviderResponse> {
    const { params, headers } = this.buildParams(input);

    let response: Anthropic.Message;
    try {
      response = await this.client.messages.create(
        params as unknown as Anthropic.MessageCreateParamsNonStreaming,
        headers ? { headers } : undefined,
      );
    } catch (err) {
      throw mapSdkError('claude', err);
    }

    return translateResponse(response);
  }

  async *stream(input: ProviderInput): AsyncIterable<ProviderStreamChunk> {
    const { params, headers } = this.buildParams(input);

    let response: ProviderResponse;
    try {
      const stream = this.client.messages.stream(
        { ...params, stream: true } as unknown as Anthropic.MessageCreateParamsStreaming,
        headers ? { headers } : undefined,
      );

      // Thinking text and signatures arrive as thinking_delta / signature_delta
      // events, which older SDKs leave out of finalMessage(). Accumulate them
      // here so the signature survives whatever SDK version is installed.
      const thinkingByIndex = new Map<number, { thinking: string; signature: string }>();
      // Older SDKs also don't copy message_delta's stop_details into finalMessage().
      let streamedStopDetails: Record<string, unknown> | undefined;

      for await (const rawEvent of stream) {
        const event = rawEvent as unknown as StreamEvent;
        if (event.type === 'content_block_start') {
          const block = event.content_block ?? {};
          if (block['type'] === 'thinking') {
            thinkingByIndex.set(event.index ?? 0, {
              thinking: typeof block['thinking'] === 'string' ? block['thinking'] : '',
              signature: typeof block['signature'] === 'string' ? block['signature'] : '',
            });
          }
          if (block['type'] === 'thinking' || block['type'] === 'redacted_thinking') {
            yield { delta: '', done: false, thinking: true };
          }
        } else if (event.type === 'content_block_delta') {
          const delta = event.delta ?? {};
          if (delta['type'] === 'text_delta' && typeof delta['text'] === 'string') {
            yield { delta: delta['text'], done: false };
          } else if (delta['type'] === 'thinking_delta' && typeof delta['thinking'] === 'string') {
            const acc = thinkingByIndex.get(event.index ?? 0);
            if (acc) acc.thinking += delta['thinking'];
            if (delta['thinking']) {
              yield { delta: '', done: false, thinking: true, thinkingDelta: delta['thinking'] };
            }
          } else if (delta['type'] === 'signature_delta' && typeof delta['signature'] === 'string') {
            const acc = thinkingByIndex.get(event.index ?? 0);
            if (acc) acc.signature += delta['signature'];
          }
        } else if (event.type === 'message_delta') {
          const details = event.delta?.['stop_details'];
          if (details && typeof details === 'object') {
            streamedStopDetails = details as Record<string, unknown>;
          }
        }
      }

      // Tool calls arrive as input_json_delta events accumulated across the
      // stream — rather than re-parsing those ourselves, use the SDK's own
      // accumulation and pull the blocks out of the finished message.
      const finalMessage = await stream.finalMessage();
      const finalRaw = finalMessage as unknown as Record<string, unknown>;
      response = translateResponse(
        (finalRaw['stop_details'] || !streamedStopDetails
          ? finalMessage
          : { ...finalRaw, stop_details: streamedStopDetails }) as Anthropic.Message,
        thinkingByIndex,
      );
    } catch (err) {
      // Includes errors that arrive mid-stream (e.g. overloaded_error events).
      throw mapSdkError('claude', err);
    }

    for (const block of response.content) {
      if (block.type === 'tool_use') yield { delta: block, done: false };
    }

    yield { delta: '', done: true, response };
  }

  /**
   * Request fields shared by send() and stream(). Validation happens here, so
   * invalid input fails before anything is sent.
   */
  private buildParams(input: ProviderInput): {
    params: Record<string, unknown>;
    headers?: Record<string, string>;
  } {
    validateToolChoice('claude', input.toolChoice, input.tools);
    const thinking = buildThinking(
      input.thinking ?? this.thinking,
      input.blockBinding ?? this.blockBinding,
    );
    const effort = input.effort ?? this.effort;

    const { anthropicMessages, systemBlocks } = translateMessages(
      input.systemPrompt,
      input.messages,
    );
    checkRequestLimits(systemBlocks, anthropicMessages);

    const hasTools = input.tools !== undefined && input.tools.length > 0;

    const params = {
      model: this.model,
      max_tokens: this.maxTokens,
      messages: anthropicMessages,
      ...(systemBlocks.length > 0 ? { system: systemBlocks } : {}),
      ...(hasTools ? { tools: translateTools(input.tools!) } : {}),
      ...(hasTools && input.toolChoice !== undefined
        ? { tool_choice: translateToolChoice(input.toolChoice) }
        : {}),
      ...(this.temperature !== undefined ? { temperature: this.temperature } : {}),
      ...(thinking ? { thinking } : {}),
      ...(effort !== undefined ? { output_config: { effort } } : {}),
    };

    // The beta header goes in request options rather than via
    // client.beta.messages, which older 0.x SDKs don't have.
    return thinking && 'block_binding' in thinking
      ? { params, headers: { 'anthropic-beta': BLOCK_BINDING_BETA } }
      : { params };
  }
}

/** The request's `thinking` field, or undefined to leave it out. */
function buildThinking(
  thinking: ThinkingConfig | undefined,
  blockBinding: BlockBinding | undefined,
): Record<string, unknown> | undefined {
  if (blockBinding === undefined) return thinking ? { ...thinking } : undefined;

  if (thinking && thinking.type !== 'adaptive') {
    throw new InvalidRequestError(
      `blockBinding requires adaptive thinking; got thinking.type '${thinking.type}'.`,
      { provider: 'claude' },
    );
  }
  return {
    type: 'adaptive',
    ...(thinking?.display !== undefined ? { display: thinking.display } : {}),
    block_binding: { prefix_mismatch_behavior: blockBinding },
  };
}

// ---------------------------------------------------------------------------
// Translation helpers
// ---------------------------------------------------------------------------

type AnthropicMessage = Anthropic.MessageParam;
type AnthropicSystemBlock = Anthropic.Messages.TextBlockParam & {
  cache_control?: { type: 'ephemeral' };
};

function translateToolChoice(toolChoice: ToolChoice): Record<string, unknown> {
  if (typeof toolChoice === 'object') return { type: 'tool', name: toolChoice.name };
  return { type: toolChoice };
}

function translateMessages(
  systemPrompt: SystemPrompt | undefined,
  messages: ProviderMessage[],
): { anthropicMessages: AnthropicMessage[]; systemBlocks: AnthropicSystemBlock[] } {
  const systemBlocks: AnthropicSystemBlock[] = systemPromptBlocks(systemPrompt).map(b => ({
    type: 'text',
    text: b.text,
    ...(b.cacheBreakpoint ? { cache_control: { type: 'ephemeral' } } : {}),
  }));

  const anthropicMessages: AnthropicMessage[] = [];

  messages.forEach((msg, idx) => {
    const isLast = idx === messages.length - 1;
    const withCache = msg.cacheBreakpoint && !isLast; // breakpoint on last before new msg

    if (typeof msg.content === 'string') {
      if (msg.content.trim() === '') {
        rejectOrSkipEmpty(msg, idx);
        return;
      }
      const block: Anthropic.TextBlockParam & { cache_control?: { type: 'ephemeral' } } = {
        type: 'text',
        text: msg.content,
        ...(withCache ? { cache_control: { type: 'ephemeral' } } : {}),
      };
      anthropicMessages.push({ role: msg.role as 'user' | 'assistant', content: [block] });
      return;
    }

    // ContentBlock[]
    type AnyBlock = { type: string; [key: string]: unknown };
    const blocks: AnyBlock[] = [];

    for (const block of msg.content) {
      switch (block.type) {
        case 'text': {
          // The API rejects empty text blocks (0.3.0 stored one for every
          // thinking block it didn't recognise).
          if (block.text.trim() !== '') blocks.push({ type: 'text', text: block.text });
          break;
        }
        case 'tool_use': {
          blocks.push({
            type: 'tool_use',
            id: block.id,
            name: block.name,
            input: block.input,
          });
          break;
        }
        case 'tool_result': {
          blocks.push({
            type: 'tool_result',
            tool_use_id: block.tool_use_id,
            content: block.content,
          });
          break;
        }
        case 'image': {
          blocks.push({
            type: 'image',
            source: {
              type: 'base64',
              media_type: block.source.media_type,
              data: block.source.data,
            },
          });
          break;
        }
        case 'document': {
          blocks.push({
            type: 'document',
            // Claude's text source only accepts text/plain — CSV is sent as plain text.
            source: block.source.type === 'base64'
              ? { type: 'base64', media_type: 'application/pdf', data: block.source.data }
              : { type: 'text', media_type: 'text/plain', data: block.source.data },
            ...(block.title !== undefined ? { title: block.title } : {}),
            ...(block.context !== undefined ? { context: block.context } : {}),
          });
          break;
        }
        // Sent back exactly as received — the signature covers the text, and
        // an empty `thinking` is normal (display 'omitted').
        case 'thinking': {
          blocks.push({ type: 'thinking', thinking: block.thinking, signature: block.signature });
          break;
        }
        case 'redacted_thinking': {
          blocks.push({ type: 'redacted_thinking', data: block.data });
          break;
        }
        case 'provider_raw': {
          if (block.provider === 'claude') blocks.push({ ...block.block } as AnyBlock);
          break;
        }
        default: {
          const unknownBlock: never = block;
          throw new InvalidRequestError(
            `Unsupported content block type '${(unknownBlock as { type: string }).type}'.`,
            { provider: 'claude' },
          );
        }
      }
    }

    if (blocks.length === 0) {
      rejectOrSkipEmpty(msg, idx);
      return;
    }

    // Apply cache_control to the last block that can carry it.
    if (msg.cacheBreakpoint) {
      for (let i = blocks.length - 1; i >= 0; i--) {
        if (!NO_CACHE_CONTROL.has(blocks[i].type)) {
          blocks[i]['cache_control'] = { type: 'ephemeral' };
          break;
        }
      }
    }

    anthropicMessages.push({
      role: msg.role as 'user' | 'assistant',
      content: blocks as unknown as Anthropic.MessageParam['content'],
    });
  });

  return { anthropicMessages, systemBlocks };
}

/**
 * A message with nothing left to send. An assistant message is dropped — it
 * carried nothing the model can use (e.g. a 0.3.0-era `[{ text: '' }]`), and
 * the API merges the user turns around it. Anything else is a caller error.
 */
function rejectOrSkipEmpty(msg: ProviderMessage, idx: number): void {
  if (msg.role === 'assistant') return;
  throw new InvalidRequestError(
    `messages[${idx}] (role '${msg.role}') has no content to send — empty text blocks are not allowed.`,
    { provider: 'claude' },
  );
}

/**
 * Fails before sending, with a clear message, on requests the API would
 * reject with a 400: too many cache breakpoints, or base64 payloads over the
 * request size limit. (PDF page limits vary by model and need the PDF parsed,
 * so they are left to the API — its error is mapped to InvalidRequestError.)
 */
function checkRequestLimits(
  systemBlocks: AnthropicSystemBlock[],
  messages: AnthropicMessage[],
): void {
  let breakpoints = systemBlocks.filter(b => b.cache_control).length;
  let base64Bytes = 0;

  for (const msg of messages) {
    if (typeof msg.content === 'string') continue;
    for (const block of msg.content as unknown as Record<string, unknown>[]) {
      if (block['cache_control']) breakpoints++;
      const source = block['source'] as { type?: string; data?: string } | undefined;
      if (source?.type === 'base64' && typeof source.data === 'string') {
        base64Bytes += source.data.length;
      }
    }
  }

  if (breakpoints > MAX_CACHE_BREAKPOINTS) {
    throw new InvalidRequestError(
      `Request has ${breakpoints} cache breakpoints; Claude allows at most ${MAX_CACHE_BREAKPOINTS} ` +
      `(system prompt blocks plus message breakpoints).`,
      { provider: 'claude' },
    );
  }
  if (base64Bytes > CLAUDE_MAX_REQUEST_BYTES) {
    const mb = (base64Bytes / (1024 * 1024)).toFixed(1);
    throw new InvalidRequestError(
      `Attached documents/images total ${mb} MB base64-encoded; Claude's request limit is 32 MB.`,
      { provider: 'claude' },
    );
  }
}

function translateTools(tools: ToolDefinition[]): Anthropic.Tool[] {
  return tools.map(t => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
  }));
}

/** The subset of raw stream events stream() reads. */
interface StreamEvent {
  type: string;
  index?: number;
  content_block?: Record<string, unknown>;
  delta?: Record<string, unknown>;
}

function translateResponse(
  response: Anthropic.Message,
  streamedThinking?: Map<number, { thinking: string; signature: string }>,
): ProviderResponse {
  const raw = response as unknown as Record<string, unknown>;
  const rawBlocks = response.content as unknown as Record<string, unknown>[];

  const content: ContentBlock[] = rawBlocks.map((block, index) => {
    switch (block['type']) {
      case 'text':
        return { type: 'text', text: block['text'] as string };
      case 'tool_use':
        return {
          type: 'tool_use',
          id: block['id'] as string,
          name: block['name'] as string,
          input: block['input'] as Record<string, unknown>,
        };
      case 'thinking': {
        const streamed = streamedThinking?.get(index);
        return {
          type: 'thinking',
          thinking: streamed?.thinking || (block['thinking'] as string | undefined) || '',
          signature: streamed?.signature || (block['signature'] as string | undefined) || '',
        };
      }
      case 'redacted_thinking':
        return { type: 'redacted_thinking', data: block['data'] as string };
      default:
        // Kept verbatim so it can be sent back unchanged — dropping a block
        // from the middle of a turn can invalidate later thinking blocks.
        return { type: 'provider_raw', provider: 'claude', block: { ...block } };
    }
  });

  const stopReason =
    response.stop_reason === 'tool_use'
      ? 'tool_use'
      : response.stop_reason ?? 'stop';

  const stopDetailsRaw = raw['stop_details'] as Record<string, unknown> | null | undefined;
  const stopDetails = stopDetailsRaw
    ? {
        ...(typeof stopDetailsRaw['category'] === 'string' ? { category: stopDetailsRaw['category'] } : {}),
        ...(typeof stopDetailsRaw['explanation'] === 'string' ? { explanation: stopDetailsRaw['explanation'] } : {}),
      }
    : undefined;
  const inputTransformations = Array.isArray(raw['input_transformations'])
    ? raw['input_transformations'] as InputTransformation[]
    : undefined;

  const usageAny = response.usage as unknown as Record<string, unknown>;
  return {
    content,
    stopReason,
    usage: {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      cacheReadTokens: usageAny['cache_read_input_tokens'] as number | undefined,
      cacheWriteTokens: usageAny['cache_creation_input_tokens'] as number | undefined,
    },
    ...(stopDetails ? { stopDetails } : {}),
    ...(inputTransformations ? { inputTransformations } : {}),
  };
}
