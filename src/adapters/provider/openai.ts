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
 * Image and PDF blocks become image_url / file content parts (user messages
 * only); text documents are inlined as text. System prompt blocks are joined.
 * SDK errors are rethrown as ProviderError subclasses (see src/errors.ts).
 */

// eslint-disable-next-line import/no-extraneous-dependencies
import OpenAI from 'openai';

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
import { documentAsText, flattenSystemPrompt, mapSdkError, validateToolChoice } from './shared.js';

export interface OpenAIProviderAdapterOptions {
  apiKey: string;
  model?: string;
  maxTokens?: number;
  baseURL?: string;
  /** SDK-level retries on 408/409/429/5xx and connection errors. SDK default: 2. */
  maxRetries?: number;
  /** Per-request timeout in milliseconds. SDK default: 10 minutes. */
  timeoutMs?: number;
  /** Sampling temperature. Omitted from the request when unset. */
  temperature?: number;
}

export class OpenAIProviderAdapter implements ProviderAdapter {
  private readonly client: OpenAI;
  private readonly model: string;
  private readonly maxTokens: number;
  private readonly temperature?: number;

  constructor(options: OpenAIProviderAdapterOptions) {
    this.client = new OpenAI({
      apiKey: options.apiKey,
      ...(options.baseURL ? { baseURL: options.baseURL } : {}),
      ...(options.maxRetries !== undefined ? { maxRetries: options.maxRetries } : {}),
      ...(options.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
    });
    this.model = options.model ?? 'gpt-4o';
    this.maxTokens = options.maxTokens ?? 4096;
    this.temperature = options.temperature;
  }

  async send(input: ProviderInput): Promise<ProviderResponse> {
    const params: OpenAI.Chat.ChatCompletionCreateParamsNonStreaming = this.buildParams(input);

    let response: OpenAI.Chat.ChatCompletion;
    try {
      response = await this.client.chat.completions.create(params);
    } catch (err) {
      throw mapSdkError('openai', err);
    }
    return parseResponse(response);
  }

  async *stream(input: ProviderInput): AsyncIterable<ProviderStreamChunk> {
    const params: OpenAI.Chat.ChatCompletionCreateParamsStreaming = {
      ...this.buildParams(input),
      stream: true,
    };

    try {
      yield* this.streamChunks(params);
    } catch (err) {
      throw mapSdkError('openai', err);
    }
  }

  private buildParams(input: ProviderInput): OpenAI.Chat.ChatCompletionCreateParamsNonStreaming {
    validateToolChoice('openai', input.toolChoice, input.tools);

    return {
      model: this.model,
      max_tokens: this.maxTokens,
      messages: translateMessages(input.systemPrompt, input.messages),
      ...(input.tools && input.tools.length > 0
        ? { tools: translateTools(input.tools), tool_choice: translateToolChoice(input.toolChoice) }
        : {}),
      ...(this.temperature !== undefined ? { temperature: this.temperature } : {}),
    };
  }

  private async *streamChunks(
    params: OpenAI.Chat.ChatCompletionCreateParamsStreaming,
  ): AsyncIterable<ProviderStreamChunk> {
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
type OpenAIContentPart = OpenAI.Chat.ChatCompletionContentPart;

function translateToolChoice(
  toolChoice: ToolChoice | undefined,
): OpenAI.Chat.ChatCompletionToolChoiceOption {
  if (toolChoice === undefined || toolChoice === 'auto') return 'auto';
  if (toolChoice === 'any') return 'required';
  if (toolChoice === 'none') return 'none';
  return { type: 'function', function: { name: toolChoice.name } };
}

function translateMessages(
  systemPrompt: SystemPrompt | undefined,
  messages: ProviderMessage[],
): OpenAIMessage[] {
  const result: OpenAIMessage[] = [];

  const system = flattenSystemPrompt(systemPrompt);
  if (system) {
    result.push({ role: 'system', content: system });
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
    // All non-tool content in order, as content parts — used only when the
    // message carries an image or PDF (plain text keeps the string form).
    const parts: OpenAIContentPart[] = [];
    let hasMedia = false;

    for (const block of msg.content) {
      switch (block.type) {
        case 'text':
          textParts.push(block.text);
          parts.push({ type: 'text', text: block.text });
          break;
        case 'tool_use':
          toolUseBlocks.push(block);
          break;
        case 'tool_result':
          toolResultBlocks.push(block);
          break;
        case 'image':
          hasMedia = true;
          parts.push({
            type: 'image_url',
            image_url: { url: `data:${block.source.media_type};base64,${block.source.data}` },
          });
          break;
        case 'document':
          if (block.source.type === 'text') {
            const text = documentAsText(block);
            textParts.push(text);
            parts.push({ type: 'text', text });
          } else {
            hasMedia = true;
            parts.push({
              type: 'file',
              file: {
                filename: block.title ?? 'document.pdf',
                file_data: `data:application/pdf;base64,${block.source.data}`,
              },
            });
          }
          break;
      }
    }

    if (hasMedia && msg.role !== 'user') {
      throw new InvalidRequestError(
        `OpenAIProviderAdapter: image and PDF blocks are only supported in user messages (got role '${msg.role}').`,
        { provider: 'openai' },
      );
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
    } else if (hasMedia) {
      result.push({ role: 'user', content: parts });
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
