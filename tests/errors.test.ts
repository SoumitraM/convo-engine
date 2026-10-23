/**
 * Provider error classes and the helpers adapters use to build them.
 */

import { describe, it, expect } from 'vitest';
import {
  ProviderError,
  RateLimitError,
  OverloadedError,
  ContextLengthError,
  AuthenticationError,
  InvalidRequestError,
  classifyProviderError,
  parseRetryAfterMs,
} from '../src/errors.js';
import * as rootExports from '../src/index.js';

describe('ProviderError classes', () => {
  it('subclasses are instanceof themselves, ProviderError and Error', () => {
    const err = new RateLimitError('slow down', { provider: 'claude', status: 429, retryAfterMs: 1000 });
    expect(err).toBeInstanceOf(RateLimitError);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(OverloadedError);
    expect(err.name).toBe('RateLimitError');
    expect(err.retryable).toBe(true);
    expect(err.retryAfterMs).toBe(1000);
    expect(err.status).toBe(429);
    expect(err.provider).toBe('claude');
  });

  it('keeps the cause', () => {
    const cause = new Error('underlying');
    const err = new InvalidRequestError('bad', { provider: 'openai', cause });
    expect(err.cause).toBe(cause);
    expect(err.retryable).toBe(false);
  });

  it('instanceof works across duplicated copies of the classes (separately bundled entry points)', () => {
    // An error built by another copy of the module carries the same brand but a
    // different prototype — simulate it with a plain Error tagged the same way.
    const original = new OverloadedError('busy', { provider: 'claude', status: 529 });
    const kindsSymbol = Object.getOwnPropertySymbols(original)[0];
    const foreign = Object.assign(new Error('busy'), {});
    Object.defineProperty(foreign, kindsSymbol, {
      value: (original as unknown as Record<symbol, unknown>)[kindsSymbol],
    });

    expect(foreign).toBeInstanceOf(OverloadedError);
    expect(foreign).toBeInstanceOf(ProviderError);
    expect(foreign).not.toBeInstanceOf(RateLimitError);
    expect(new Error('plain')).not.toBeInstanceOf(ProviderError);
    expect(null as unknown).not.toBeInstanceOf(ProviderError);
  });

  it('is exported from the package root', () => {
    expect(rootExports.ProviderError).toBe(ProviderError);
    expect(rootExports.RateLimitError).toBe(RateLimitError);
    expect(rootExports.OverloadedError).toBe(OverloadedError);
    expect(rootExports.ContextLengthError).toBe(ContextLengthError);
    expect(rootExports.AuthenticationError).toBe(AuthenticationError);
    expect(rootExports.InvalidRequestError).toBe(InvalidRequestError);
  });
});

describe('parseRetryAfterMs', () => {
  it('reads seconds', () => {
    expect(parseRetryAfterMs({ 'retry-after': '20' })).toBe(20_000);
  });

  it('prefers retry-after-ms', () => {
    expect(parseRetryAfterMs({ 'retry-after-ms': '1500', 'retry-after': '20' })).toBe(1500);
  });

  it('reads an HTTP date', () => {
    const now = Date.parse('2026-10-22T10:00:00Z');
    expect(parseRetryAfterMs({ 'retry-after': 'Thu, 22 Oct 2026 10:00:30 GMT' }, now)).toBe(30_000);
  });

  it('works with a fetch Headers object and is case-insensitive', () => {
    expect(parseRetryAfterMs(new Headers({ 'Retry-After': '3' }))).toBe(3000);
    expect(parseRetryAfterMs({ 'Retry-After': '4' })).toBe(4000);
  });

  it('returns undefined when absent or unparseable', () => {
    expect(parseRetryAfterMs(undefined)).toBeUndefined();
    expect(parseRetryAfterMs({})).toBeUndefined();
    expect(parseRetryAfterMs({ 'retry-after': 'soon' })).toBeUndefined();
  });
});

describe('classifyProviderError', () => {
  const classify = (status?: number, errorType?: string, message = 'boom', headers?: unknown) =>
    classifyProviderError({ provider: 'claude', status, errorType, message, headers });

  it.each([
    [429, undefined, RateLimitError, true],
    [529, undefined, OverloadedError, true],
    [503, undefined, OverloadedError, true],
    [401, undefined, AuthenticationError, false],
    [403, undefined, AuthenticationError, false],
    [400, undefined, InvalidRequestError, false],
    [404, undefined, InvalidRequestError, false],
    [422, undefined, InvalidRequestError, false],
    [500, undefined, ProviderError, true],
    [502, undefined, ProviderError, true],
    [408, undefined, ProviderError, true],
    [409, undefined, ProviderError, true],
  ] as const)('HTTP %s → %s', (status, type, cls, retryable) => {
    const err = classify(status, type);
    expect(err).toBeInstanceOf(cls);
    expect(err.constructor).toBe(cls);
    expect(err.retryable).toBe(retryable);
    expect(err.status).toBe(status);
  });

  it('uses the provider error type when there is no status (mid-stream errors)', () => {
    expect(classify(undefined, 'overloaded_error')).toBeInstanceOf(OverloadedError);
    expect(classify(undefined, 'rate_limit_error')).toBeInstanceOf(RateLimitError);
    expect(classify(undefined, 'invalid_request_error')).toBeInstanceOf(InvalidRequestError);
    expect(classify(undefined, 'authentication_error')).toBeInstanceOf(AuthenticationError);
    expect(classify(undefined, 'api_error').constructor).toBe(ProviderError);
  });

  it('no status and no type (connection reset, timeout) → retryable ProviderError', () => {
    const err = classify(undefined, undefined, 'ECONNRESET');
    expect(err.constructor).toBe(ProviderError);
    expect(err.retryable).toBe(true);
  });

  it('detects context-length errors from Claude, OpenAI and vLLM-style messages', () => {
    expect(classify(400, 'invalid_request_error', 'prompt is too long: 210000 tokens > 200000 maximum'))
      .toBeInstanceOf(ContextLengthError);
    expect(classify(400, 'context_length_exceeded', "This model's maximum context length is 128000 tokens"))
      .toBeInstanceOf(ContextLengthError);
    expect(classify(400, undefined, 'maximum context length is 32768 tokens'))
      .toBeInstanceOf(ContextLengthError);
    expect(classify(400, undefined, 'messages: field required')).not.toBeInstanceOf(ContextLengthError);
  });

  it('fills retryAfterMs on rate-limit and overload errors', () => {
    expect((classify(429, undefined, 'x', { 'retry-after': '7' }) as RateLimitError).retryAfterMs).toBe(7000);
    expect((classify(529, undefined, 'x', { 'retry-after': '2' }) as OverloadedError).retryAfterMs).toBe(2000);
    expect((classify(429) as RateLimitError).retryAfterMs).toBeUndefined();
  });
});
