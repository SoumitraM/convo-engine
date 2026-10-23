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
  ProviderAdapter,
  ProviderInput,
  ProviderMessage,
  ProviderResponse,
  ProviderStreamChunk,
  SystemPrompt,
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
}

/** Anthropic's maximum request size. Base64 payloads (PDFs, images) count toward it. */
export const CLAUDE_MAX_REQUEST_BYTES = 32 * 1024 * 1024;

/** Anthropic allows at most this many cache_control breakpoints per request. */
const MAX_CACHE_BREAKPOINTS = 4;

export class ClaudeProviderAdapter implements ProviderAdapter {
  private readonly client: Anthropic;
  private readonly model: string;
  private readonly maxTokens: number;
  private readonly temperature?: number;

  constructor(options: ClaudeProviderAdapterOptions) {
    this.client = new Anthropic({
      apiKey: options.apiKey,
      ...(options.maxRetries !== undefined ? { maxRetries: options.maxRetries } : {}),
      ...(options.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
    });
    this.model = options.model ?? 'claude-haiku-4-5-20251001';
    this.maxTokens = options.maxTokens ?? 8192;
    this.temperature = options.temperature;
  }

  async send(input: ProviderInput): Promise<ProviderResponse> {
    const params = this.buildParams(input) as unknown as Anthropic.MessageCreateParamsNonStreaming;

    let response: Anthropic.Message;
    try {
      response = await this.client.messages.create(params);
    } catch (err) {
      throw mapSdkError('claude', err);
    }

    return translateResponse(response);
  }

  async *stream(input: ProviderInput): AsyncIterable<ProviderStreamChunk> {
    const params = {
      ...this.buildParams(input),
      stream: true,
    } as unknown as Anthropic.MessageCreateParamsStreaming;

    try {
      const stream = this.client.messages.stream(params);

      for await (const event of stream) {
        if (
          event.type === 'content_block_delta' &&
          event.delta.type === 'text_delta'
        ) {
          yield { delta: event.delta.text, done: false };
        }
      }

      // Tool calls arrive as input_json_delta events accumulated across the
      // stream — rather than re-parsing those ourselves, use the SDK's own
      // accumulation and pull tool_use blocks out of the finished message.
      const finalMessage = await stream.finalMessage();
      for (const block of finalMessage.content) {
        if (block.type === 'tool_use') {
          yield {
            delta: {
              type: 'tool_use',
              id: block.id,
              name: block.name,
              input: block.input as Record<string, unknown>,
            },
            done: false,
          };
        }
      }
    } catch (err) {
      // Includes errors that arrive mid-stream (e.g. overloaded_error events).
      throw mapSdkError('claude', err);
    }

    yield { delta: '', done: true };
  }

  /**
   * Request fields shared by send() and stream(). Validation happens here, so
   * invalid input fails before anything is sent.
   */
  private buildParams(input: ProviderInput): Record<string, unknown> {
    validateToolChoice('claude', input.toolChoice, input.tools);

    const { anthropicMessages, systemBlocks } = translateMessages(
      input.systemPrompt,
      input.messages,
    );
    checkRequestLimits(systemBlocks, anthropicMessages);

    const hasTools = input.tools !== undefined && input.tools.length > 0;

    return {
      model: this.model,
      max_tokens: this.maxTokens,
      messages: anthropicMessages,
      ...(systemBlocks.length > 0 ? { system: systemBlocks } : {}),
      ...(hasTools ? { tools: translateTools(input.tools!) } : {}),
      ...(hasTools && input.toolChoice !== undefined
        ? { tool_choice: translateToolChoice(input.toolChoice) }
        : {}),
      ...(this.temperature !== undefined ? { temperature: this.temperature } : {}),
    };
  }
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

  const anthropicMessages: AnthropicMessage[] = messages.map((msg, idx) => {
    const isLast = idx === messages.length - 1;
    const withCache = msg.cacheBreakpoint && !isLast; // breakpoint on last before new msg

    if (typeof msg.content === 'string') {
      const block: Anthropic.TextBlockParam & { cache_control?: { type: 'ephemeral' } } = {
        type: 'text',
        text: msg.content,
        ...(withCache ? { cache_control: { type: 'ephemeral' } } : {}),
      };
      return { role: msg.role as 'user' | 'assistant', content: [block] };
    }

    // ContentBlock[]
    type AnyBlock = { type: string; [key: string]: unknown };
    const blocks: AnyBlock[] = [];

    for (const block of msg.content) {
      switch (block.type) {
        case 'text': {
          blocks.push({ type: 'text', text: block.text });
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
      }
    }

    // Apply cache_control to the last block of this message if cacheBreakpoint is set
    if (msg.cacheBreakpoint && blocks.length > 0) {
      (blocks[blocks.length - 1] as Record<string, unknown>)['cache_control'] = {
        type: 'ephemeral',
      };
    }

    return { role: msg.role as 'user' | 'assistant', content: blocks as unknown as Anthropic.MessageParam['content'] };
  });

  return { anthropicMessages, systemBlocks };
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

function translateResponse(response: Anthropic.Message): ProviderResponse {
  const content: ContentBlock[] = response.content.map(block => {
    if (block.type === 'text') {
      return { type: 'text', text: block.text };
    }
    if (block.type === 'tool_use') {
      return {
        type: 'tool_use',
        id: block.id,
        name: block.name,
        input: block.input as Record<string, unknown>,
      };
    }
    // Fallback for unexpected block types
    return { type: 'text', text: '' };
  });

  const stopReason =
    response.stop_reason === 'tool_use'
      ? 'tool_use'
      : response.stop_reason ?? 'stop';

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
  };
}
