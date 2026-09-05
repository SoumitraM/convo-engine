/**
 * ClaudeProviderAdapter
 *
 * ProviderAdapter implementation for the Anthropic Claude API.
 * Peer dependency: @anthropic-ai/sdk >= 0.20.0
 *
 * Translates cacheBreakpoint markers → cache_control: { type: 'ephemeral' }.
 */

// eslint-disable-next-line import/no-extraneous-dependencies
import Anthropic from '@anthropic-ai/sdk';

import type {
  ProviderAdapter,
  ProviderMessage,
  ProviderResponse,
  ProviderStreamChunk,
  ToolDefinition,
} from './types.js';
import type { ContentBlock } from '../../types.js';

export interface ClaudeProviderAdapterOptions {
  apiKey: string;
  model?: string;
  maxTokens?: number;
}

export class ClaudeProviderAdapter implements ProviderAdapter {
  private readonly client: Anthropic;
  private readonly model: string;
  private readonly maxTokens: number;

  constructor(options: ClaudeProviderAdapterOptions) {
    this.client = new Anthropic({ apiKey: options.apiKey });
    this.model = options.model ?? 'claude-3-5-sonnet-20241022';
    this.maxTokens = options.maxTokens ?? 8192;
  }

  async send(input: {
    systemPrompt?: string;
    messages: ProviderMessage[];
    tools?: ToolDefinition[];
  }): Promise<ProviderResponse> {
    const { anthropicMessages, systemBlocks } = translateMessages(
      input.systemPrompt,
      input.messages,
    );

    const params: Anthropic.MessageCreateParamsNonStreaming = {
      model: this.model,
      max_tokens: this.maxTokens,
      messages: anthropicMessages,
      ...(systemBlocks.length > 0 ? { system: systemBlocks } : {}),
      ...(input.tools && input.tools.length > 0
        ? { tools: translateTools(input.tools) }
        : {}),
    };

    const response = await this.client.messages.create(params);

    return translateResponse(response);
  }

  async *stream(input: {
    systemPrompt?: string;
    messages: ProviderMessage[];
    tools?: ToolDefinition[];
  }): AsyncIterable<ProviderStreamChunk> {
    const { anthropicMessages, systemBlocks } = translateMessages(
      input.systemPrompt,
      input.messages,
    );

    const params: Anthropic.MessageCreateParamsStreaming = {
      model: this.model,
      max_tokens: this.maxTokens,
      messages: anthropicMessages,
      stream: true,
      ...(systemBlocks.length > 0 ? { system: systemBlocks } : {}),
      ...(input.tools && input.tools.length > 0
        ? { tools: translateTools(input.tools) }
        : {}),
    };

    const stream = this.client.messages.stream(params);

    for await (const event of stream) {
      if (
        event.type === 'content_block_delta' &&
        event.delta.type === 'text_delta'
      ) {
        yield { delta: event.delta.text, done: false };
      }
    }

    yield { delta: '', done: true };
  }
}

// ---------------------------------------------------------------------------
// Translation helpers
// ---------------------------------------------------------------------------

type AnthropicMessage = Anthropic.MessageParam;
type AnthropicSystemBlock = Anthropic.Messages.TextBlockParam & {
  cache_control?: { type: 'ephemeral' };
};

function translateMessages(
  systemPrompt: string | undefined,
  messages: ProviderMessage[],
): { anthropicMessages: AnthropicMessage[]; systemBlocks: AnthropicSystemBlock[] } {
  const systemBlocks: AnthropicSystemBlock[] = systemPrompt
    ? [{ type: 'text', text: systemPrompt }]
    : [];

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
