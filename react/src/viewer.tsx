'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * `<FylaneViewer>` — the document viewer your integration was going to
 * write (#89): page navigation, zoom, keyboard control, honest loading
 * and error states, over the preview images the platform already makes.
 *
 * The same constitutional rule as `<FylaneUpload>`: **the component never
 * sees an API key.** You give it `load`, a function that calls *your*
 * backend — which runs the `preview` operation (or finds its artifacts),
 * mints short-lived download URLs with the key that lives there, and
 * returns plain URLs. The component only ever holds capabilities that
 * expire on their own.
 */

export interface ViewerPage {
  /** A short-lived download URL for this page's image. */
  readonly url: string;
  /** Optional intrinsic size, if your backend knows it. */
  readonly width?: number;
  readonly height?: number;
}

export interface ViewerSource {
  readonly pages: readonly ViewerPage[];
  /** Shown in the default chrome. */
  readonly filename?: string;
}

export type ViewerPhase = 'loading' | 'ready' | 'error';

export interface ViewerState {
  readonly phase: ViewerPhase;
  readonly source: ViewerSource | null;
  /** 1-based, like every page number a person has ever read. */
  readonly page: number;
  readonly zoom: number;
  readonly error: string | null;
}

export interface FylaneViewerHandle {
  readonly state: ViewerState;
  readonly goTo: (page: number) => void;
  readonly next: () => void;
  readonly previous: () => void;
  readonly zoomIn: () => void;
  readonly zoomOut: () => void;
  /** Re-run `load` after an error — URLs expire; a retry re-mints. */
  readonly retry: () => void;
}

export interface FylaneViewerProps {
  /**
   * Fetch the pages — a call to YOUR backend, which holds the API key,
   * finds the preview artifacts, and mints short-lived download URLs.
   */
  readonly load: () => Promise<ViewerSource>;
  /** Open on this page (1-based). Default 1. */
  readonly initialPage?: number;
  readonly onError?: (error: Error) => void;
  /** Render-prop for a fully custom UI. */
  readonly children?: (handle: FylaneViewerHandle) => React.ReactNode;
}

const ZOOM_STEPS = [0.5, 0.75, 1, 1.5, 2, 3] as const;

function clampPage(page: number, source: ViewerSource | null): number {
  const total = source?.pages.length ?? 1;
  return Math.min(Math.max(1, Math.trunc(page)), Math.max(1, total));
}

export function FylaneViewer(props: FylaneViewerProps): React.JSX.Element {
  const [state, setState] = useState<ViewerState>({
    phase: 'loading',
    source: null,
    page: 1,
    zoom: 1,
    error: null,
  });
  // `load` is often an inline arrow; re-running on every identity change
  // would refetch each render. The ref keeps the latest without retriggering.
  const loadRef = useRef(props.load);
  loadRef.current = props.load;

  const run = useCallback(async () => {
    setState((previous) => ({ ...previous, phase: 'loading', error: null }));
    try {
      const source = await loadRef.current();
      if (source.pages.length === 0) {
        throw new Error('The document has no pages to show.');
      }
      setState((previous) => ({
        ...previous,
        phase: 'ready',
        source,
        page: clampPage(props.initialPage ?? previous.page, source),
      }));
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'The document failed to load.';
      setState((previous) => ({ ...previous, phase: 'error', error: message }));
      props.onError?.(error instanceof Error ? error : new Error(message));
    }
  }, []);

  useEffect(() => {
    void run();
  }, [run]);

  const handle: FylaneViewerHandle = {
    state,
    goTo: (page) => {
      setState((previous) => ({ ...previous, page: clampPage(page, previous.source) }));
    },
    next: () => {
      setState((previous) => ({
        ...previous,
        page: clampPage(previous.page + 1, previous.source),
      }));
    },
    previous: () => {
      setState((previous) => ({
        ...previous,
        page: clampPage(previous.page - 1, previous.source),
      }));
    },
    zoomIn: () => {
      setState((previous) => ({
        ...previous,
        zoom: ZOOM_STEPS.find((step) => step > previous.zoom) ?? previous.zoom,
      }));
    },
    zoomOut: () => {
      setState((previous) => ({
        ...previous,
        zoom: [...ZOOM_STEPS].reverse().find((step) => step < previous.zoom) ?? previous.zoom,
      }));
    },
    retry: () => {
      void run();
    },
  };

  if (props.children !== undefined) {
    return <>{props.children(handle)}</>;
  }

  const total = state.source?.pages.length ?? 0;
  const current = state.source?.pages[state.page - 1];

  return (
    <div
      role="region"
      aria-label={state.source?.filename ?? 'Document viewer'}
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.key === 'ArrowRight') handle.next();
        if (event.key === 'ArrowLeft') handle.previous();
      }}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        font: 'inherit',
      }}
    >
      {state.phase === 'loading' && <span aria-live="polite">Loading document…</span>}

      {state.phase === 'error' && (
        <span role="alert">
          {state.error}{' '}
          <button type="button" onClick={handle.retry}>
            Retry
          </button>
        </span>
      )}

      {state.phase === 'ready' && current !== undefined && (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <button type="button" onClick={handle.previous} disabled={state.page <= 1}>
              ‹
            </button>
            <span aria-live="polite">
              Page {state.page} of {total}
            </span>
            <button type="button" onClick={handle.next} disabled={state.page >= total}>
              ›
            </button>
            <span style={{ flex: 1 }} />
            <button type="button" onClick={handle.zoomOut} aria-label="Zoom out">
              −
            </button>
            <span>{Math.round(state.zoom * 100)}%</span>
            <button type="button" onClick={handle.zoomIn} aria-label="Zoom in">
              +
            </button>
          </div>
          <div style={{ overflow: 'auto' }}>
            <img
              src={current.url}
              alt={`Page ${String(state.page)}`}
              {...(current.width === undefined ? {} : { width: current.width * state.zoom })}
              style={{
                display: 'block',
                width: current.width === undefined ? `${String(state.zoom * 100)}%` : undefined,
                maxWidth: current.width === undefined ? 'none' : undefined,
              }}
            />
          </div>
        </>
      )}
    </div>
  );
}
