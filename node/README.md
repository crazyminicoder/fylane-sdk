# @fylane/node

> Part of [Fylane](https://fylane.dev) — file conversion and fixing for PDFs, images, documents, audio and video. Docs: [fylane.dev/docs/quickstart](https://fylane.dev/docs/quickstart) · Free tools: [fylane.dev/tools](https://fylane.dev/tools)

The official Fylane SDK for Node.js. One call uploads a file, runs an
operation, and waits for the result:

```ts
import { Fylane } from '@fylane/node';

const fylane = new Fylane(process.env.FYLANE_API_KEY);

const job = await fylane.files.process('./report.docx', { operation: 'convert' });
console.log(job.state, job.artifacts);
```

The SDK owns the upload dance (create a session, PUT the bytes, complete),
polls with backoff until the job is terminal, and retries transient failures
exactly when the API marks them retryable. A request that goes unanswered is
abandoned after `requestTimeoutMs` (30 s) and retried the same way.

## Results and errors

A _processing_ failure is a result, not an exception: a job that finishes in
state `failed` is returned, with the reason on `job.error`. Everything else —
bad requests, exhausted credits, invalid keys — throws `FylaneApiError`
carrying the API's own `code`, `message`, `requestId` (quote it to support)
and `docsUrl`.

## Keys

A `fy_live_` key refuses to construct anywhere a browser could see it — a key
in browser JavaScript is a key in the page source. Call Fylane from your
backend; use `fy_test_` keys for local experiments.

## Webhooks

Verify a delivery's `Fylane-Signature` header against the **raw** request
body — before any JSON parsing, because a re-serialised body is a
different byte string:

```ts
import { verifyWebhookSignature } from '@fylane/node';

app.post('/webhooks/fylane', express.raw({ type: '*/*' }), (req, res) => {
  const event = verifyWebhookSignature(
    req.body, // Buffer — the raw bytes
    req.header('fylane-signature')!,
    process.env.FYLANE_WEBHOOK_SECRET!,
  );
  // A bad signature or a stale timestamp (replay) throws FylaneError.
  handle(event);
  res.sendStatus(204);
});
```

## Surface

- `fylane.files.process(input, { operation | preset | operations, … })` — the whole loop; `operations: ['image.resize', 'image.convert']` runs a pipeline as one job, charged the sum of its steps
- `fylane.files.upload / get / list / downloadUrl`
- `fylane.jobs.create / get / list / waitFor`
- `fylane.webhooks.create / list / delete / test`
- `fylane.usage()`
- `verifyWebhookSignature(body, header, secret)`

`input` is bytes, a `Blob`/`File`, or a filesystem path.

MIT.
