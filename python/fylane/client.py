"""The Fylane client.

    from fylane import Fylane

    fylane = Fylane(os.environ["FYLANE_API_KEY"])
    job = fylane.files.process("./report.docx", operation="convert")
    print(job["state"], job["artifacts"])

Three rules carry the design, the same three as the Node SDK:

- The upload dance (create a session, PUT the bytes, complete) is the
  SDK's job, never the caller's.
- Errors are the API's own envelope as a raised ``FylaneApiError`` — same
  code, same request id, nothing invented. A *processing* failure is not
  an exception: a finished job in state ``failed`` is a result, returned.
- Nothing beyond the standard library. A dependency in an SDK is a
  dependency in every customer's application.

The HTTP transport is injectable (``transport=``) so the whole client is
testable without a network; the default rides ``urllib``.
"""

from __future__ import annotations

import hashlib
import hmac as hmac_module
import json
import random
import time
import urllib.error
import urllib.request
from typing import Any, Callable, Dict, IO, List, Optional, Tuple, Union

from .errors import FylaneApiError, FylaneError

DEFAULT_BASE_URL = "https://api.fylane.dev"
POLL_INITIAL_SECONDS = 0.5
POLL_CAP_SECONDS = 3.0
DEFAULT_TIMEOUT_SECONDS = 300.0
# Past this, upload() switches to multipart on its own: one failed PUT of a
# large body wastes the whole transfer; parts fail and retry alone.
MULTIPART_THRESHOLD_BYTES = 64 * 1024 * 1024
WEBHOOK_TOLERANCE_SECONDS = 300

# (status, headers, body-bytes) from (method, url, headers, body-bytes-or-None).
Transport = Callable[[str, str, Dict[str, str], Optional[bytes]], Tuple[int, Dict[str, str], bytes]]


def _urllib_transport(
    method: str, url: str, headers: Dict[str, str], body: Optional[bytes]
) -> Tuple[int, Dict[str, str], bytes]:
    request = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=120) as response:
            return response.status, {k.lower(): v for k, v in response.headers.items()}, response.read()
    except urllib.error.HTTPError as error:
        return error.code, {k.lower(): v for k, v in error.headers.items()}, error.read()


class Fylane:
    def __init__(
        self,
        api_key: Optional[str],
        *,
        base_url: str = DEFAULT_BASE_URL,
        transport: Optional[Transport] = None,
        max_retries: int = 2,
    ):
        if not api_key:
            raise FylaneError(
                "An API key is required: Fylane(os.environ['FYLANE_API_KEY']). "
                "Create one in the console."
            )
        self._api_key = api_key
        self._base_url = base_url.rstrip("/")
        self._transport = transport or _urllib_transport
        self._max_retries = max_retries

        self.files = Files(self)
        self.jobs = Jobs(self)
        self.batches = Batches(self)
        self.webhooks = Webhooks(self)

    def usage(self) -> Dict[str, Any]:
        return self.request("GET", "/v1/usage")

    def limits(self) -> Dict[str, Any]:
        """What the platform accepts: formats, operations, caps. Cacheable."""
        return self.request("GET", "/v1/limits")

    def estimate(self, *, operation: str, byte_size: int) -> Dict[str, Any]:
        """The price before the work: credits for this operation at this size."""
        return self.request(
            "POST", "/v1/estimate", {"operation": operation, "byte_size": byte_size}
        )

    # -- internal ---------------------------------------------------------

    def request(
        self,
        method: str,
        path: str,
        body: Optional[Dict[str, Any]] = None,
        headers: Optional[Dict[str, str]] = None,
    ) -> Any:
        attempt = 0
        while True:
            sent_headers = {"authorization": f"Bearer {self._api_key}"}
            payload: Optional[bytes] = None
            if body is not None:
                payload = json.dumps(body).encode("utf-8")
                sent_headers["content-type"] = "application/json"
            if headers:
                sent_headers.update(headers)

            status, response_headers, raw = self._transport(
                method, f"{self._base_url}{path}", sent_headers, payload
            )

            if 200 <= status < 300:
                # 204 is a contract answer, not an empty JSON document.
                if status == 204 or raw == b"":
                    return None
                return json.loads(raw.decode("utf-8"))

            try:
                envelope = json.loads(raw.decode("utf-8"))
            except (ValueError, UnicodeDecodeError):
                envelope = {}
            error = FylaneApiError(status, envelope)
            if not error.retryable or attempt >= self._max_retries:
                raise error

            attempt += 1
            retry_after = response_headers.get("retry-after")
            try:
                base = float(retry_after) if retry_after is not None else 0.4 * (2**attempt)
            except ValueError:
                base = 0.4 * (2**attempt)
            time.sleep(base + random.random() * 0.25)

    def put_bytes(self, url: str, upload_headers: Dict[str, str], data: bytes) -> None:
        """The raw PUT of bytes to a presigned capability."""
        status, _, _ = self._transport("PUT", url, dict(upload_headers), data)
        if not 200 <= status < 300:
            raise FylaneError(
                f"The upload itself failed ({status}). "
                "The URL may have expired — create the upload again."
            )

    def put_part(self, url: str, data: bytes) -> str:
        """PUT one multipart slice; the etag in the answer names the part."""
        status, headers, _ = self._transport("PUT", url, {}, data)
        if not 200 <= status < 300:
            raise FylaneError(f"A part upload failed ({status}).")
        etag = headers.get("etag")
        if not etag:
            raise FylaneError(
                "Storage answered the part without an etag — with a proxy in "
                "between, make sure it forwards the ETag response header."
            )
        return etag


UploadInput = Union[str, bytes, IO[bytes]]


def _materialise(source: UploadInput, filename: Optional[str]) -> Tuple[bytes, str]:
    if isinstance(source, bytes):
        if not filename:
            raise FylaneError("Uploading raw bytes needs a filename= for detection to hint from.")
        return source, filename
    if isinstance(source, str):
        import os.path

        with open(source, "rb") as handle:
            return handle.read(), filename or os.path.basename(source)
    data = source.read()
    name = filename or getattr(source, "name", None)
    if not name:
        raise FylaneError("Uploading a stream needs a filename=.")
    import os.path

    return data, os.path.basename(str(name))


class Files:
    def __init__(self, client: Fylane):
        self._client = client

    def process(
        self,
        source: UploadInput,
        *,
        operation: Optional[str] = None,
        preset: Optional[str] = None,
        operations: Optional[List[str]] = None,
        params: Optional[Dict[str, Any]] = None,
        filename: Optional[str] = None,
        mime_type: Optional[str] = None,
        validation: Optional[Dict[str, Any]] = None,
        idempotency_key: Optional[str] = None,
        poll: bool = True,
        timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS,
    ) -> Dict[str, Any]:
        """The whole loop in one call: upload, run, and (by default) wait.

        A failed job comes back as a job in state ``failed``, not as an
        exception — the reason is on ``job["error"]``.
        """
        file = self.upload(
            source, filename=filename, mime_type=mime_type, validation=validation
        )
        job = self._client.jobs.create(
            file_id=file["id"],
            operation=operation,
            preset=preset,
            operations=operations,
            params=params,
            idempotency_key=idempotency_key,
        )
        if not poll:
            return job
        return self._client.jobs.wait_for(job["id"], timeout_seconds=timeout_seconds)

    def upload(
        self,
        source: UploadInput,
        *,
        filename: Optional[str] = None,
        mime_type: Optional[str] = None,
        validation: Optional[Dict[str, Any]] = None,
        multipart: Optional[bool] = None,
    ) -> Dict[str, Any]:
        """Upload alone: session → bytes → completion, returning the ready file.

        Past ``MULTIPART_THRESHOLD_BYTES`` the transfer goes multipart on its
        own (``multipart=`` overrides either way): parts fail and retry
        individually instead of restarting the whole body. The bytes are held
        in memory either way — this client reads, then sends.
        """
        data, name = _materialise(source, filename)
        body: Dict[str, Any] = {"filename": name, "byte_size": len(data)}
        if mime_type is not None:
            body["mime_type"] = mime_type
        if validation is not None:
            body["validation"] = validation

        use_multipart = (
            multipart if multipart is not None else len(data) >= MULTIPART_THRESHOLD_BYTES
        )
        if use_multipart:
            body["multipart"] = True
            session = self._client.request("POST", "/v1/uploads", body)
            return self._upload_parts(session, data)

        session = self._client.request("POST", "/v1/uploads", body)
        self._client.put_bytes(session["url"], session["headers"], data)
        return self._client.request("POST", f"/v1/files/{session['file_id']}/complete")

    def _upload_parts(self, session: Dict[str, Any], data: bytes) -> Dict[str, Any]:
        size = int(session["part_size"])
        finished: List[Dict[str, Any]] = []
        for part in session["parts"]:
            number = int(part["part_number"])
            chunk = data[(number - 1) * size : number * size]
            try:
                etag = self._client.put_part(part["url"], chunk)
            except FylaneError:
                # One free retry on a fresh URL — a re-mint is also the
                # resume path, so an expired capability heals itself here.
                minted = self._client.request(
                    "POST", f"/v1/uploads/{session['id']}/parts"
                )
                url = next(
                    fresh["url"]
                    for fresh in minted["parts"]
                    if int(fresh["part_number"]) == number
                )
                etag = self._client.put_part(url, chunk)
            finished.append({"part_number": number, "etag": etag})
        return self._client.request(
            "POST",
            f"/v1/uploads/{session['id']}/complete-parts",
            {"parts": finished},
        )

    def upload_from_url(
        self,
        url: str,
        *,
        filename: Optional[str] = None,
        mime_type: Optional[str] = None,
        validation: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """The API fetches the URL itself — no bytes pass through here.

        Public URLs only: the platform refuses private addresses and
        redirects, and accepts at most its dedupe-window size (see
        ``limits()``). The answer is already the completed, validated file.
        """
        body: Dict[str, Any] = {"from_url": url}
        if filename is not None:
            body["filename"] = filename
        if mime_type is not None:
            body["mime_type"] = mime_type
        if validation is not None:
            body["validation"] = validation
        return self._client.request("POST", "/v1/uploads", body)

    def history(self, file_id: str) -> Dict[str, Any]:
        """The file's own story: upload, validation, every job, in order."""
        return self._client.request("GET", f"/v1/files/{_encode(file_id)}/history")

    def get(self, file_id: str) -> Dict[str, Any]:
        return self._client.request("GET", f"/v1/files/{_encode(file_id)}")

    def list(self, *, limit: Optional[int] = None) -> Dict[str, Any]:
        query = "" if limit is None else f"?limit={int(limit)}"
        return self._client.request("GET", f"/v1/files{query}")

    def download_url(self, file_id: str, *, artifact_id: Optional[str] = None) -> Dict[str, Any]:
        """A short-lived URL for the original file, or one of its artifacts."""
        body: Dict[str, Any] = {}
        if artifact_id is not None:
            body["artifact_id"] = artifact_id
        return self._client.request(
            "POST", f"/v1/files/{_encode(file_id)}/download-url", body
        )

    def delete(self, file_id: str) -> None:
        """Delete a file: the stored bytes go, the metadata record survives."""
        self._client.request("DELETE", f"/v1/files/{_encode(file_id)}")


class Jobs:
    def __init__(self, client: Fylane):
        self._client = client

    def create(
        self,
        *,
        file_id: str,
        operation: Optional[str] = None,
        preset: Optional[str] = None,
        operations: Optional[List[str]] = None,
        params: Optional[Dict[str, Any]] = None,
        idempotency_key: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Accept work. ``operations`` names a pipeline: several catalogue
        operations as one job, charged the sum of its steps, sharing ``params``.
        Mutually exclusive with ``operation`` and ``preset``."""
        body: Dict[str, Any] = {"file_id": file_id}
        if operation is not None:
            body["operation"] = operation
        if preset is not None:
            body["preset"] = preset
        if operations is not None:
            body["operations"] = list(operations)
        if params is not None:
            # `options` on the wire, per the contract; params here for ergonomics.
            body["options"] = params
        headers = {} if idempotency_key is None else {"idempotency-key": idempotency_key}
        return self._client.request("POST", "/v1/jobs", body, headers)

    def get(self, job_id: str) -> Dict[str, Any]:
        return self._client.request("GET", f"/v1/jobs/{_encode(job_id)}")

    def cancel(self, job_id: str) -> Dict[str, Any]:
        """Cancel queued work. Running work finishes; the API answers 409."""
        return self._client.request("POST", f"/v1/jobs/{_encode(job_id)}/cancel")

    def wait_for(
        self, job_id: str, *, timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS
    ) -> Dict[str, Any]:
        """Poll until the job is terminal. Failure is a returned result."""
        deadline = time.monotonic() + timeout_seconds
        delay = POLL_INITIAL_SECONDS
        while True:
            job = self.get(job_id)
            if job.get("state") in ("succeeded", "failed", "cancelled"):
                return job
            if time.monotonic() >= deadline:
                raise FylaneError(
                    f"The job did not finish within {timeout_seconds:g}s; "
                    "it is still running — poll jobs.get() or raise timeout_seconds."
                )
            time.sleep(delay)
            delay = min(delay * 2, POLL_CAP_SECONDS)


class Batches:
    """Many files, one operation, one handle. Members are ordinary jobs."""

    def __init__(self, client: Fylane):
        self._client = client

    def create(
        self,
        *,
        file_ids: List[str],
        operation: Optional[str] = None,
        preset: Optional[str] = None,
        params: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """Accepted atomically: every member admitted and priced, or a 4xx."""
        body: Dict[str, Any] = {"file_ids": file_ids}
        if operation is not None:
            body["operation"] = operation
        if preset is not None:
            body["preset"] = preset
        if params is not None:
            body["options"] = params
        return self._client.request("POST", "/v1/batches", body)

    def get(self, batch_id: str) -> Dict[str, Any]:
        return self._client.request("GET", f"/v1/batches/{_encode(batch_id)}")

    def wait_for(
        self, batch_id: str, *, timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS
    ) -> Dict[str, Any]:
        """Poll until every member is terminal. Per-item failures are items."""
        deadline = time.monotonic() + timeout_seconds
        delay = POLL_INITIAL_SECONDS
        while True:
            batch = self.get(batch_id)
            if batch.get("state") == "completed":
                return batch
            if time.monotonic() >= deadline:
                raise FylaneError(
                    f"The batch did not finish within {timeout_seconds:g}s; "
                    "it is still running — poll batches.get() or raise timeout_seconds."
                )
            time.sleep(delay)
            delay = min(delay * 2, POLL_CAP_SECONDS)


class Webhooks:
    def __init__(self, client: Fylane):
        self._client = client

    def create(self, *, url: str, events: List[str]) -> Dict[str, Any]:
        return self._client.request(
            "POST", "/v1/webhook-endpoints", {"url": url, "events": events}
        )

    def list(self) -> Dict[str, Any]:
        return self._client.request("GET", "/v1/webhook-endpoints")

    def delete(self, endpoint_id: str) -> Dict[str, Any]:
        return self._client.request("DELETE", f"/v1/webhook-endpoints/{_encode(endpoint_id)}")

    @staticmethod
    def verify(
        payload: Union[bytes, str],
        signature_header: str,
        secret: str,
        *,
        tolerance_seconds: int = WEBHOOK_TOLERANCE_SECONDS,
        _now: Optional[float] = None,
    ) -> Dict[str, Any]:
        """Verify a delivery's ``Fylane-Signature`` header; return the event.

        The header is ``t=<unix seconds>,v1=<hex hmac-sha256 of "t.body">``.
        Verify against the *raw* request body, before any parsing — a
        re-serialised body is a different byte string. Raises ``FylaneError``
        on a bad signature or a timestamp outside the replay tolerance.
        """
        raw = payload if isinstance(payload, bytes) else payload.encode("utf-8")
        fields: Dict[str, List[str]] = {}
        for pair in signature_header.split(","):
            name, _, value = pair.strip().partition("=")
            fields.setdefault(name, []).append(value)
        timestamps = fields.get("t", [])
        signatures = fields.get("v1", [])
        if len(timestamps) != 1 or not signatures:
            raise FylaneError("The signature header is not in t=...,v1=... form.")
        try:
            timestamp = int(timestamps[0])
        except ValueError:
            raise FylaneError("The signature timestamp is not a number.")

        expected = hmac_module.new(
            secret.encode("utf-8"),
            f"{timestamp}.".encode("utf-8") + raw,
            hashlib.sha256,
        ).hexdigest()
        if not any(
            hmac_module.compare_digest(expected, candidate) for candidate in signatures
        ):
            raise FylaneError(
                "The signature does not match — wrong secret, or a body "
                "modified in flight."
            )
        now = time.time() if _now is None else _now
        if abs(now - timestamp) > tolerance_seconds:
            raise FylaneError(
                f"The signature is {abs(now - timestamp):.0f}s old, beyond the "
                f"{tolerance_seconds}s replay tolerance."
            )
        return json.loads(raw.decode("utf-8"))


def _encode(value: str) -> str:
    import urllib.parse

    return urllib.parse.quote(value, safe="")
