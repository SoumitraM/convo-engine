/**
 * Helpers shared by the provider adapters.
 * Zero runtime dependencies.
 */

import {
  InvalidRequestError,
  ProviderError,
  classifyProviderError,
  type ProviderName,
} from '../../errors.js';
import type { ContentBlock } from '../../types.js';
import type { SystemPrompt, SystemPromptBlock, ToolChoice, ToolDefinition } from './types.js';

/** Normalises a system prompt to its non-empty blocks. */
export function systemPromptBlocks(systemPrompt: SystemPrompt | undefined): SystemPromptBlock[] {
  if (systemPrompt === undefined) return [];
  if (typeof systemPrompt === 'string') {
    return systemPrompt ? [{ text: systemPrompt }] : [];
  }
  return systemPrompt.filter(b => b.text.length > 0);
}

/** For providers without system blocks: the blocks joined by a blank line. */
export function flattenSystemPrompt(systemPrompt: SystemPrompt | undefined): string | undefined {
  const blocks = systemPromptBlocks(systemPrompt);
  return blocks.length > 0 ? blocks.map(b => b.text).join('\n\n') : undefined;
}

/**
 * Rejects tool choices the provider would refuse: forcing a tool with no
 * tools supplied, or naming a tool that isn't in the list.
 */
export function validateToolChoice(
  provider: ProviderName,
  toolChoice: ToolChoice | undefined,
  tools: ToolDefinition[] | undefined,
): void {
  if (toolChoice === undefined || toolChoice === 'auto' || toolChoice === 'none') return;

  const hasTools = tools !== undefined && tools.length > 0;
  if (!hasTools) {
    throw new InvalidRequestError(
      `toolChoice ${JSON.stringify(toolChoice)} requires at least one tool.`,
      { provider },
    );
  }
  if (typeof toolChoice === 'object' && !tools.some(t => t.name === toolChoice.name)) {
    throw new InvalidRequestError(
      `toolChoice names tool "${toolChoice.name}", which is not in the tools list.`,
      { provider },
    );
  }
}

/**
 * Renders a text-source document as plain text, for providers without native
 * document blocks.
 */
export function documentAsText(block: Extract<ContentBlock, { type: 'document' }>): string {
  const attrs = [
    block.title !== undefined ? ` title=${JSON.stringify(block.title)}` : '',
    ` media_type=${JSON.stringify(block.source.media_type)}`,
  ].join('');
  const context = block.context ? `${block.context}\n\n` : '';
  return `<document${attrs}>\n${context}${block.source.data}\n</document>`;
}

/** Constructor names along an object's prototype chain. */
function constructorChain(value: object): string[] {
  const names: string[] = [];
  for (let proto = Object.getPrototypeOf(value); proto && proto !== Object.prototype; proto = Object.getPrototypeOf(proto)) {
    const name = (proto.constructor as { name?: unknown } | undefined)?.name;
    if (typeof name === 'string') names.push(name);
  }
  return names;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Maps an error thrown by the Anthropic or OpenAI SDK onto a ProviderError.
 * Both SDKs derive every API failure from a class named `APIError` (HTTP
 * errors, connection errors, timeouts, and errors that arrive mid-stream), so
 * the match is by name — no SDK import needed. Anything else (a caller abort,
 * a programming error) is returned unchanged.
 */
export function mapSdkError(provider: ProviderName, err: unknown): unknown {
  if (err instanceof ProviderError) return err;
  if (typeof err !== 'object' || err === null) return err;

  const chain = constructorChain(err);
  if (!chain.includes('APIError') || chain.includes('APIUserAbortError')) return err;

  const e = err as {
    status?: unknown; headers?: unknown; error?: unknown;
    code?: unknown; type?: unknown; message?: unknown;
  };
  // Anthropic: error = { type: 'error', error: { type, message } }.
  // OpenAI:    error = { message, type, code }, also copied onto e.code / e.type.
  const body = typeof e.error === 'object' && e.error !== null
    ? e.error as Record<string, unknown>
    : undefined;
  const nested = typeof body?.error === 'object' && body.error !== null
    ? body.error as Record<string, unknown>
    : undefined;
  const errorType =
    asString(nested?.type) ??
    asString(e.code) ??
    asString(body?.code) ??
    asString(e.type) ??
    (body?.type !== 'error' ? asString(body?.type) : undefined);

  return classifyProviderError({
    provider,
    message: asString(e.message) ?? `${provider} request failed`,
    status: typeof e.status === 'number' ? e.status : undefined,
    errorType,
    headers: e.headers,
    cause: err,
  });
}
