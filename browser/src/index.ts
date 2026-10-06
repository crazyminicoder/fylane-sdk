/**
 * The Fylane browser upload SDK.
 *
 * One job, done carefully: take the upload session your backend minted
 * with its API key, and put the file's bytes exactly where the signed
 * capability says — directly to storage, never through your server, never
 * through Fylane's API. The browser holds a single-object, size-capped,
 * short-lived URL and nothing else.
 *
 * The guardrail this package exists to enforce: **no API key in the
 * browser, ever.** Anything shaped like one, anywhere in the inputs, is a
 * hard refusal — a working integration built on a leaked key would be
 * worse than a broken page.
 *
 * XMLHttpRequest, deliberately: it is the one upload path every browser
 * gives real progress events for. No dependencies, no bundler demands.
 */

/** The upload session object, exactly as `POST /v1/uploads` returns it. */
export interface UploadSession {
  readonly url: string;
  readonly method?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly max_bytes?: number;
  readonly file_id?: string;
}

export interface UploadProgress {
  readonly sent: number;
  readonly total: number;
  /** 0–100, rounded. */
  readonly percent: number;
}

export interface UploadOptions {
  readonly onProgress?: (progress: UploadProgress) => void;
  readonly signal?: AbortSignal;
}

export interface UploadResult {
  /** The file this session was minted for, when the session named it. */
  readonly fileId?: string;
  readonly status: number;
}

/** An upload refused before or by storage — the message says which. */
export class FylaneUploadError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'FylaneUploadError';
    if (status !== undefined) this.status = status;
  }
}

const KEY_PATTERN = /fy_(?:live|test)_[0-9A-Za-z]/;

function refuseApiKeys(session: UploadSession): void {
  const suspects = [session.url, ...Object.values(session.headers ?? {})];
  for (const value of suspects) {
    if (typeof value === 'string' && KEY_PATTERN.test(value)) {
      throw new FylaneUploadError(
        'An API key reached the browser. Keys belong on your server; the browser gets ' +
          'only the upload session your server minted with one. Rotate this key now — ' +
          'it has been in a page and must be treated as leaked.',
      );
    }
  }
}

/**
 * Upload one file with the given session. Resolves when storage accepts
 * the bytes; rejects with `FylaneUploadError` when anything refuses.
 *
 * After this resolves, tell your backend to complete the file
 * (`POST /v1/files/{file_id}/complete`) — from the server, with the key
 * that lives there.
 */
export async function uploadFile(
  session: UploadSession,
  file: Blob,
  options: UploadOptions = {},
): Promise<UploadResult> {
  refuseApiKeys(session);

  // http is admitted for localhost only — development storage endpoints.
  const url = typeof session.url === 'string' ? session.url : '';
  if (!/^https:\/\//.test(url) && !/^http:\/\/(?:localhost|127\.0\.0\.1)[:/]/.test(url)) {
    throw new FylaneUploadError('The upload session has no https URL.');
  }
  if (session.max_bytes !== undefined && file.size > session.max_bytes) {
    throw new FylaneUploadError(
      `The file is ${String(file.size)} bytes; this session is signed for at most ` +
        `${String(session.max_bytes)}. Mint a session with the real size.`,
    );
  }

  return await new Promise<UploadResult>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(session.method ?? 'PUT', session.url);
    for (const [name, value] of Object.entries(session.headers ?? {})) {
      // A signed session can carry host and content-length — the browser
      // owns those and refuses to let a page set them. It sends the same
      // values on its own, so the signature still verifies.
      const lower = name.toLowerCase();
      if (lower === 'host' || lower === 'content-length') continue;
      xhr.setRequestHeader(name, value);
    }

    const abort = (): void => {
      xhr.abort();
    };
    options.signal?.addEventListener('abort', abort, { once: true });
    const settle = (outcome: () => void): void => {
      options.signal?.removeEventListener('abort', abort);
      outcome();
    };

    if (options.onProgress !== undefined) {
      xhr.upload.addEventListener('progress', (event) => {
        const total = event.lengthComputable ? event.total : file.size;
        options.onProgress?.({
          sent: event.loaded,
          total,
          percent: total === 0 ? 100 : Math.round((event.loaded / total) * 100),
        });
      });
    }

    xhr.addEventListener('load', () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        settle(() => {
          resolve({
            status: xhr.status,
            ...(session.file_id === undefined ? {} : { fileId: session.file_id }),
          });
        });
      } else {
        settle(() => {
          reject(
            new FylaneUploadError(
              `Storage refused the upload (${String(xhr.status)}). The capability is ` +
                'signed for one size and one content type — send exactly what the ' +
                'session was minted for.',
              xhr.status,
            ),
          );
        });
      }
    });
    xhr.addEventListener('error', () => {
      settle(() => {
        reject(
          new FylaneUploadError(
            'The upload never reached storage — a network failure, or a CORS refusal.',
          ),
        );
      });
    });
    xhr.addEventListener('abort', () => {
      settle(() => {
        reject(new FylaneUploadError('The upload was aborted.'));
      });
    });

    xhr.send(file);
  });
}

export interface MultipartSession {
  readonly parts: readonly { readonly part_number: number; readonly url: string }[];
  readonly part_size: number;
  readonly file_id?: string;
}

export interface PartResult {
  readonly part_number: number;
  readonly etag: string;
}

export interface MultipartOptions {
  readonly onProgress?: (progress: UploadProgress) => void;
  readonly signal?: AbortSignal;
  /** Parts in flight at once. */
  readonly concurrency?: number;
}

/**
 * The browser half of a multipart upload: slice the file by the session's
 * part size, PUT every part to its own capability URL, and hand back the
 * etags. Completing the upload is your **server's** job —
 * `POST /v1/uploads/{id}/complete-parts` with these parts, using the key
 * that lives there. A failed part retries once; a lost connection loses
 * only the parts still in flight, and your server can mint fresh part
 * URLs any time (`POST /v1/uploads/{id}/parts`) to resume.
 */
export async function uploadParts(
  session: MultipartSession,
  file: Blob,
  options: MultipartOptions = {},
): Promise<readonly PartResult[]> {
  for (const part of session.parts) {
    if (KEY_PATTERN.test(part.url)) {
      throw new FylaneUploadError(
        'An API key reached the browser. Keys belong on your server; rotate this key now — ' +
          'it has been in a page and must be treated as leaked.',
      );
    }
  }
  const partSize = session.part_size;
  if (!Number.isInteger(partSize) || partSize <= 0) {
    throw new FylaneUploadError('The session has no part size.');
  }

  const sent = new Array<number>(session.parts.length).fill(0);
  const report = (): void => {
    const total = file.size;
    const loaded = sent.reduce((sum, value) => sum + value, 0);
    options.onProgress?.({
      sent: loaded,
      total,
      percent: total === 0 ? 100 : Math.round((loaded / total) * 100),
    });
  };

  const putPart = (part: { part_number: number; url: string }): Promise<PartResult> =>
    new Promise<PartResult>((resolve, reject) => {
      const index = part.part_number - 1;
      const start = index * partSize;
      const body = file.slice(start, Math.min(start + partSize, file.size));
      const xhr = new XMLHttpRequest();
      xhr.open('PUT', part.url);
      const abort = (): void => {
        xhr.abort();
      };
      options.signal?.addEventListener('abort', abort, { once: true });
      const settle = (outcome: () => void): void => {
        options.signal?.removeEventListener('abort', abort);
        outcome();
      };
      xhr.upload.addEventListener('progress', (event) => {
        sent[index] = event.loaded;
        report();
      });
      xhr.addEventListener('load', () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          const etag = xhr.getResponseHeader('ETag') ?? '';
          sent[index] = body.size;
          report();
          settle(() => {
            resolve({ part_number: part.part_number, etag });
          });
        } else {
          settle(() => {
            reject(
              new FylaneUploadError(
                `Storage refused part ${String(part.part_number)} (${String(xhr.status)}).`,
                xhr.status,
              ),
            );
          });
        }
      });
      xhr.addEventListener('error', () => {
        settle(() => {
          reject(new FylaneUploadError(`Part ${String(part.part_number)} never reached storage.`));
        });
      });
      xhr.addEventListener('abort', () => {
        settle(() => {
          reject(new FylaneUploadError('The upload was aborted.'));
        });
      });
      xhr.send(body);
    });

  const withRetry = async (part: { part_number: number; url: string }): Promise<PartResult> => {
    try {
      return await putPart(part);
    } catch (error) {
      if (options.signal?.aborted === true) throw error;
      return putPart(part); // one retry — transient network, not policy
    }
  };

  const queue = [...session.parts];
  const results: PartResult[] = [];
  const lanes = Math.max(1, Math.min(options.concurrency ?? 3, 8));
  await Promise.all(
    Array.from({ length: lanes }, async () => {
      for (;;) {
        const part = queue.shift();
        if (part === undefined) return;
        results.push(await withRetry(part));
      }
    }),
  );
  return results.sort((a, b) => a.part_number - b.part_number);
}
