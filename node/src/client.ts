import { FylaneApiError, FylaneError, type ErrorEnvelope } from './errors.js';
import type {
  FylaneFile,
  Job,
  List,
  ProcessOptions,
  UploadInput,
  UploadOptions,
  Usage,
  WebhookEndpoint,
} from './types.js';

/**
 * The Fylane client.
 *
 *   const fylane = new Fylane(process.env.FYLANE_API_KEY);
 *   const job = await fylane.files.process('./report.docx', { operation: 'convert' });
 *   console.log(job.state, job.artifacts);
 *
 * Three rules carry the design:
 *
 *  - The upload dance (create a session, PUT the bytes, complete) is the
 *    SDK's job, never the caller's.
 *  - Errors are the API's own envelope as a thrown `FylaneApiError` — same
 *    code, same request id, nothing invented. A *processing* failure is not
 *    an exception: a finished job in state `failed` is a result, returned.
 *  - A live key refuses to run where a browser could see it. A key in
 *    browser JavaScript is a key in the page source; the SDK will not help
 *    that happen.
 */

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface FylaneOptions {
  readonly baseUrl?: string;
  readonly fetchImpl?: FetchLike;
  /** Retries for retryable failures (429/5xx, and no answer at all). Default 2. */
  readonly maxRetries?: number;
  /**
   * How long one API request may go unanswered before it is abandoned and,
   * while retries remain, tried again. Default 30 s. Without it a poll on a
   * connection that has silently died waits for the operating system to give
   * up, which a client sweep measured at over an hour.
   */
  readonly requestTimeoutMs?: number;
}

const DEFAULT_BASE_URL = 'https://api.fylane.dev';
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
/** Uploads carry real bytes; they get room, not the API's answer budget. */
const UPLOAD_TIMEOUT_MS = 15 * 60_000;
const POLL_INITIAL_MS = 500;
const POLL_CAP_MS = 3_000;
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

export class Fylane {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly maxRetries: number;
  private readonly requestTimeoutMs: number;

  readonly files: Files;
  readonly jobs: Jobs;
  readonly webhooks: Webhooks;

  constructor(apiKey: string | undefined, options: FylaneOptions = {}) {
    if (apiKey === undefined || apiKey === '') {
      throw new FylaneError(
        'An API key is required: new Fylane(process.env.FYLANE_API_KEY). Create one in the console.',
      );
    }
    if (
      apiKey.startsWith('fy_live_') &&
      typeof (globalThis as { document?: unknown }).document !== 'undefined'
    ) {
      throw new FylaneError(
        'A live API key must never run in a browser — it would be visible in the page source. ' +
          'Call Fylane from your backend, or use a test key for local experiments.',
      );
    }

    this.apiKey = apiKey;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init));
    this.maxRetries = options.maxRetries ?? 2;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;

    this.files = new Files(this);
    this.jobs = new Jobs(this);
    this.webhooks = new Webhooks(this);
  }

  async usage(): Promise<Usage> {
    return this.request<Usage>('GET', '/v1/usage');
  }

  /** @internal */
  async request<T>(
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<T> {
    let attempt = 0;
    for (;;) {
      let response: Response;
      try {
        response = await this.fetchImpl(`${this.baseUrl}${path}`, {
          method,
          headers: {
            authorization: `Bearer ${this.apiKey}`,
            ...(body === undefined ? {} : { 'content-type': 'application/json' }),
            ...headers,
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: AbortSignal.timeout(this.requestTimeoutMs),
        });
      } catch (cause) {
        // No answer at all — the timeout, a dropped connection, a resolver
        // that failed. Retryable the way a 503 is: nothing was decided.
        if (attempt >= this.maxRetries) {
          throw new FylaneError(
            `No answer from ${method} ${path} after ${String(attempt + 1)} attempt(s): ` +
              `${cause instanceof Error ? cause.message : String(cause)}. ` +
              'Check the network, then try again — nothing was changed.',
          );
        }
        attempt += 1;
        await sleep(400 * 2 ** attempt + Math.floor(Math.random() * 250));
        continue;
      }

      if (response.ok) {
        // 204 is a contract answer, not an empty JSON document.
        if (response.status === 204) return undefined as T;
        return (await response.json()) as T;
      }

      const envelope = (await response.json().catch(() => ({}))) as ErrorEnvelope;
      const error = new FylaneApiError(response.status, envelope);
      if (!error.retryable || attempt >= this.maxRetries) throw error;

      attempt += 1;
      const retryAfter = Number(response.headers.get('retry-after') ?? Number.NaN);
      const base = Number.isFinite(retryAfter) ? retryAfter * 1000 : 400 * 2 ** attempt;
      await sleep(base + Math.floor(Math.random() * 250));
    }
  }

  /** @internal — the raw PUT of bytes to a presigned capability. */
  async putBytes(
    url: string,
    uploadHeaders: Record<string, string>,
    bytes: Uint8Array,
  ): Promise<void> {
    const response = await this.fetchImpl(url, {
      method: 'PUT',
      headers: uploadHeaders,
      body: bytes,
      signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
    } as RequestInit);
    if (!response.ok) {
      throw new FylaneError(
        `The upload itself failed (${String(response.status)}). The URL may have expired — create the upload again.`,
      );
    }
  }
}

interface UploadSession {
  readonly file_id: string;
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
}

class Files {
  constructor(private readonly client: Fylane) {}

  /**
   * The whole loop in one call: upload the input, run the operation, and —
   * unless `poll: false` — wait for the terminal state. A failed job comes
   * back as a job in state `failed`, not as an exception: processing
   * failures are results with reasons, and the reason is on `job.error`.
   */
  async process(input: UploadInput, options: ProcessOptions): Promise<Job> {
    const file = await this.upload(input, options);
    const job = await this.client.jobs.create({
      fileId: file.id,
      ...(options.operation === undefined ? {} : { operation: options.operation }),
      ...(options.preset === undefined ? {} : { preset: options.preset }),
      ...(options.operations === undefined ? {} : { operations: options.operations }),
      ...(options.params === undefined ? {} : { params: options.params }),
      ...(options.idempotencyKey === undefined ? {} : { idempotencyKey: options.idempotencyKey }),
    });
    if (options.poll === false) return job;
    return this.client.jobs.waitFor(job.id, {
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    });
  }

  /** Upload alone: session → bytes → completion, returning the ready file. */
  async upload(input: UploadInput, options: UploadOptions = {}): Promise<FylaneFile> {
    const { bytes, filename, mimeType } = await materialise(input, options);

    const session = await this.client.request<UploadSession>('POST', '/v1/uploads', {
      filename,
      byte_size: bytes.byteLength,
      ...(mimeType === undefined ? {} : { mime_type: mimeType }),
      ...(options.validation === undefined
        ? {}
        : {
            validation: {
              ...(options.validation.formats === undefined
                ? {}
                : { formats: options.validation.formats }),
              ...(options.validation.maxBytes === undefined
                ? {}
                : { max_bytes: options.validation.maxBytes }),
              ...(options.validation.minBytes === undefined
                ? {}
                : { min_bytes: options.validation.minBytes }),
            },
          }),
    });
    await this.client.putBytes(session.url, session.headers, bytes);
    return this.client.request<FylaneFile>('POST', `/v1/files/${session.file_id}/complete`);
  }

  async get(fileId: string): Promise<FylaneFile> {
    return this.client.request<FylaneFile>('GET', `/v1/files/${encodeURIComponent(fileId)}`);
  }

  async list(options: { limit?: number } = {}): Promise<List<FylaneFile>> {
    const query = options.limit === undefined ? '' : `?limit=${String(options.limit)}`;
    return this.client.request<List<FylaneFile>>('GET', `/v1/files${query}`);
  }

  /** A short-lived URL for the original file, or one of its artifacts. */
  async downloadUrl(
    fileId: string,
    options: { artifactId?: string } = {},
  ): Promise<{ url: string; expires_at: string }> {
    return this.client.request('POST', `/v1/files/${encodeURIComponent(fileId)}/download-url`, {
      ...(options.artifactId === undefined ? {} : { artifact_id: options.artifactId }),
    });
  }

  /**
   * Delete a file. The stored bytes — original and every derived artifact —
   * are removed; the metadata record survives so job and billing history stay
   * whole. Deleting a file that is already gone answers not_found.
   */
  async delete(fileId: string): Promise<void> {
    await this.client.request<undefined>('DELETE', `/v1/files/${encodeURIComponent(fileId)}`);
  }
}

class Jobs {
  constructor(private readonly client: Fylane) {}

  async create(options: {
    fileId: string;
    operation?: string;
    preset?: string;
    /** A pipeline — see `ProcessOptions.operations`. */
    operations?: readonly string[];
    params?: Record<string, unknown>;
    idempotencyKey?: string;
  }): Promise<Job> {
    return this.client.request<Job>(
      'POST',
      '/v1/jobs',
      {
        file_id: options.fileId,
        ...(options.operation === undefined ? {} : { operation: options.operation }),
        ...(options.preset === undefined ? {} : { preset: options.preset }),
        ...(options.operations === undefined ? {} : { operations: options.operations }),
        // `options` on the wire, per the contract; `params` here for ergonomics.
        ...(options.params === undefined ? {} : { options: options.params }),
      },
      options.idempotencyKey === undefined ? {} : { 'idempotency-key': options.idempotencyKey },
    );
  }

  /** Cancel queued work. Running work finishes; the API answers 409. */
  async cancel(jobId: string): Promise<Job> {
    return this.client.request<Job>('POST', `/v1/jobs/${encodeURIComponent(jobId)}/cancel`);
  }

  async get(jobId: string): Promise<Job> {
    return this.client.request<Job>('GET', `/v1/jobs/${encodeURIComponent(jobId)}`);
  }

  async list(): Promise<List<Job>> {
    return this.client.request<List<Job>>('GET', '/v1/jobs');
  }

  /** Poll with backoff until the job is terminal. Times out with an error. */
  async waitFor(jobId: string, options: { timeoutMs?: number } = {}): Promise<Job> {
    const deadline = Date.now() + (options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    let interval = POLL_INITIAL_MS;
    for (;;) {
      const job = await this.get(jobId);
      if (job.state === 'succeeded' || job.state === 'failed') return job;
      if (Date.now() + interval > deadline) {
        throw new FylaneError(
          `Job ${jobId} is still ${job.state} after the wait timeout. It keeps running server-side — fetch it again later, or listen on a webhook instead of polling.`,
        );
      }
      await sleep(interval);
      interval = Math.min(interval * 2, POLL_CAP_MS);
    }
  }
}

class Webhooks {
  constructor(private readonly client: Fylane) {}

  /** The response carries `signing_secret` exactly once. Store it now. */
  async create(options: { url: string; events: readonly string[] }): Promise<WebhookEndpoint> {
    return this.client.request<WebhookEndpoint>('POST', '/v1/webhook-endpoints', {
      url: options.url,
      events: options.events,
    });
  }

  async list(): Promise<List<WebhookEndpoint>> {
    return this.client.request<List<WebhookEndpoint>>('GET', '/v1/webhook-endpoints');
  }

  async delete(endpointId: string): Promise<void> {
    await this.client.request('DELETE', `/v1/webhook-endpoints/${encodeURIComponent(endpointId)}`);
  }

  async test(endpointId: string): Promise<{ delivery_id: string }> {
    return this.client.request(
      'POST',
      `/v1/webhook-endpoints/${encodeURIComponent(endpointId)}/test`,
    );
  }
}

/** Bytes plus a filename, from whatever shape the caller had. */
async function materialise(
  input: UploadInput,
  options: UploadOptions,
): Promise<{ bytes: Uint8Array; filename: string; mimeType: string | undefined }> {
  if (typeof input === 'string') {
    if (typeof (globalThis as { document?: unknown }).document !== 'undefined') {
      throw new FylaneError(
        'A filesystem path only works in Node. In a browser, pass the File or Blob itself.',
      );
    }
    const { readFile } = await import('node:fs/promises');
    const path = await import('node:path');
    const bytes = new Uint8Array(await readFile(input));
    return {
      bytes,
      filename: options.filename ?? path.basename(input),
      mimeType: options.mimeType,
    };
  }
  if (input instanceof Uint8Array) {
    return { bytes: input, filename: options.filename ?? 'upload.bin', mimeType: options.mimeType };
  }
  if (input instanceof ArrayBuffer) {
    return {
      bytes: new Uint8Array(input),
      filename: options.filename ?? 'upload.bin',
      mimeType: options.mimeType,
    };
  }
  // Blob (and File, which extends it — its own name wins over the default).
  const name = (input as { name?: string }).name;
  return {
    bytes: new Uint8Array(await input.arrayBuffer()),
    filename: options.filename ?? name ?? 'upload.bin',
    mimeType: options.mimeType ?? (input.type === '' ? undefined : input.type),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
