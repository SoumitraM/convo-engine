/**
 * Stand-ins for the Anthropic / OpenAI SDK error classes. The adapters match
 * SDK errors by class name along the prototype chain (see mapSdkError in
 * src/adapters/provider/shared.ts), so these mirror the real names and fields.
 */

export class APIError extends Error {
  constructor(
    readonly status: number | undefined,
    readonly error: unknown,
    message: string,
    readonly headers: Record<string, string> | undefined = undefined,
  ) {
    super(message);
  }
}

export class RateLimitError extends APIError {}
export class InternalServerError extends APIError {}
export class BadRequestError extends APIError {}

export class APIConnectionError extends APIError {
  constructor(message = 'Connection error.') {
    super(undefined, undefined, message);
  }
}

export class APIConnectionTimeoutError extends APIConnectionError {
  constructor() {
    super('Request timed out.');
  }
}

export class APIUserAbortError extends APIError {
  constructor() {
    super(undefined, undefined, 'Request was aborted.');
  }
}

/** OpenAI's APIError also carries `code` / `type` copied from the error body. */
export class OpenAIAPIError extends APIError {
  readonly code?: string;
  readonly type?: string;

  constructor(
    status: number | undefined,
    error: { message?: string; type?: string; code?: string },
    headers?: Record<string, string>,
  ) {
    super(status, error, `${status ?? ''} ${error.message ?? ''}`.trim(), headers);
    this.code = error.code;
    this.type = error.type;
  }
}
