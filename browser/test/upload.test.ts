// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FylaneUploadError, uploadFile } from '../src/index.js';

/**
 * The browser SDK, driven against a scripted XMLHttpRequest: what it
 * sends, what it refuses, and the one property the package exists for —
 * an API key anywhere near it is a hard stop.
 */

interface ScriptedXhr {
  method?: string;
  url?: string;
  headers: Record<string, string>;
  body?: unknown;
  aborted: boolean;
  respond: (status: number) => void;
  progress: (loaded: number, total: number) => void;
  fail: () => void;
}

function scriptXhr(): ScriptedXhr {
  const script: ScriptedXhr = {
    headers: {},
    aborted: false,
    respond: () => undefined,
    progress: () => undefined,
    fail: () => undefined,
  };

  class FakeXhr {
    status = 0;
    upload = {
      listeners: new Map<string, (event: unknown) => void>(),
      addEventListener(name: string, listener: (event: unknown) => void) {
        this.listeners.set(name, listener);
      },
    };

    private listeners = new Map<string, () => void>();

    open(method: string, url: string): void {
      script.method = method;
      script.url = url;
    }

    setRequestHeader(name: string, value: string): void {
      script.headers[name] = value;
    }

    addEventListener(name: string, listener: () => void): void {
      this.listeners.set(name, listener);
    }

    send(body: unknown): void {
      script.body = body;
      script.respond = (status: number) => {
        this.status = status;
        this.listeners.get('load')?.();
      };
      script.progress = (loaded: number, total: number) => {
        this.upload.listeners.get('progress')?.({ lengthComputable: true, loaded, total });
      };
      script.fail = () => {
        this.listeners.get('error')?.();
      };
    }

    abort(): void {
      script.aborted = true;
      this.listeners.get('abort')?.();
    }
  }

  vi.stubGlobal('XMLHttpRequest', FakeXhr);
  return script;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const SESSION = {
  url: 'https://storage.example/bucket/key?X-Amz-Signature=abc',
  method: 'PUT',
  headers: { 'content-type': 'image/png' },
  max_bytes: 1024,
  file_id: 'fil_123',
};

describe('uploadFile', () => {
  it('PUTs the bytes with the session headers and resolves with the file id', async () => {
    const xhr = scriptXhr();
    const file = new Blob(['hello'], { type: 'image/png' });
    const pending = uploadFile(SESSION, file);
    xhr.respond(200);
    const result = await pending;

    expect(xhr.method).toBe('PUT');
    expect(xhr.url).toBe(SESSION.url);
    expect(xhr.headers['content-type']).toBe('image/png');
    expect(xhr.body).toBe(file);
    expect(result.fileId).toBe('fil_123');
    expect(result.status).toBe(200);
  });

  it('reports progress as storage takes the bytes', async () => {
    const xhr = scriptXhr();
    const seen: number[] = [];
    const pending = uploadFile(SESSION, new Blob(['hello']), {
      onProgress: (progress) => seen.push(progress.percent),
    });
    xhr.progress(1, 4);
    xhr.progress(4, 4);
    xhr.respond(200);
    await pending;
    expect(seen).toEqual([25, 100]);
  });

  it('refuses a file over the signed size before any network happens', async () => {
    scriptXhr();
    const big = new Blob([new Uint8Array(2048)]);
    await expect(uploadFile(SESSION, big)).rejects.toThrow(/signed for at most/);
  });

  it('rejects with the status when storage refuses', async () => {
    const xhr = scriptXhr();
    const pending = uploadFile(SESSION, new Blob(['x']));
    xhr.respond(403);
    await expect(pending).rejects.toMatchObject({ status: 403 });
  });

  it('turns a network failure into a named error', async () => {
    const xhr = scriptXhr();
    const pending = uploadFile(SESSION, new Blob(['x']));
    xhr.fail();
    await expect(pending).rejects.toThrow(/never reached storage/);
  });

  it('aborts through the signal', async () => {
    const xhr = scriptXhr();
    const controller = new AbortController();
    const pending = uploadFile(SESSION, new Blob(['x']), { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toThrow(/aborted/);
    expect(xhr.aborted).toBe(true);
  });

  it('refuses insecure URLs, admitting localhost for development', async () => {
    scriptXhr();
    await expect(uploadFile({ url: 'http://storage.example/x' }, new Blob(['x']))).rejects.toThrow(
      /no https URL/,
    );
    const xhr = scriptXhr();
    const pending = uploadFile({ url: 'http://localhost:9100/bucket/key' }, new Blob(['x']));
    xhr.respond(200);
    await expect(pending).resolves.toMatchObject({ status: 200 });
  });

  it('HARD-REFUSES anything shaped like an API key, and says to rotate it', async () => {
    scriptXhr();
    const withKeyHeader = {
      ...SESSION,
      headers: { authorization: 'Bearer fy_live_01ABCDEF_secret' },
    };
    await expect(uploadFile(withKeyHeader, new Blob(['x']))).rejects.toThrow(/treated as leaked/);
    await expect(
      uploadFile({ url: 'https://api.fylane.dev/v1/uploads?key=fy_test_ABC123' }, new Blob(['x'])),
    ).rejects.toThrow(FylaneUploadError);
  });
});
