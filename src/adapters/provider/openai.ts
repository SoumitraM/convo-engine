/**
 * OpenAIProviderAdapter
 *
 * ProviderAdapter implementation for the OpenAI Chat Completions API.
 * Peer dependency: openai >= 4.0.0
 *
 * cacheBreakpoint markers are silently ignored — OpenAI has no equivalent
 * prompt-caching mechanism at this time.
 * tool_result ContentBlocks are emitted as standalone role:'tool' messages.
 * Streaming tool calls are buffered and flushed as a single chunk.
 */

// eslint-disable-next-line import/no-extraneous-dependencies
import OpenAI from 'openai';

import type {
  ProviderAdapter,
  ProviderMessage,
  ProviderResponse,
  ProviderStreamChunk,
  ToolDefinition,
} from './types.js';
import type { ContentBlock } from '../../types.js';

export interface OpenAIProviderAdapterOptions {
  apiKey: string;
  model?: string;
  maxTokens?: number;
  baseURL?: string;
}

export class OpenAIProviderAdapter implements ProviderAdapter {
  private readonly client: OpenAI;
  private readonly model: string;
  private readonly maxTokens: number;

  constructor(options: OpenAIProviderAdapterOptions) {
    this.client = new OpenAI({
      apiKey: options.apiKey,
      ...(options.baseURL ? { baseURL: options.baseURL } : {}),
    });
    this.model = options.model ?? 'gpt-4o';
    this.maxTokens = options.maxTokens ?? 4096;
  }

  async send(input: {
    systemPrompt?: string;
    messages: ProviderMessage[];
    tools?: ToolDefinition[];
  }): Promise<ProviderResponse> {
    const openaiMessages = translateMessages(input.systemPrompt, input.messages);

    const params: OpenAI.Chat.ChatCompletionCreateParamsNonStreaming = {
      model: this.model,
      max_tokens: this.maxTokens,
      messages: openaiMessages,
      ...(input.tools && input.tools.length > 0
        ? { tools: translateTools(input.tools), tool_choice: 'auto' as const }
        : {}),
    };

    const response = await this.client.chat.completions.create(params);
    return parseResponse(response);
  }

  async *stream(input: {
    systemPrompt?: string;
    messages: ProviderMessage[];
    tools?: ToolDefinition[];
  }): AsyncIterable<ProviderStreamChunk> {
    const openaiMessages = translateMessages(input.systemPrompt, input.messages);

    const params: OpenAI.Chat.ChatCompletionCreateParamsStreaming = {
      model: this.model,
      max_tokens: this.maxTokens,
      messages: openaiMessages,
      stream: true,
      ...(input.tools && input.tools.length > 0
        ? { tools: translateTools(input.tools), tool_choice: 'auto' as const }
        : {}),
    };

    const stream = await this.client.chat.completions.create(params);

    // Buffer for accumulating tool call deltas
    const toolCallBuffers = new Map<number, { id: string; name: string; argumentsRaw: string }>();

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta;
      if (!delta) continue;

      // Text delta — yield immediately
      if (typeof delta.content === 'string' && delta.content.length > 0) {
        yield { delta: delta.content, done: false };
      }

      // Tool call delta — buffer, do not yield yet
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const index = tc.index ?? 0;
          if (!toolCallBuffers.has(index)) {
            toolCallBuffers.set(index, { id: '', name: '', argumentsRaw: '' });
          }
          const buf = toolCallBuffers.get(index)!;
          if (tc.id) buf.id = tc.id;
          if (tc.function?.name) buf.name = tc.function.name;
          if (tc.function?.arguments) buf.argumentsRaw += tc.function.arguments;
        }
      }
    }

    // Flush buffered tool calls before terminal chunk
    for (const tc of toolCallBuffers.values()) {
      let parsedInput: unknown = {};
      try { parsedInput = JSON.parse(tc.argumentsRaw); } catch { /* fall back */ }
      yield {
        delta: { type: 'tool_use', id: tc.id, name: tc.name, input: parsedInput as Record<string, unknown> } satisfies ContentBlock,
        done: false,
      };
    }

    yield { delta: '', done: true };
  }
}

// ---------------------------------------------------------------------------
// Translation helpers
// ---------------------------------------------------------------------------

type OpenAIMessage = OpenAI.Chat.ChatCompletionMessageParam;

function translateMessages(
  systemPrompt: string | undefined,
  messages: ProviderMessage[],
): OpenAIMessage[] {
  const result: OpenAIMessage[] = [];

  if (systemPrompt) {
    result.push({ role: 'system', content: systemPrompt });
  }

  for (const msg of messages) {
    if (typeof msg.content === 'string') {
      result.push({ role: msg.role as 'user' | 'assistant', content: msg.content });
      continue;
    }

    // ContentBlock[]
    const toolUseBlocks: Extract<ContentBlock, { type: 'tool_use' }>[] = [];
    const textParts: string[] = [];
    const toolResultBlocks: Extract<ContentBlock, { type: 'tool_result' }>[] = [];

    for (const block of msg.content) {
      switch (block.type) {
        case 'text':
          textParts.push(block.text);
          break;
        case 'tool_use':
          toolUseBlocks.push(block);
          break;
        case 'tool_result':
          toolResultBlocks.push(block);
          break;
        case 'image':
          // OpenAI supports images but we skip for simplicity / spec alignment
          break;
      }
    }

    // Assistant message with tool calls
    if (toolUseBlocks.length > 0) {
      result.push({
        role: 'assistant',
        content: textParts.length > 0 ? textParts.join('\n') : null,
        tool_calls: toolUseBlocks.map(b => ({
          id: b.id,
          type: 'function' as const,
          function: {
            name: b.name,
            arguments: JSON.stringify(b.input ?? {}),
          },
        })),
      });
    } else if (textParts.length > 0) {
      result.push({ role: msg.role as 'user' | 'assistant', content: textParts.join('\n') });
    }

    // Tool results as separate role:'tool' messages
    for (const b of toolResultBlocks) {
      result.push({
        role: 'tool',
        tool_call_id: b.tool_use_id,
        content: String(b.content ?? ''),
      });
    }
  }

  return result;
}

function translateTools(tools: ToolDefinition[]): OpenAI.Chat.ChatCompletionTool[] {
  return tools.map(t => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.inputSchema as OpenAI.FunctionParameters,
    },
  }));
}

function parseResponse(response: OpenAI.Chat.ChatCompletion): ProviderResponse {
  const choice = response.choices[0];
  if (!choice) throw new Error('OpenAIProviderAdapter: empty choices in response');

  const message = choice.message;
  const toolCalls = message.tool_calls;

  if (toolCalls && toolCalls.length > 0) {
    return {
      content: toolCalls.map(tc => {
        let parsedInput: unknown = {};
        try { parsedInput = JSON.parse(tc.function.arguments); } catch { /* fall back */ }
        return {
          type: 'tool_use',
          id: tc.id,
          name: tc.function.name,
          input: parsedInput as Record<string, unknown>,
        } satisfies ContentBlock;
      }),
      stopReason: 'tool_use',
      usage: {
        inputTokens: response.usage?.prompt_tokens ?? 0,
        outputTokens: response.usage?.completion_tokens ?? 0,
      },
    };
  }

  return {
    content: [{ type: 'text', text: message.content ?? '' }],
    stopReason: choice.finish_reason ?? 'stop',
    usage: {
      inputTokens: response.usage?.prompt_tokens ?? 0,
      outputTokens: response.usage?.completion_tokens ?? 0,
    },
  };
}
