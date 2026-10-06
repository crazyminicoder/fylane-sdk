# fylane

> Part of [Fylane](https://fylane.dev) — file conversion and fixing for PDFs, images, documents, audio and video. Docs: [fylane.dev/docs/quickstart](https://fylane.dev/docs/quickstart) · Free tools: [fylane.dev/tools](https://fylane.dev/tools)

The Fylane file-processing API, from Python. Zero dependencies.

```python
import os
from fylane import Fylane

fylane = Fylane(os.environ["FYLANE_API_KEY"])

# The whole loop in one call: upload → process → wait.
job = fylane.files.process("./report.docx", operation="convert")
print(job["state"])                      # "succeeded" — or "failed", returned, not raised
for artifact in job["artifacts"]:
    print(artifact["role"], artifact["mime"])

# Download an output.
url = fylane.files.download_url(job["file_id"], artifact_id=job["artifacts"][0]["id"])
```

- The upload dance (session → PUT → complete) is the SDK's job, never yours.
  Past 64 MiB the transfer goes multipart on its own — parts fail and retry
  individually — and `multipart=` overrides in either direction.
- API refusals raise `FylaneApiError` carrying the API's own envelope —
  same `code`, same `request_id`, nothing invented. Retryable refusals
  (429/5xx) retry with backoff, honouring `Retry-After`.
- A _processing_ failure is a result, not an exception: a finished job in
  state `failed` comes back with its `error` attached.

## Several steps, one job

```python
job = fylane.files.process(
    "./photo.jpg",
    operations=["image.resize", "image.convert"],   # a pipeline, charged the sum of its steps
    params={"width": 640, "format": "webp"},
)
```

## Many files at once

```python
batch = fylane.batches.create(
    file_ids=[f["id"] for f in uploaded],
    operation="image.convert",
    params={"format": "webp"},
)
done = fylane.batches.wait_for(batch["id"])
print(done["state_counts"])   # per-item failures are items, and only successes are charged
```

## Ingest without moving bytes

```python
file = fylane.files.upload_from_url("https://example.com/report.pdf")
```

The API fetches the URL itself (public addresses only — private ranges and
redirects are refused server-side) and answers with the completed,
validated file.

## Webhooks, verified

```python
from fylane import Webhooks

@app.post("/webhooks/fylane")
def receive():
    event = Webhooks.verify(
        request.get_data(),                     # the RAW body, before parsing
        request.headers["Fylane-Signature"],
        os.environ["FYLANE_WEBHOOK_SECRET"],
    )   # bad signature or stale timestamp (replay) → FylaneError
    handle(event)
    return "", 204
```

## Surface

- `fylane.files.process / upload / upload_from_url / get / list / history / download_url / delete`
- `fylane.jobs.create / get / cancel / wait_for`
- `fylane.batches.create / get / wait_for`
- `fylane.webhooks.create / list / delete` and `Webhooks.verify(...)`
- `fylane.usage()`, `fylane.limits()`, `fylane.estimate(...)`

Tests: `python3 -m unittest discover -s tests` (no network; the HTTP
transport is injectable).

MIT.
