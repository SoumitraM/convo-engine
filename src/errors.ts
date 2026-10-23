/**
 * Normalised provider errors.
 * Zero runtime dependencies.
 *
 * Every provider adapter maps its SDK / HTTP failures onto these classes, so
 * callers can decide whether to retry without inspecting provider-specific
 * error shapes or messages.
 *
 * `instanceof` checks use a brand rather than prototype identity, because
 * each subpath export (index, adapters/claude, ...) is bundled separately and
 * may carry its own copy of these classes.
 */

export type ProviderName = 'claude' | 'openai' | 'gateway';

const KINDS = Symbol.for('@smsoumitra/convo-engine/ProviderError.kinds');

export interface ProviderErrorOptions {
  provider: ProviderName;
  status?: number;
  cause?: unknown;
  retryable?: boolean;
}

export class ProviderError extends Error {
  static readonly kind: string = 'ProviderError';

  static [Symbol.hasInstance](value: unknown): boolean {
    if (typeof value !== 'object' || value === null) return false;
    const kinds = (value as Record<symbol, unknown>)[KINDS];
    return Array.isArray(kinds) && kinds.includes(this.kind);
  }

  readonly provider: ProviderName;
  readonly status?: number;
  readonly retryable: boolean;

  constructor(message: string, options: ProviderErrorOptions) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.provider = options.provider;
    this.status = options.status;
    this.retryable = options.retryable ?? false;

    // Record the class chain (e.g. ['RateLimitError', 'ProviderError']) for hasInstance.
    const kinds: string[] = [];
    for (
      let ctor = new.target as unknown as { kind?: string } | null;
      ctor && typeof ctor.kind === 'string';
      ctor = Object.getPrototypeOf(ctor) as { kind?: string } | null
    ) {
      if (!kinds.includes(ctor.kind)) kinds.push(ctor.kind);
    }
    Object.defineProperty(this, KINDS, { value: kinds, enumerable: false });
    this.name = kinds[0] ?? 'ProviderError';
  }
}

/** HTTP 429. `retryAfterMs` is filled from `retry-after` / `retry-after-ms` when present. */
export class RateLimitError extends ProviderError {
  static override readonly kind: string = 'RateLimitError';
  readonly retryAfterMs?: number;

  constructor(message: string, options: ProviderErrorOptions & { retryAfterMs?: number }) {
    super(message, { retryable: true, ...options });
    this.retryAfterMs = options.retryAfterMs;
  }
}

/** HTTP 529 / 503, or an `overloaded_error` mid-stream. */
export class OverloadedError extends ProviderError {
  static override readonly kind: string = 'OverloadedError';
  readonly retryAfterMs?: number;

  constructor(message: string, options: ProviderErrorOptions & { retryAfterMs?: number }) {
    super(message, { retryable: true, ...options });
    this.retryAfterMs = options.retryAfterMs;
  }
}

/** The prompt (plus max output tokens) exceeds the model's context window. */
export class ContextLengthError extends ProviderError {
  static override readonly kind: string = 'ContextLengthError';
}

/** HTTP 401 / 403. */
export class AuthenticationError extends ProviderError {
  static override readonly kind: string = 'AuthenticationError';
}

/**
 * Any other 4xx, and requests the adapter rejects before sending (unsupported
 * content, oversized documents, invalid toolChoice).
 */
export class InvalidRequestError extends ProviderError {
  static override readonly kind: string = 'InvalidRequestError';
}

// ---------------------------------------------------------------------------
// Helpers shared by the adapters
// ---------------------------------------------------------------------------

/** Header lookup that works with a fetch `Headers` object or a plain record. */
export function readHeader(headers: unknown, name: string): string | undefined {
  if (!headers || typeof headers !== 'object') return undefined;
  const get = (headers as { get?: unknown }).get;
  if (typeof get === 'function') {
    const value = (get as (n: string) => string | null).call(headers, name);
    return value ?? undefined;
  }
  const record = headers as Record<string, unknown>;
  const key = Object.keys(record).find(k => k.toLowerCase() === name);
  const value = key ? record[key] : undefined;
  return typeof value === 'string' ? value : undefined;
}

/** Parses `retry-after-ms`, then `retry-after` (seconds or an HTTP date). */
export function parseRetryAfterMs(headers: unknown, now = Date.now()): number | undefined {
  const ms = readHeader(headers, 'retry-after-ms');
  if (ms !== undefined && ms.trim() !== '' && Number.isFinite(Number(ms))) {
    return Math.max(0, Number(ms));
  }

  const value = readHeader(headers, 'retry-after');
  if (value === undefined || value.trim() === '') return undefined;

  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);

  const date = Date.parse(value);
  if (!Number.isNaN(date)) return Math.max(0, date - now);

  return undefined;
}

const CONTEXT_LENGTH_PATTERN =
  /prompt is too long|context[ _-]?length|context window|maximum context|too many (input )?tokens/i;

/**
 * Builds the right ProviderError subclass from what an adapter knows about a
 * failure. `errorType` is the provider's own error code, if any (Anthropic's
 * `error.type`, OpenAI's `code`) — it decides the class when there is no HTTP
 * status, e.g. for errors that arrive mid-stream.
 */
export function classifyProviderError(input: {
  provider: ProviderName;
  message: string;
  status?: number;
  errorType?: string;
  headers?: unknown;
  cause?: unknown;
}): ProviderError {
  const { provider, status, errorType, headers, cause } = input;
  const message = input.message;
  const base = { provider, status, cause };

  if (status === 429 || errorType === 'rate_limit_error' || errorType === 'rate_limit_exceeded') {
    return new RateLimitError(message, { ...base, retryAfterMs: parseRetryAfterMs(headers) });
  }
  if (status === 529 || status === 503 || errorType === 'overloaded_error') {
    return new OverloadedError(message, { ...base, retryAfterMs: parseRetryAfterMs(headers) });
  }
  if (status === 401 || status === 403 ||
      errorType === 'authentication_error' || errorType === 'permission_error' ||
      errorType === 'invalid_api_key') {
    return new AuthenticationError(message, base);
  }
  if (errorType === 'context_length_exceeded' ||
      ((status === 400 || status === 413 || errorType === 'invalid_request_error' || errorType === 'request_too_large') &&
        CONTEXT_LENGTH_PATTERN.test(message))) {
    return new ContextLengthError(message, base);
  }
  // 408 Request Timeout and 409 Conflict are transient — the SDKs retry them too.
  if (status === 408 || status === 409) {
    return new ProviderError(message, { ...base, retryable: true });
  }
  if ((status !== undefined && status >= 400 && status < 500) ||
      errorType === 'invalid_request_error' || errorType === 'not_found_error' ||
      errorType === 'request_too_large') {
    return new InvalidRequestError(message, base);
  }
  // 5xx, `api_error`, and failures with no status at all (connection reset,
  // timeout) are worth retrying.
  return new ProviderError(message, { ...base, retryable: true });
}
