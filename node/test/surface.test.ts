import { describe, expect, it } from 'vitest';
import { Fylane, FylaneApiError, FylaneError } from '../src/index.js';

/**
 * The rest of the SDK's public surface, each method against a scripted
 * API: resource getters and lists, the download-url capability, delete's
 * 204 contract, the polling loop's timeout honesty, and every shape
 * `materialise` accepts. The README's claims, executed.
 */

type Handler = (init: RequestInit | undefined, url: string) => { status?: number; body?: unknown };

function scripted(handlers: Record<string, Handler>): {
  fetchImpl: (url: string, init?: RequestInit) => Promise<Response>;
  calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    fetchImpl: (url, init) => {
      const method = init?.method ?? 'GET';
      const path = url.startsWith('http') ? new URL(url).pathname + new URL(url).search : url;
      calls.push(`${method} ${path}`);
      const handler = handlers[`${method} ${path}`] ?? handlers[path];
      if (handler === undefined) throw new Error(`Unexpected request: ${method} ${url}`);
      const outcome = handler(init, url);
      if (outcome.status === 204) return Promise.resolve(new Response(null, { status: 204 }));
      return Promise.resolve(
        new Response(JSON.stringify(outcome.body), { status: outcome.status ?? 200 }),
      );
    },
  };
}

function jobIn(state: string): Record<string, unknown> {
  return { id: 'job-1', object: 'job', file_id: 'file-1', operation: 'inspect', state };
}

const KEY = 'fy_test_surface';

describe('resource getters and lists', () => {
  it('usage, file get/list, job get/list — each hits its route verbatim', async () => {
    const { fetchImpl, calls } = scripted({
      'GET /v1/usage': () => ({ body: { object: 'usage', credits: { available: 10 } } }),
      'GET /v1/files/file-1': () => ({ body: { id: 'file-1' } }),
      'GET /v1/files?limit=2': () => ({ body: { object: 'list', data: [] } }),
      'GET /v1/files': () => ({ body: { object: 'list', data: [{ id: 'file-1' }] } }),
      'GET /v1/jobs/job-1': () => ({ body: jobIn('succeeded') }),
      'GET /v1/jobs': () => ({ body: { object: 'list', data: [jobIn('queued')] } }),
    });
    const fylane = new Fylane(KEY, { fetchImpl });

    expect((await fylane.usage()).credits.available).toBe(10);
    expect((await fylane.files.get('file-1')).id).toBe('file-1');
    expect((await fylane.files.list({ limit: 2 })).data).toEqual([]);
    expect((await fylane.files.list()).data).toHaveLength(1);
    expect((await fylane.jobs.get('job-1')).state).toBe('succeeded');
    expect((await fylane.jobs.list()).data).toHaveLength(1);
    expect(calls).toContain('GET /v1/files?limit=2');
  });

  it('mints a download URL for the original, and for a named artifact', async () => {
    const bodies: unknown[] = [];
    const { fetchImpl } = scripted({
      'POST /v1/files/file-1/download-url': (init) => {
        bodies.push(JSON.parse(init?.body as string));
        return { body: { url: 'https://signed.example/x', expires_at: 'soon' } };
      },
    });
    const fylane = new Fylane(KEY, { fetchImpl });

    await fylane.files.downloadUrl('file-1');
    await fylane.files.downloadUrl('file-1', { artifactId: 'art-9' });
    expect(bodies[0]).toEqual({});
    expect(bodies[1]).toEqual({ artifact_id: 'art-9' });
  });

  it('delete accepts the API’s 204 as the whole answer', async () => {
    const { fetchImpl, calls } = scripted({
      'DELETE /v1/files/file-1': () => ({ status: 204 }),
    });
    const fylane = new Fylane(KEY, { fetchImpl });
    await expect(fylane.files.delete('file-1')).resolves.toBeUndefined();
    expect(calls).toEqual(['DELETE /v1/files/file-1']);
  });

  it('cancel posts to the cancel route and returns the job as answered', async () => {
    const { fetchImpl } = scripted({
      'POST /v1/jobs/job-1/cancel': () => ({ body: jobIn('canceled') }),
    });
    const fylane = new Fylane(KEY, { fetchImpl });
    expect((await fylane.jobs.cancel('job-1')).state).toBe('canceled');
  });
});

describe('webhook endpoints resource', () => {
  it('creates, lists, tests and deletes through the contract routes', async () => {
    const { fetchImpl, calls } = scripted({
      'POST /v1/webhook-endpoints': (init) => {
        expect(JSON.parse(init?.body as string)).toEqual({
          url: 'https://x.example/hook',
          events: ['job.succeeded'],
        });
        return { status: 201, body: { id: 'we-1', signing_secret: 'whsec_x' } };
      },
      'GET /v1/webhook-endpoints': () => ({ body: { object: 'list', data: [{ id: 'we-1' }] } }),
      'POST /v1/webhook-endpoints/we-1/test': () => ({ body: { delivery_id: 'd-1' } }),
      'DELETE /v1/webhook-endpoints/we-1': () => ({ status: 204 }),
    });
    const fylane = new Fylane(KEY, { fetchImpl });

    const created = await fylane.webhooks.create({
      url: 'https://x.example/hook',
      events: ['job.succeeded'],
    });
    expect(created.signing_secret).toBe('whsec_x');
    expect((await fylane.webhooks.list()).data).toHaveLength(1);
    expect((await fylane.webhooks.test('we-1')).delivery_id).toBe('d-1');
    await fylane.webhooks.delete('we-1');
    expect(calls).toHaveLength(4);
  });
});

describe('waitFor', () => {
  it('polls until terminal and returns the failed job as a RESULT', async () => {
    let polls = 0;
    const { fetchImpl } = scripted({
      'GET /v1/jobs/job-1': () => ({ body: jobIn(++polls < 3 ? 'running' : 'failed') }),
    });
    const fylane = new Fylane(KEY, { fetchImpl });
    const job = await fylane.jobs.waitFor('job-1');
    expect(job.state).toBe('failed');
    expect(polls).toBe(3);
  });

  it('times out honestly, naming the state the job was left in', async () => {
    const { fetchImpl } = scripted({
      'GET /v1/jobs/job-1': () => ({ body: jobIn('queued') }),
    });
    const fylane = new Fylane(KEY, { fetchImpl });
    await expect(fylane.jobs.waitFor('job-1', { timeoutMs: 1 })).rejects.toThrow(/still queued/);
  });
});

describe('the upload input shapes', () => {
  function uploadScript(expectFilename: string, expectMime?: string) {
    return scripted({
      'POST /v1/uploads': (init) => {
        const body = JSON.parse(init?.body as string) as Record<string, unknown>;
        expect(body['filename']).toBe(expectFilename);
        if (expectMime !== undefined) expect(body['mime_type']).toBe(expectMime);
        return {
          body: {
            file_id: 'file-1',
            url: 'https://bucket.example/put',
            method: 'PUT',
            headers: {},
          },
        };
      },
      'PUT /put': () => ({ body: {} }),
      'POST /v1/files/file-1/complete': () => ({ body: { id: 'file-1', state: 'ready' } }),
    });
  }

  it('an ArrayBuffer uploads under the default name', async () => {
    const { fetchImpl } = uploadScript('upload.bin');
    const fylane = new Fylane(KEY, { fetchImpl });
    const file = await fylane.files.upload(new ArrayBuffer(4));
    expect(file.state).toBe('ready');
  });

  it('a File keeps its own name and type', async () => {
    const { fetchImpl } = uploadScript('photo.png', 'image/png');
    const fylane = new Fylane(KEY, { fetchImpl });
    const input = new File([new Uint8Array([1, 2, 3])], 'photo.png', { type: 'image/png' });
    await fylane.files.upload(input);
  });

  it('a filesystem path reads the bytes and takes the basename', async () => {
    const { mkdtemp, writeFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = await mkdtemp(join(tmpdir(), 'fy-sdk-'));
    const path = join(dir, 'from-disk.txt');
    await writeFile(path, 'hello');
    const { fetchImpl } = uploadScript('from-disk.txt');
    const fylane = new Fylane(KEY, { fetchImpl });
    await fylane.files.upload(path);
  });

  it('a failed presigned PUT names the expiry suspect', async () => {
    const { fetchImpl } = scripted({
      'POST /v1/uploads': () => ({
        body: { file_id: 'file-1', url: 'https://bucket.example/put', method: 'PUT', headers: {} },
      }),
      'PUT /put': () => ({ status: 403, body: {} }),
    });
    const fylane = new Fylane(KEY, { fetchImpl });
    await expect(fylane.files.upload(new Uint8Array([1]))).rejects.toThrow(/may have expired/);
  });

  it('process with poll:false returns the accepted job untouched', async () => {
    const { fetchImpl, calls } = scripted({
      'POST /v1/uploads': () => ({
        body: { file_id: 'file-1', url: 'https://bucket.example/put', method: 'PUT', headers: {} },
      }),
      'PUT /put': () => ({ body: {} }),
      'POST /v1/files/file-1/complete': () => ({ body: { id: 'file-1', state: 'ready' } }),
      'POST /v1/jobs': () => ({ status: 202, body: jobIn('queued') }),
    });
    const fylane = new Fylane(KEY, { fetchImpl });
    const job = await fylane.files.process(new Uint8Array([1]), {
      operation: 'inspect',
      poll: false,
    });
    expect(job.state).toBe('queued');
    expect(calls.filter((c) => c.startsWith('GET /v1/jobs'))).toHaveLength(0);
  });
});

describe('the error envelope, when the API sends less than it promised', () => {
  it('fills every hole with an honest default', async () => {
    const { fetchImpl } = scripted({
      'GET /v1/usage': () => ({ status: 500, body: {} }),
    });
    const fylane = new Fylane(KEY, { fetchImpl, maxRetries: 0 });
    const error = (await fylane.usage().catch((e: unknown) => e)) as FylaneApiError;
    expect(error).toBeInstanceOf(FylaneApiError);
    expect(error.code).toBe('unknown_error');
    expect(error.retryable).toBe(false);
    expect(error.message).toMatch(/500/);
  });
});

describe('the door checks', () => {
  it('refuses to construct without a key', () => {
    expect(() => new Fylane(undefined)).toThrow(FylaneError);
    expect(() => new Fylane('')).toThrow(/API key is required/);
  });
});
