# @fylane/browser

> Part of [Fylane](https://fylane.dev) — file conversion and fixing for PDFs, images, documents, audio and video. Docs: [fylane.dev/docs/quickstart](https://fylane.dev/docs/quickstart) · Free tools: [fylane.dev/tools](https://fylane.dev/tools)

Direct-to-storage uploads from the browser — **no API key ever touches the
page**. Your backend holds the key and mints an upload session; this SDK
takes that session and moves the bytes, with progress.

```ts
import { uploadFile } from '@fylane/browser';

// 1. Your backend calls POST /v1/uploads with its API key and returns the
//    session JSON to the page. The session is a single-use capability for
//    exactly this file — that is the only thing the browser ever holds.
const session = await fetch('/api/uploads', {
  method: 'POST',
  body: JSON.stringify({ filename: file.name, byte_size: file.size }),
}).then((r) => r.json());

// 2. The browser PUTs the bytes straight to storage.
await uploadFile(session, file, {
  onProgress: ({ loaded, total, percent }) => render(percent),
});

// 3. Your backend completes the upload (POST /v1/files/{id}/complete) and
//    creates whatever jobs come next.
```

## Multipart

Large files use the same shape with `multipart: true` in the session
request. Hand the multipart session to `uploadParts` — parts fly
concurrently, progress aggregates across them, and the resolved
`{part_number, etag}` list goes back to your backend for
`POST /v1/uploads/{id}/complete-parts`:

```ts
import { uploadParts } from '@fylane/browser';

const parts = await uploadParts(session, file, { onProgress });
await fetch(`/api/uploads/${session.id}/complete`, {
  method: 'POST',
  body: JSON.stringify({ parts }),
});
```

## The key rule

If anything shaped like a Fylane API key (`fy_live_…`, `fy_test_…`)
reaches this SDK — as a session field, a header value, anywhere — it
refuses to run and tells you to treat the key as leaked. A key in browser
JavaScript is a key in the page source.

Building with React? `@fylane/react` wraps this SDK in a drop-zone
component with the same rule.

## License

MIT
