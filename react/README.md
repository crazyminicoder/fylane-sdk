# @fylane/react

> Part of [Fylane](https://fylane.dev) — file conversion and fixing for PDFs, images, documents, audio and video. Docs: [fylane.dev/docs/quickstart](https://fylane.dev/docs/quickstart) · Free tools: [fylane.dev/tools](https://fylane.dev/tools)

`<FylaneUpload>` — the drop zone your integration was going to write:
picker + drag-and-drop, progress, retry, abort, multipart. Built on
`@fylane/browser`, so it inherits the rule that matters: **the component
never sees an API key.** You give it two callbacks that talk to _your_
backend, where the key lives.

```tsx
import { FylaneUpload } from '@fylane/react';

<FylaneUpload
  accept="image/*,.pdf"
  createSession={async (file) => {
    // Your backend calls POST /v1/uploads with its key.
    const r = await fetch('/api/uploads', {
      method: 'POST',
      body: JSON.stringify({ filename: file.name, byte_size: file.size }),
    });
    return r.json();
  }}
  complete={async ({ fileId, parts }) => {
    // Single-PUT: POST /v1/files/{fileId}/complete.
    // Multipart:  POST /v1/uploads/{id}/complete-parts with `parts`.
    const r = await fetch(`/api/files/${fileId}/complete`, {
      method: 'POST',
      body: JSON.stringify({ parts }),
    });
    return r.json();
  }}
  onComplete={(file) => console.log('ready', file)}
/>;
```

A multipart session routes itself — if `createSession` returns a session
with a `parts` array, the component uploads the parts and hands the
`{part_number, etag}` list to your `complete` callback.

## Custom UI

Pass a render function as `children` and own every pixel; it receives the
state machine and the verbs:

```tsx
<FylaneUpload createSession={mint}>
  {({ state, open, abort, retry }) => (
    <button onClick={open}>
      {state.phase === 'uploading' ? `${state.progress?.percent ?? 0}%` : 'Upload'}
    </button>
  )}
</FylaneUpload>
```

Phases: `idle → uploading → completing → done`, with `error` reachable
from any of them and `retry()` re-running the same file.

## The viewer

`<FylaneViewer>` shows a processed document — page navigation, zoom,
keyboard control — over the preview images the platform already makes.
Same rule: your backend runs the `preview` operation and mints
short-lived download URLs; the component only ever holds URLs that
expire on their own.

```tsx
import { FylaneViewer } from '@fylane/react';

<FylaneViewer
  load={async () => {
    // Your backend: find the file's preview artifacts, mint download
    // URLs for each, answer { pages: [{ url, width?, height? }] }.
    const r = await fetch(`/api/files/${fileId}/previews`);
    return r.json();
  }}
/>;
```

A render function as `children` receives `{ state, goTo, next, previous,
zoomIn, zoomOut, retry }` for a fully custom reader. `retry()` re-runs
`load` — which is also how expired URLs heal.

## License

MIT
