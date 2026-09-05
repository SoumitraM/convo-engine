/**
 * GatewayProviderAdapter
 *
 * ProviderAdapter implementation targeting an OpenAI-compatible model gateway
 * (IBM TADN cluster — Qwen/Granite models). Implements send() and stream().
 *
 * cacheBreakpoint markers on ProviderMessages are silently ignored — the gateway
 * has no prompt-caching mechanism.
 */

import https from 'node:https';
import type {
  ProviderAdapter,
  ProviderMessage,
  ProviderResponse,
  ProviderStreamChunk,
  ToolDefinition,
} from './types.js';
import type { ContentBlock } from '../../types.js';

// ---------------------------------------------------------------------------
// Options & class
// ---------------------------------------------------------------------------

export interface GatewayProviderAdapterOptions {
  /** Gateway base URL — trailing slash is stripped. */
  baseUrl: string;
  /** Bearer token for Authorization header. Omit header if empty string or undefined. */
  apiKey?: string;
  /** Model name to pass in every request. Default: 'qwen2-5-72b-instruct'. */
  model?: string;
  /** Set false to disable TLS cert validation (self-signed cert). Default: true. Node.js only. */
  tlsRejectUnauthorized?: boolean;
}

export class GatewayProviderAdapter implements ProviderAdapter {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly agent: https.Agent | undefined;

  constructor(options: GatewayProviderAdapterOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.apiKey  = options.apiKey ?? '';
    this.model   = options.model  ?? 'qwen2-5-72b-instruct';
    this.agent   = options.tlsRejectUnauthorized === false
      ? new https.Agent({ rejectUnauthorized: false })
      : undefined;
  }

  // -------------------------------------------------------------------------
  // send() — non-streaming
  // -------------------------------------------------------------------------

  async send(input: {
    systemPrompt?: string;
    messages: ProviderMessage[];
    tools?: ToolDefinition[];
  }): Promise<ProviderResponse> {
    const body = this.buildRequestBody(input, false);

    const response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: this.buildHeaders(),
      body: JSON.stringify(body),
      ...(this.agent ? { agent: this.agent } : {}),
    } as RequestInit);

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`GatewayProviderAdapter: HTTP ${response.status} — ${text}`);
    }

    const completion = await response.json() as Record<string, unknown>;
    return this.parseResponse(completion);
  }

  // -------------------------------------------------------------------------
  // stream() — SSE streaming
  // -------------------------------------------------------------------------

  async *stream(input: {
    systemPrompt?: string;
    messages: ProviderMessage[];
    tools?: ToolDefinition[];
  }): AsyncIterable<ProviderStreamChunk> {
    const body = this.buildRequestBody(input, true);

    const response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: this.buildHeaders(),
      body: JSON.stringify(body),
      ...(this.agent ? { agent: this.agent } : {}),
    } as RequestInit);

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`GatewayProviderAdapter: HTTP ${response.status} — ${text}`);
    }

    if (!response.body) {
      throw new Error('GatewayProviderAdapter: response body is null (streaming)');
    }

    // Buffer for accumulated tool call arguments across SSE chunks
    const toolCallBuffers = new Map<number, {
      id: string; name: string; argumentsRaw: string;
    }>();

    const reader  = response.body.getReader();
    const decoder = new TextDecoder();
    let   leftover = '';

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      const chunk = leftover + decoder.decode(value, { stream: true });
      const lines = chunk.split('\n');
      // Keep the last (possibly incomplete) line as leftover
      leftover = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data:')) continue;

        const payload = trimmed.slice(5).trim();
        if (payload === '[DONE]') {
          // Emit any buffered tool calls before the terminal chunk
          for (const tc of toolCallBuffers.values()) {
            let parsedInput: unknown = {};
            try { parsedInput = JSON.parse(tc.argumentsRaw); } catch { /* fall back */ }
            yield {
              delta: { type: 'tool_use', id: tc.id, name: tc.name, input: parsedInput } as ContentBlock,
              done: false,
            };
          }
          yield { delta: '', done: true };
          return;
        }

        let parsed: Record<string, unknown>;
        try { parsed = JSON.parse(payload) as Record<string, unknown>; } catch { continue; }

        const choices = parsed.choices as Record<string, unknown>[] | undefined;
        const delta   = choices?.[0]?.delta as Record<string, unknown> | undefined;
        if (!delta) continue;

        // Text delta
        if (typeof delta.content === 'string' && delta.content.length > 0) {
          yield { delta: delta.content, done: false };
        }

        // Tool call delta — buffer, do not yield yet
        const toolCallDeltas = delta.tool_calls as Record<string, unknown>[] | undefined;
        if (toolCallDeltas) {
          for (const tc of toolCallDeltas) {
            const index = (tc.index as number) ?? 0;
            const fn    = tc.function as Record<string, unknown> | undefined;
            if (!toolCallBuffers.has(index)) {
              toolCallBuffers.set(index, {
                id:           (tc.id as string)     ?? '',
                name:         (fn?.name as string)  ?? '',
                argumentsRaw: '',
              });
            }
            const buf = toolCallBuffers.get(index)!;
            if (tc.id)       buf.id   = tc.id as string;
            if (fn?.name)    buf.name = fn.name as string;
            if (fn?.arguments) buf.argumentsRaw += fn.arguments as string;
          }
        }
      }
    }

    // Stream ended without [DONE] line — still flush tool call buffers
    for (const tc of toolCallBuffers.values()) {
      let parsedInput: unknown = {};
      try { parsedInput = JSON.parse(tc.argumentsRaw); } catch { /* fall back */ }
      yield {
        delta: { type: 'tool_use', id: tc.id, name: tc.name, input: parsedInput } as ContentBlock,
        done: false,
      };
    }
    yield { delta: '', done: true };
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.apiKey) headers['Authorization'] = `Bearer ${this.apiKey}`;
    return headers;
  }

  private buildRequestBody(
    input: { systemPrompt?: string; messages: ProviderMessage[]; tools?: ToolDefinition[] },
    streaming: boolean,
  ): Record<string, unknown> {
    const messages = this.translateMessages(input.systemPrompt, input.messages);
    const body: Record<string, unknown> = { model: this.model, messages };
    if (streaming) body.stream = true;
    if (input.tools && input.tools.length > 0) {
      body.tools       = this.translateTools(input.tools);
      body.tool_choice = 'auto';
    }
    return body;
  }

  private translateMessages(
    systemPrompt: string | undefined,
    messages: ProviderMessage[],
  ): unknown[] {
    const result: unknown[] = [];

    if (systemPrompt) {
      result.push({ role: 'system', content: systemPrompt });
    }

    for (const msg of messages) {
      if (typeof msg.content === 'string') {
        result.push({ role: msg.role, content: msg.content });
        continue;
      }

      // ContentBlock[] — translate each block
      const toolUseBlocks:    Extract<ContentBlock, { type: 'tool_use' }>[]    = [];
      const textParts:        string[]                                          = [];
      const toolResultBlocks: Extract<ContentBlock, { type: 'tool_result' }>[] = [];

      for (const block of msg.content) {
        if (block.type === 'text') {
          textParts.push(block.text);
        } else if (block.type === 'tool_use') {
          toolUseBlocks.push(block);
        } else if (block.type === 'tool_result') {
          toolResultBlocks.push(block);
        } else if (block.type === 'image') {
          throw new Error('GatewayProviderAdapter: image content blocks are not supported by this provider.');
        }
      }

      // Assistant message with tool_calls
      if (toolUseBlocks.length > 0) {
        result.push({
          role:       'assistant',
          content:    textParts.length > 0 ? textParts.join('\n') : null,
          tool_calls: toolUseBlocks.map(b => ({
            id:   b.id,
            type: 'function',
            function: {
              name:      b.name,
              arguments: JSON.stringify(b.input ?? {}),
            },
          })),
        });
      } else if (textParts.length > 0) {
        result.push({ role: msg.role, content: textParts.join('\n') });
      }

      // Tool results become separate role:'tool' messages
      for (const b of toolResultBlocks) {
        result.push({
          role:         'tool',
          tool_call_id: b.tool_use_id,
          content:      String(b.content ?? ''),
        });
      }
    }

    return result;
  }

  private translateTools(tools: ToolDefinition[]): unknown[] {
    return tools.map(t => ({
      type: 'function',
      function: {
        name:        t.name,
        description: t.description,
        parameters:  t.inputSchema,
      },
    }));
  }

  private parseResponse(completion: Record<string, unknown>): ProviderResponse {
    const choices = completion.choices as Record<string, unknown>[] | undefined;
    const choice  = choices?.[0];
    if (!choice) throw new Error('GatewayProviderAdapter: empty choices in response');

    const message      = choice.message      as Record<string, unknown>;
    const finishReason = choice.finish_reason as string | undefined;
    const usage        = completion.usage     as Record<string, unknown> | undefined;

    const inputTokens  = (usage?.prompt_tokens     as number | undefined) ?? 0;
    const outputTokens = (usage?.completion_tokens as number | undefined) ?? 0;

    const toolCalls = message.tool_calls as Record<string, unknown>[] | undefined;
    if (toolCalls && toolCalls.length > 0) {
      return {
        content: toolCalls.map(tc => {
          const fn = tc.function as Record<string, unknown>;
          let parsedInput: unknown = {};
          try { parsedInput = JSON.parse(fn.arguments as string); } catch { /* fall back */ }
          return {
            type:  'tool_use',
            id:    tc.id,
            name:  fn.name,
            input: parsedInput,
          } as ContentBlock;
        }),
        stopReason: 'tool_use',
        usage: { inputTokens, outputTokens },
      };
    }

    return {
      content:    [{ type: 'text', text: (message.content as string | null) ?? '' }],
      stopReason: finishReason ?? 'stop',
      usage:      { inputTokens, outputTokens },
    };
  }
}

// ---------------------------------------------------------------------------
// Factory function
// ---------------------------------------------------------------------------

/**
 * Constructs a GatewayProviderAdapter from environment variables.
 * Throws if LLM_BASE_URL is not set.
 *
 * Reads:
 *   LLM_BASE_URL                  — required
 *   LLM_API_KEY                   — optional (default: '')
 *   LLM_MODEL                     — optional (default: 'qwen2-5-72b-instruct')
 *   LLM_TLS_REJECT_UNAUTHORIZED   — optional ('false' disables cert validation; default: 'true')
 */
export function createGatewayProviderAdapter(): GatewayProviderAdapter {
  const baseUrl = process.env['LLM_BASE_URL'];
  if (!baseUrl) throw new Error('GatewayProviderAdapter: LLM_BASE_URL environment variable is not set.');

  return new GatewayProviderAdapter({
    baseUrl,
    apiKey:                process.env['LLM_API_KEY'],
    model:                 process.env['LLM_MODEL'],
    tlsRejectUnauthorized: process.env['LLM_TLS_REJECT_UNAUTHORIZED'] !== 'false',
  });
}
