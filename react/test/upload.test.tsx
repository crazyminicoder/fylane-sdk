// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEventModule from '@testing-library/user-event';

// NodeNext resolves user-event's CJS default awkwardly; runtime nests it
// under `default`, the published namespace type hides the methods. One
// minimal cast covers both loaders.
const userEvent = ((userEventModule as unknown as { default?: unknown }).default ??
  userEventModule) as {
  upload: (element: Element, file: File) => Promise<void>;
  click: (element: Element) => Promise<void>;
};
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FylaneUpload } from '../src/index.js';

/**
 * The component, driven as a user would: pick a file, watch the phases,
 * see the finish — with the same scripted XMLHttpRequest the browser SDK
 * tests use, because the component's whole transport IS that SDK.
 */

interface ScriptedXhr {
  url?: string;
  body?: unknown;
  respond: (status: number) => void;
  progress: (loaded: number, total: number) => void;
}

function scriptXhr(auto = true): ScriptedXhr {
  const script: ScriptedXhr = { respond: () => undefined, progress: () => undefined };
  class FakeXhr {
    status = 0;
    upload = {
      listeners: new Map<string, (event: unknown) => void>(),
      addEventListener(name: string, listener: (event: unknown) => void) {
        this.listeners.set(name, listener);
      },
    };

    private listeners = new Map<string, () => void>();

    open(_method: string, url: string): void {
      script.url = url;
    }

    setRequestHeader(): void {
      /* headers uninteresting here */
    }

    getResponseHeader(): string {
      return '"etag-1"';
    }

    addEventListener(name: string, listener: () => void): void {
      this.listeners.set(name, listener);
    }

    send(body: unknown): void {
      script.body = body;
      // Instance-local closers: several parts fly concurrently, and the
      // shared script handle would only ever answer the last of them.
      const respond = (status: number): void => {
        this.status = status;
        this.listeners.get('load')?.();
      };
      const progress = (loaded: number, total: number): void => {
        this.upload.listeners.get('progress')?.({ lengthComputable: true, loaded, total });
      };
      script.respond = respond;
      script.progress = progress;
      if (auto) {
        queueMicrotask(() => {
          progress(1, 2);
          respond(200);
        });
      }
    }

    abort(): void {
      this.listeners.get('abort')?.();
    }
  }
  vi.stubGlobal('XMLHttpRequest', FakeXhr);
  return script;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const SESSION = {
  url: 'https://storage.test/bucket/key?X-Amz-Signature=abc',
  method: 'PUT',
  headers: {},
  file_id: 'fil_1',
};

async function pick(file = new File(['hello'], 'photo.png', { type: 'image/png' })) {
  await userEvent.upload(screen.getByTestId('fylane-file-input'), file);
}

describe('<FylaneUpload>', () => {
  it('uploads through the session the backend minted and reports done', async () => {
    scriptXhr();
    const createSession = vi.fn().mockResolvedValue(SESSION);
    const complete = vi.fn().mockResolvedValue({ id: 'fil_1', state: 'ready' });
    const onComplete = vi.fn();
    render(
      <FylaneUpload createSession={createSession} complete={complete} onComplete={onComplete} />,
    );

    await pick();
    await waitFor(() => {
      expect(screen.getByText(/Uploaded photo.png/)).toBeTruthy();
    });
    expect(createSession).toHaveBeenCalledOnce();
    expect(complete).toHaveBeenCalledWith(expect.objectContaining({ fileId: 'fil_1' }));
    expect(onComplete).toHaveBeenCalledWith({ id: 'fil_1', state: 'ready' });
  });

  it('shows the failure and retries the same file', async () => {
    scriptXhr();
    const createSession = vi
      .fn()
      .mockRejectedValueOnce(new Error('backend said no'))
      .mockResolvedValue(SESSION);
    render(<FylaneUpload createSession={createSession} />);

    await pick();
    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain('backend said no');
    });

    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => {
      expect(screen.getByText(/Uploaded photo.png/)).toBeTruthy();
    });
    expect(createSession).toHaveBeenCalledTimes(2);
  });

  it('routes a multipart session through uploadParts and hands the etags to complete', async () => {
    scriptXhr();
    const multipart = {
      id: 'upl_1',
      file_id: 'fil_9',
      part_size: 4,
      parts: [
        { part_number: 1, url: 'https://storage.test/k?partNumber=1&uploadId=u' },
        { part_number: 2, url: 'https://storage.test/k?partNumber=2&uploadId=u' },
      ],
    };
    const complete = vi.fn().mockResolvedValue({ assembled: true });
    render(
      <FylaneUpload createSession={vi.fn().mockResolvedValue(multipart)} complete={complete} />,
    );

    await pick(new File(['eightbyte'], 'big.bin'));
    await waitFor(() => {
      expect(screen.getByText(/Uploaded big.bin/)).toBeTruthy();
    });
    expect(complete).toHaveBeenCalledWith(
      expect.objectContaining({
        fileId: 'fil_9',
        parts: [
          { part_number: 1, etag: '"etag-1"' },
          { part_number: 2, etag: '"etag-1"' },
        ],
      }),
    );
  });

  it('hands full control to a render function', async () => {
    scriptXhr();
    render(
      <FylaneUpload createSession={vi.fn().mockResolvedValue(SESSION)}>
        {({ state, open }) => (
          <button type="button" onClick={open}>
            custom-open ({state.phase})
          </button>
        )}
      </FylaneUpload>,
    );
    expect(screen.getByText('custom-open (idle)')).toBeTruthy();
    await pick();
    await waitFor(() => {
      expect(screen.getByText('custom-open (done)')).toBeTruthy();
    });
  });
});
