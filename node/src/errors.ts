/** The API's error envelope, carried as a real Error. */
export interface ErrorEnvelope {
  readonly code?: string;
  readonly message?: string;
  readonly retryable?: boolean;
  readonly request_id?: string;
  readonly docs_url?: string;
  readonly details?: Record<string, unknown>;
}

/**
 * Every non-2xx answer becomes one of these — the same code, message and
 * request id the API sent, nothing invented. Quote `requestId` to support;
 * follow `docsUrl` for the code's own page.
 */
export class FylaneApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly retryable: boolean;
  readonly requestId: string | undefined;
  readonly docsUrl: string | undefined;
  readonly details: Record<string, unknown> | undefined;

  constructor(status: number, envelope: ErrorEnvelope) {
    super(envelope.message ?? `The request failed (${String(status)}).`);
    this.name = 'FylaneApiError';
    this.code = envelope.code ?? 'unknown_error';
    this.status = status;
    this.retryable = envelope.retryable ?? false;
    this.requestId = envelope.request_id;
    this.docsUrl = envelope.docs_url;
    this.details = envelope.details;
  }
}

/** Misuse of the SDK itself — never something the API said. */
export class FylaneError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FylaneError';
  }
}
