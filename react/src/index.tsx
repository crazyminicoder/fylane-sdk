'use client';

export {
  FylaneViewer,
  type FylaneViewerHandle,
  type FylaneViewerProps,
  type ViewerPage,
  type ViewerPhase,
  type ViewerSource,
  type ViewerState,
} from './viewer.js';

import { useCallback, useRef, useState } from 'react';
import {
  FylaneUploadError,
  uploadFile,
  uploadParts,
  type MultipartSession,
  type PartResult,
  type UploadProgress,
  type UploadSession,
} from '@fylane/browser';

/**
 * `<FylaneUpload>` — the drop zone your integration was going to write.
 *
 * The constitutional rule, inherited from `@fylane/browser`: **the
 * component never sees an API key.** You give it `createSession`, a
 * function that calls *your* backend, which mints the upload session with
 * the key that lives there. Single-PUT and multipart sessions are both
 * handled — the session's own shape decides — and multipart completion
 * goes back through your backend too (`completeParts`), because assembling
 * an upload is an authenticated act.
 *
 * Two ways to use it: drop it in bare for a working uploader with minimal
 * inline styling, or pass a render function as `children` and own every
 * pixel — the function receives the state machine and the verbs.
 */

export type UploadPhase = 'idle' | 'uploading' | 'completing' | 'done' | 'error';

export interface UploadState {
  readonly phase: UploadPhase;
  readonly file: File | null;
  readonly progress: UploadProgress | null;
  readonly error: string | null;
  /** Whatever your `complete` callback resolved with. */
  readonly result: unknown;
}

export interface FylaneUploadHandle {
  readonly state: UploadState;
  /** Open the file picker. */
  readonly open: () => void;
  /** Abort the transfer in flight. */
  readonly abort: () => void;
  /** Re-run the last file after an error. */
  readonly retry: () => void;
}

export interface FylaneUploadProps {
  /**
   * Mint an upload session for this file — a call to YOUR backend, which
   * holds the API key. Return the session object exactly as
   * `POST /v1/uploads` answered it (single-PUT or `multipart: true`).
   */
  readonly createSession: (
    file: File,
  ) => Promise<UploadSession | (MultipartSession & { id?: string })>;
  /**
   * Finish the upload — again through your backend. For single-PUT
   * sessions call `POST /v1/files/{fileId}/complete`; for multipart call
   * `POST /v1/uploads/{sessionId}/complete-parts` with the parts you are
   * given. Whatever this resolves with becomes `state.result`.
   */
  readonly complete?: (input: {
    readonly session: UploadSession | (MultipartSession & { id?: string });
    readonly fileId?: string;
    readonly parts?: readonly PartResult[];
  }) => Promise<unknown>;
  readonly onComplete?: (result: unknown) => void;
  readonly onError?: (error: Error) => void;
  /** `accept` attribute for the file input, e.g. `"image/*,.pdf"`. */
  readonly accept?: string;
  /** Render-prop for a fully custom UI. */
  readonly children?: (handle: FylaneUploadHandle) => React.ReactNode;
}

function isMultipart(session: UploadSession | MultipartSession): session is MultipartSession {
  return Array.isArray((session as MultipartSession).parts);
}

export function FylaneUpload(props: FylaneUploadProps): React.JSX.Element {
  const [state, setState] = useState<UploadState>({
    phase: 'idle',
    file: null,
    progress: null,
    error: null,
    result: null,
  });
  const inputRef = useRef<HTMLInputElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const lastFileRef = useRef<File | null>(null);

  const run = useCallback(
    async (file: File) => {
      lastFileRef.current = file;
      const controller = new AbortController();
      abortRef.current = controller;
      setState({ phase: 'uploading', file, progress: null, error: null, result: null });

      try {
        const session = await props.createSession(file);
        const onProgress = (progress: UploadProgress): void => {
          setState((previous) => ({ ...previous, progress }));
        };

        let fileId: string | undefined;
        let parts: readonly PartResult[] | undefined;
        if (isMultipart(session)) {
          parts = await uploadParts(session, file, { onProgress, signal: controller.signal });
          fileId = session.file_id;
        } else {
          const uploaded = await uploadFile(session, file, {
            onProgress,
            signal: controller.signal,
          });
          fileId = uploaded.fileId;
        }

        setState((previous) => ({ ...previous, phase: 'completing' }));
        const result =
          props.complete === undefined
            ? { fileId }
            : await props.complete({
                session,
                ...(fileId === undefined ? {} : { fileId }),
                ...(parts === undefined ? {} : { parts }),
              });

        setState((previous) => ({ ...previous, phase: 'done', result }));
        props.onComplete?.(result);
      } catch (error: unknown) {
        const message =
          error instanceof FylaneUploadError || error instanceof Error
            ? error.message
            : 'The upload failed.';
        setState((previous) => ({ ...previous, phase: 'error', error: message }));
        props.onError?.(error instanceof Error ? error : new Error(message));
      } finally {
        abortRef.current = null;
      }
    },
    [props],
  );

  const handle: FylaneUploadHandle = {
    state,
    open: () => inputRef.current?.click(),
    abort: () => abortRef.current?.abort(),
    retry: () => {
      if (lastFileRef.current !== null) void run(lastFileRef.current);
    },
  };

  const input = (
    <input
      ref={inputRef}
      type="file"
      data-testid="fylane-file-input"
      style={{ display: 'none' }}
      {...(props.accept === undefined ? {} : { accept: props.accept })}
      onChange={(event) => {
        const file = event.target.files?.[0];
        if (file !== undefined) void run(file);
        event.target.value = '';
      }}
    />
  );

  if (props.children !== undefined) {
    return (
      <>
        {input}
        {props.children(handle)}
      </>
    );
  }

  const percent = state.progress?.percent ?? 0;
  return (
    <div
      role="button"
      tabIndex={0}
      aria-label="Upload a file"
      onClick={handle.open}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') handle.open();
      }}
      onDragOver={(event) => {
        event.preventDefault();
      }}
      onDrop={(event) => {
        event.preventDefault();
        const file = event.dataTransfer.files[0];
        if (file !== undefined) void run(file);
      }}
      style={{
        border: '1px dashed currentColor',
        borderRadius: 8,
        padding: '20px 24px',
        cursor: 'pointer',
        font: 'inherit',
        textAlign: 'center',
        opacity: state.phase === 'uploading' || state.phase === 'completing' ? 0.85 : 1,
      }}
    >
      {input}
      {state.phase === 'idle' && <span>Drop a file, or click to choose</span>}
      {state.phase === 'uploading' && (
        <span aria-live="polite">
          Uploading {state.file?.name} · {percent}%
        </span>
      )}
      {state.phase === 'completing' && <span aria-live="polite">Finishing…</span>}
      {state.phase === 'done' && <span>Uploaded {state.file?.name} ✓</span>}
      {state.phase === 'error' && (
        <span role="alert">
          {state.error}{' '}
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              handle.retry();
            }}
          >
            Retry
          </button>
        </span>
      )}
      {(state.phase === 'uploading' || state.phase === 'completing') && (
        <div
          aria-hidden
          style={{
            marginTop: 10,
            height: 3,
            borderRadius: 999,
            background: 'color-mix(in srgb, currentColor 20%, transparent)',
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              height: '100%',
              width: `${String(state.phase === 'completing' ? 100 : percent)}%`,
              background: 'currentColor',
              transition: 'width 200ms ease',
            }}
          />
        </div>
      )}
    </div>
  );
}
