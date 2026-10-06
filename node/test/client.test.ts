import { afterEach, describe, expect, it, vi } from 'vitest';
import { Fylane, FylaneApiError, FylaneError } from '../src/index.js';

/**
 * The SDK against a scripted API: each handler answers one route, and the
 * suite asserts the properties the README promises — the upload dance in
 * order, the API's envelope surfacing untouched, retries only where the
 * API says retrying helps, and a live key refusing to run in a browser.
 */

type Handler = (init: RequestInit | undefined, url: string) => { status?: number; body: unknown };

function scripted(handlers: Record<string, Handler>): {
  fetchImpl: (url: string, init?: RequestInit) => Promise<Response>;
  calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    fetchImpl: (url, init) => {
      const method = init?.method ?? 'GET';
      const path = url.startsWith('http') ? new URL(url).pathname : url;
      calls.push(`${method} ${path}`);
      const handler = handlers[`${method} ${path}`] ?? handlers[path];
      if (handler === undefined) throw new Error(`Unexpected request: ${method} ${url}`);
      const outcome = handler(init, url);
      return Promise.resolve(
        new Response(JSON.stringify(outcome.body), { status: outcome.status ?? 200 }),
      );
    },
  };
}

const FILE = {
  id: 'file-1',
  object: 'file',
  state: 'ready',
  state_reason: null,
  filename: 'note.txt',
  declared_mime: null,
  detected_mime: 'text/plain',
  byte_size: 5,
  findings: [],
  created_at: '2026-08-26T00:00:00.000Z',
};

function jobIn(state: string): Record<string, unknown> {
  return {
    id: 'job-1',
    object: 'job',
    file_id: 'file-1',
    operation: 'inspect',
    preset: null,
    state,
    class: 'fast',
    credits_estimated: 1,
    credits_charged: state === 'succeeded' ? 1 : null,
    error: null,
    artifacts: [],
    queued_at: '2026-08-26T00:00:00.000Z',
    finished_at: null,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('constructing the client', () => {
  it('requires a key, with instructions rather than a null crash', () => {
    expect(() => new Fylane(undefined)).toThrow(/API key is required/);
  });

  it('refuses a live key anywhere a browser could see it', () => {
    (globalThis as { document?: unknown }).document = {};
    try {
      expect(() => new Fylane('fy_live_abc')).toThrow(FylaneError);
      expect(() => new Fylane('fy_live_abc')).toThrow(/never run in a browser/);
      // A test key may: local experiments in a browser console are fine.
      expect(() => new Fylane('fy_test_abc')).not.toThrow();
    } finally {
      delete (globalThis as { document?: unknown }).document;
    }
  });
});

describe('files.process', () => {
  it('runs the whole dance in order and returns the terminal job', async () => {
    let polls = 0;
    const api = scripted({
      'POST /v1/uploads': (init) => {
        const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Record<
          string,
          unknown
        >;
        expect(body['filename']).toBe('note.txt');
        expect(body['byte_size']).toBe(5);
        return {
          status: 201,
          body: {
            file_id: 'file-1',
            url: 'https://bucket.test/put-here',
            method: 'PUT',
            headers: { 'x-signed': 'yes' },
          },
        };
      },
      'PUT /put-here': (init) => {
        expect((init?.headers as Record<string, string>)['x-signed']).toBe('yes');
        return { body: {} };
      },
      'POST /v1/files/file-1/complete': () => ({ body: FILE }),
      'POST /v1/jobs': (init) => {
        const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Record<
          string,
          unknown
        >;
        expect(body['file_id']).toBe('file-1');
        expect(body['operation']).toBe('inspect');
        return { status: 201, body: jobIn('queued') };
      },
      'GET /v1/jobs/job-1': () => {
        polls += 1;
        return { body: jobIn(polls < 3 ? 'running' : 'succeeded') };
      },
    });

    const fylane = new Fylane('fy_test_x', {
      baseUrl: 'https://api.test',
      fetchImpl: api.fetchImpl,
    });
    const bytes = new TextEncoder().encode('hello');
    const job = await fylane.files.process(bytes, { operation: 'inspect', filename: 'note.txt' });

    expect(job.state).toBe('succeeded');
    expect(api.calls.slice(0, 4)).toEqual([
      'POST /v1/uploads',
      'PUT /put-here',
      'POST /v1/files/file-1/complete',
      'POST /v1/jobs',
    ]);
    expect(polls).toBe(3);
  }, 20_000);

  it('returns a failed job as a result, never as an exception', async () => {
    const api = scripted({
      'POST /v1/uploads': () => ({
        status: 201,
        body: { file_id: 'file-1', url: 'https://bucket.test/p', method: 'PUT', headers: {} },
      }),
      'PUT /p': () => ({ body: {} }),
      'POST /v1/files/file-1/complete': () => ({ body: FILE }),
      'POST /v1/jobs': () => ({ status: 201, body: jobIn('queued') }),
      'GET /v1/jobs/job-1': () => ({
        body: { ...jobIn('failed'), error: { code: 'corrupted_file' } },
      }),
    });

    const fylane = new Fylane('fy_test_x', {
      baseUrl: 'https://api.test',
      fetchImpl: api.fetchImpl,
    });
    const job = await fylane.files.process(new Uint8Array([1]), { operation: 'inspect' });
    expect(job.state).toBe('failed');
    expect(job.error?.code).toBe('corrupted_file');
  });

  it('skips the wait when poll is false', async () => {
    const api = scripted({
      'POST /v1/uploads': () => ({
        status: 201,
        body: { file_id: 'file-1', url: 'https://bucket.test/p', method: 'PUT', headers: {} },
      }),
      'PUT /p': () => ({ body: {} }),
      'POST /v1/files/file-1/complete': () => ({ body: FILE }),
      'POST /v1/jobs': () => ({ status: 201, body: jobIn('queued') }),
    });
    const fylane = new Fylane('fy_test_x', {
      baseUrl: 'https://api.test',
      fetchImpl: api.fetchImpl,
    });
    const job = await fylane.files.process(new Uint8Array([1]), {
      operation: 'inspect',
      poll: false,
    });
    expect(job.state).toBe('queued');
    expect(api.calls).not.toContain('GET /v1/jobs/job-1');
  });

  it('sends the idempotency key as the header the API reads', async () => {
    const api = scripted({
      'POST /v1/uploads': () => ({
        status: 201,
        body: { file_id: 'file-1', url: 'https://bucket.test/p', method: 'PUT', headers: {} },
      }),
      'PUT /p': () => ({ body: {} }),
      'POST /v1/files/file-1/complete': () => ({ body: FILE }),
      'POST /v1/jobs': (init) => {
        expect((init?.headers as Record<string, string>)['idempotency-key']).toBe('retry-me-1');
        return { status: 201, body: jobIn('queued') };
      },
    });
    const fylane = new Fylane('fy_test_x', {
      baseUrl: 'https://api.test',
      fetchImpl: api.fetchImpl,
    });
    await fylane.files.process(new Uint8Array([1]), {
      operation: 'inspect',
      idempotencyKey: 'retry-me-1',
      poll: false,
    });
  });
});

describe('errors', () => {
  it("surfaces the API's envelope untouched", async () => {
    const api = scripted({
      'GET /v1/usage': () => ({
        status: 429,
        body: {
          code: 'credits_exhausted',
          message: 'This organization has no processing credits remaining.',
          retryable: false,
          request_id: 'req_ABC',
          docs_url: 'https://fylane.dev/docs/errors/credits-exhausted',
        },
      }),
    });
    const fylane = new Fylane('fy_test_x', {
      baseUrl: 'https://api.test',
      fetchImpl: api.fetchImpl,
    });

    const thrown = await fylane.usage().catch((error: unknown) => error);
    expect(thrown).toBeInstanceOf(FylaneApiError);
    const apiError = thrown as FylaneApiError;
    expect(apiError.code).toBe('credits_exhausted');
    expect(apiError.status).toBe(429);
    expect(apiError.requestId).toBe('req_ABC');
    expect(apiError.docsUrl).toContain('credits-exhausted');
    expect(apiError.retryable).toBe(false);
  });

  it('retries only what the API marks retryable, then gives up honestly', async () => {
    let attempts = 0;
    const api = scripted({
      'GET /v1/usage': () => {
        attempts += 1;
        return attempts < 3
          ? { status: 503, body: { code: 'dependency_unavailable', retryable: true } }
          : {
              body: {
                object: 'usage',
                credits: { granted: 500, reserved: 0, consumed: 0, available: 500 },
                monthly_free_credits: 500,
              },
            };
      },
    });
    const fylane = new Fylane('fy_test_x', {
      baseUrl: 'https://api.test',
      fetchImpl: api.fetchImpl,
    });
    const usage = await fylane.usage();
    expect(usage.credits.available).toBe(500);
    expect(attempts).toBe(3);

    // Not retryable → exactly one attempt.
    let once = 0;
    const strict = scripted({
      'GET /v1/usage': () => {
        once += 1;
        return { status: 401, body: { code: 'invalid_api_key', retryable: false } };
      },
    });
    const failing = new Fylane('fy_test_x', {
      baseUrl: 'https://api.test',
      fetchImpl: strict.fetchImpl,
    });
    await expect(failing.usage()).rejects.toThrow(FylaneApiError);
    expect(once).toBe(1);
  }, 20_000);
});

describe('inputs', () => {
  it('reads a filesystem path and names the file after it', async () => {
    const { writeFile, mkdtemp } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = await mkdtemp(join(tmpdir(), 'sdk-'));
    await writeFile(join(dir, 'report.txt'), 'from disk');

    const api = scripted({
      'POST /v1/uploads': (init) => {
        const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Record<
          string,
          unknown
        >;
        expect(body['filename']).toBe('report.txt');
        expect(body['byte_size']).toBe(9);
        return {
          status: 201,
          body: { file_id: 'file-1', url: 'https://bucket.test/p', method: 'PUT', headers: {} },
        };
      },
      'PUT /p': () => ({ body: {} }),
      'POST /v1/files/file-1/complete': () => ({ body: FILE }),
    });
    const fylane = new Fylane('fy_test_x', {
      baseUrl: 'https://api.test',
      fetchImpl: api.fetchImpl,
    });
    const file = await fylane.files.upload(join(dir, 'report.txt'));
    expect(file.state).toBe('ready');
  });

  it('takes a Blob and keeps its own name and type', async () => {
    const api = scripted({
      'POST /v1/uploads': (init) => {
        const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Record<
          string,
          unknown
        >;
        expect(body['filename']).toBe('photo.png');
        expect(body['mime_type']).toBe('image/png');
        return {
          status: 201,
          body: { file_id: 'file-1', url: 'https://bucket.test/p', method: 'PUT', headers: {} },
        };
      },
      'PUT /p': () => ({ body: {} }),
      'POST /v1/files/file-1/complete': () => ({ body: FILE }),
    });
    const fylane = new Fylane('fy_test_x', {
      baseUrl: 'https://api.test',
      fetchImpl: api.fetchImpl,
    });
    const blob = new File([new Uint8Array([1, 2, 3])], 'photo.png', { type: 'image/png' });
    await fylane.files.upload(blob);
  });
});

describe('a request that never answers', () => {
  it('is abandoned at the request timeout, retried, then surfaced as an error', async () => {
    // A poll on a connection that silently died. Without the timeout the
    // SDK waited on the operating system, measured at over an hour in a
    // client sweep; with it, the call is bounded and the failure says so.
    let calls = 0;
    const hanging = (_url: string, init?: RequestInit): Promise<Response> => {
      calls += 1;
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason as Error));
      });
    };
    const fylane = new Fylane('fy_test_k', {
      fetchImpl: hanging,
      requestTimeoutMs: 20,
      maxRetries: 1,
    });
    await expect(fylane.usage()).rejects.toThrow(/No answer from GET \/v1\/usage after 2 attempt/);
    expect(calls).toBe(2);
  });
});

describe('pipelines', () => {
  it('sends `operations` for a multi-step job, and no `operation`', async () => {
    const { fetchImpl } = scripted({
      'POST /v1/jobs': (init) => {
        const body = JSON.parse(init?.body as string) as Record<string, unknown>;
        expect(body['operations']).toEqual(['image.resize', 'image.convert']);
        expect(body['operation']).toBeUndefined();
        expect(body['options']).toEqual({ width: 640, format: 'webp' });
        return { status: 202, body: jobIn('queued') };
      },
    });
    const fylane = new Fylane('fy_test_k', { fetchImpl });
    const job = await fylane.jobs.create({
      fileId: 'file-1',
      operations: ['image.resize', 'image.convert'],
      params: { width: 640, format: 'webp' },
    });
    expect(job.state).toBe('queued');
  });
});
