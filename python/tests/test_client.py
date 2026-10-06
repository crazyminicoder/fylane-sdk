"""The client, tested through its injectable transport — no network.

The properties under test mirror the Node SDK's: the upload dance is the
SDK's job, the wire shapes match the contract (`options`, `validation`,
snake_case), errors are the API's envelope verbatim, retries honour
Retry-After, 204 is an answer, and a failed job is a returned result.
"""

import json
import unittest
from typing import Dict, List, Optional, Tuple

import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from fylane import Fylane, FylaneApiError, FylaneError  # noqa: E402


class Scripted:
    """A transport answering from a script of (matcher → response) steps."""

    def __init__(self):
        self.calls: List[Dict] = []
        self.script: List[Tuple[str, str, int, Dict, bytes]] = []

    def add(self, method: str, path: str, status: int = 200, body=None, headers=None):
        raw = b"" if body is None else json.dumps(body).encode()
        self.script.append((method, path, status, headers or {}, raw))

    def __call__(self, method: str, url: str, headers: Dict[str, str], body: Optional[bytes]):
        self.calls.append(
            {"method": method, "url": url, "headers": headers, "body": body}
        )
        for index, (m, path, status, response_headers, raw) in enumerate(self.script):
            if m == method and path in url:
                self.script.pop(index)
                return status, response_headers, raw
        raise AssertionError(f"Unscripted call: {method} {url}")


class ClientTests(unittest.TestCase):
    def test_requires_a_key(self):
        with self.assertRaises(FylaneError):
            Fylane(None)
        with self.assertRaises(FylaneError):
            Fylane("")

    def test_upload_is_the_whole_dance(self):
        transport = Scripted()
        transport.add(
            "POST",
            "/v1/uploads",
            201,
            {
                "file_id": "f-1",
                "url": "https://bucket.example/put",
                "headers": {"content-length": "5"},
            },
        )
        transport.add("PUT", "bucket.example/put", 200)
        transport.add("POST", "/v1/files/f-1/complete", 200, {"id": "f-1", "state": "ready"})

        client = Fylane("fy_test_x", transport=transport)
        file = client.files.upload(b"hello", filename="note.txt")

        self.assertEqual(file["state"], "ready")
        created = json.loads(transport.calls[0]["body"])
        self.assertEqual(created["filename"], "note.txt")
        self.assertEqual(created["byte_size"], 5)
        self.assertEqual(transport.calls[1]["body"], b"hello")

    def test_validation_policy_travels_in_snake_case(self):
        transport = Scripted()
        transport.add(
            "POST",
            "/v1/uploads",
            201,
            {"file_id": "f-1", "url": "https://b/p", "headers": {}},
        )
        transport.add("PUT", "https://b/p", 200)
        transport.add("POST", "/v1/files/f-1/complete", 200, {"id": "f-1"})

        client = Fylane("fy_test_x", transport=transport)
        client.files.upload(
            b"x", filename="x.png", validation={"formats": ["png"], "max_bytes": 10}
        )
        created = json.loads(transport.calls[0]["body"])
        self.assertEqual(created["validation"], {"formats": ["png"], "max_bytes": 10})

    def test_a_pipeline_goes_on_the_wire_as_operations(self):
        transport = Scripted()
        transport.add("POST", "/v1/jobs", 202, {"id": "j-1", "state": "queued"})
        fylane = Fylane("fy_test_k", transport=transport)
        fylane.jobs.create(
            file_id="f-1",
            operations=["image.resize", "image.convert"],
            params={"width": 640, "format": "webp"},
        )
        sent = json.loads(transport.calls[-1]["body"])
        self.assertEqual(sent["operations"], ["image.resize", "image.convert"])
        self.assertNotIn("operation", sent)
        self.assertEqual(sent["options"], {"width": 640, "format": "webp"})

    def test_job_params_go_on_the_wire_as_options(self):
        transport = Scripted()
        transport.add("POST", "/v1/jobs", 202, {"id": "j-1", "state": "queued"})
        client = Fylane("fy_test_x", transport=transport)
        client.jobs.create(file_id="f-1", operation="pdf.pages", params={"pages": "1-3"})
        sent = json.loads(transport.calls[0]["body"])
        self.assertEqual(sent["options"], {"pages": "1-3"})
        self.assertNotIn("params", sent)

    def test_api_refusals_carry_the_envelope(self):
        transport = Scripted()
        transport.add(
            "GET",
            "/v1/usage",
            402,
            {
                "code": "payment_required",
                "message": "Payment has failed.",
                "request_id": "req_1",
                "retryable": False,
            },
        )
        client = Fylane("fy_test_x", transport=transport)
        with self.assertRaises(FylaneApiError) as caught:
            client.usage()
        self.assertEqual(caught.exception.code, "payment_required")
        self.assertEqual(caught.exception.request_id, "req_1")
        self.assertEqual(caught.exception.status, 402)

    def test_retryable_refusals_retry_and_then_succeed(self):
        transport = Scripted()
        transport.add(
            "GET",
            "/v1/usage",
            429,
            {"code": "rate_limited", "retryable": True},
            {"retry-after": "0"},
        )
        transport.add("GET", "/v1/usage", 200, {"object": "usage"})
        client = Fylane("fy_test_x", transport=transport)
        self.assertEqual(client.usage()["object"], "usage")
        self.assertEqual(len(transport.calls), 2)

    def test_delete_accepts_the_contracts_204(self):
        transport = Scripted()
        transport.add("DELETE", "/v1/files/f-1", 204)
        client = Fylane("fy_test_x", transport=transport)
        self.assertIsNone(client.files.delete("f-1"))

    def test_a_failed_job_is_a_result_not_an_exception(self):
        transport = Scripted()
        transport.add("GET", "/v1/jobs/j-1", 200, {"id": "j-1", "state": "failed", "error": {"code": "unsupported_file"}})
        client = Fylane("fy_test_x", transport=transport)
        job = client.jobs.wait_for("j-1")
        self.assertEqual(job["state"], "failed")
        self.assertEqual(job["error"]["code"], "unsupported_file")


class MultipartTests(unittest.TestCase):
    SESSION = {
        "id": "upl-1",
        "file_id": "f-9",
        "multipart": True,
        "part_size": 4,
        "parts": [
            {"part_number": 1, "url": "https://s.example/k?partNumber=1"},
            {"part_number": 2, "url": "https://s.example/k?partNumber=2"},
        ],
    }

    def test_multipart_slices_puts_and_completes_with_etags(self):
        transport = Scripted()
        transport.add("POST", "/v1/uploads", 201, self.SESSION)
        transport.add("PUT", "partNumber=1", 200, headers={"etag": '"e1"'})
        transport.add("PUT", "partNumber=2", 200, headers={"etag": '"e2"'})
        transport.add(
            "POST", "/v1/uploads/upl-1/complete-parts", 200, {"id": "f-9", "state": "ready"}
        )

        client = Fylane("fy_test_x", transport=transport)
        file = client.files.upload(b"eightbyt", filename="big.bin", multipart=True)

        self.assertEqual(file["state"], "ready")
        created = json.loads(transport.calls[0]["body"])
        self.assertIs(created["multipart"], True)
        self.assertEqual(transport.calls[1]["body"], b"eigh")
        self.assertEqual(transport.calls[2]["body"], b"tbyt")
        completed = json.loads(transport.calls[3]["body"])
        self.assertEqual(
            completed["parts"],
            [
                {"part_number": 1, "etag": '"e1"'},
                {"part_number": 2, "etag": '"e2"'},
            ],
        )

    def test_a_failed_part_re_mints_its_url_and_retries(self):
        transport = Scripted()
        transport.add("POST", "/v1/uploads", 201, self.SESSION)
        transport.add("PUT", "partNumber=1", 200, headers={"etag": '"e1"'})
        transport.add("PUT", "partNumber=2", 500)  # the capability expired
        transport.add(
            "POST",
            "/v1/uploads/upl-1/parts",
            200,
            {
                "object": "upload_parts",
                "part_size": 4,
                "parts": [
                    {"part_number": 1, "url": "https://s.example/k?fresh=1"},
                    {"part_number": 2, "url": "https://s.example/k?fresh=2"},
                ],
            },
        )
        transport.add("PUT", "fresh=2", 200, headers={"etag": '"e2b"'})
        transport.add(
            "POST", "/v1/uploads/upl-1/complete-parts", 200, {"id": "f-9", "state": "ready"}
        )

        client = Fylane("fy_test_x", transport=transport)
        file = client.files.upload(b"eightbyt", filename="big.bin", multipart=True)
        self.assertEqual(file["state"], "ready")
        completed = json.loads(transport.calls[-1]["body"])
        self.assertEqual(completed["parts"][1], {"part_number": 2, "etag": '"e2b"'})

    def test_small_uploads_stay_single_put(self):
        transport = Scripted()
        transport.add("POST", "/v1/uploads", 201, {"file_id": "f-1", "url": "https://b/p", "headers": {}})
        transport.add("PUT", "https://b/p", 200)
        transport.add("POST", "/v1/files/f-1/complete", 200, {"id": "f-1"})
        client = Fylane("fy_test_x", transport=transport)
        client.files.upload(b"tiny", filename="t.txt")
        created = json.loads(transport.calls[0]["body"])
        self.assertNotIn("multipart", created)


class IngestAndHistoryTests(unittest.TestCase):
    def test_upload_from_url_sends_the_url_and_gets_the_file_back(self):
        transport = Scripted()
        transport.add("POST", "/v1/uploads", 200, {"id": "f-3", "state": "ready"})
        client = Fylane("fy_test_x", transport=transport)
        file = client.files.upload_from_url(
            "https://example.com/report.pdf", validation={"formats": ["pdf"]}
        )
        self.assertEqual(file["state"], "ready")
        sent = json.loads(transport.calls[0]["body"])
        self.assertEqual(sent["from_url"], "https://example.com/report.pdf")
        self.assertEqual(sent["validation"], {"formats": ["pdf"]})

    def test_history_reads_the_files_story(self):
        transport = Scripted()
        transport.add(
            "GET",
            "/v1/files/f-1/history",
            200,
            {"object": "file_history", "events": [{"event": "upload_opened"}]},
        )
        client = Fylane("fy_test_x", transport=transport)
        self.assertEqual(client.files.history("f-1")["events"][0]["event"], "upload_opened")

    def test_limits_and_estimate(self):
        transport = Scripted()
        transport.add("GET", "/v1/limits", 200, {"object": "limits"})
        transport.add("POST", "/v1/estimate", 200, {"estimated_credits": 3})
        client = Fylane("fy_test_x", transport=transport)
        self.assertEqual(client.limits()["object"], "limits")
        estimate = client.estimate(operation="pdf.compress", byte_size=1024)
        self.assertEqual(estimate["estimated_credits"], 3)
        sent = json.loads(transport.calls[1]["body"])
        self.assertEqual(sent, {"operation": "pdf.compress", "byte_size": 1024})


class BatchTests(unittest.TestCase):
    def test_create_sends_params_as_options(self):
        transport = Scripted()
        transport.add("POST", "/v1/batches", 202, {"id": "b-1", "total": 2})
        client = Fylane("fy_test_x", transport=transport)
        client.batches.create(
            file_ids=["f-1", "f-2"], operation="image.convert", params={"format": "webp"}
        )
        sent = json.loads(transport.calls[0]["body"])
        self.assertEqual(sent["file_ids"], ["f-1", "f-2"])
        self.assertEqual(sent["options"], {"format": "webp"})
        self.assertNotIn("params", sent)

    def test_wait_for_returns_the_completed_batch_with_its_failures(self):
        transport = Scripted()
        transport.add("GET", "/v1/batches/b-1", 200, {"id": "b-1", "state": "processing"})
        transport.add(
            "GET",
            "/v1/batches/b-1",
            200,
            {
                "id": "b-1",
                "state": "completed",
                "state_counts": {"succeeded": 1, "failed": 1},
            },
        )
        client = Fylane("fy_test_x", transport=transport)
        batch = client.batches.wait_for("b-1")
        self.assertEqual(batch["state_counts"]["failed"], 1)


class WebhookVerifyTests(unittest.TestCase):
    SECRET = "whsec_test"

    def _sign(self, timestamp: int, body: bytes) -> str:
        import hashlib
        import hmac

        mac = hmac.new(
            self.SECRET.encode(), f"{timestamp}.".encode() + body, hashlib.sha256
        ).hexdigest()
        return f"t={timestamp},v1={mac}"

    def test_a_good_signature_returns_the_event(self):
        from fylane import Webhooks

        body = json.dumps({"type": "job.succeeded", "id": "evt_1"}).encode()
        header = self._sign(1_700_000_000, body)
        event = Webhooks.verify(body, header, self.SECRET, _now=1_700_000_010.0)
        self.assertEqual(event["type"], "job.succeeded")

    def test_a_tampered_body_is_refused(self):
        from fylane import FylaneError, Webhooks

        header = self._sign(1_700_000_000, b'{"amount": 1}')
        with self.assertRaises(FylaneError):
            Webhooks.verify(b'{"amount": 9999}', header, self.SECRET, _now=1_700_000_000.0)

    def test_a_replayed_signature_is_refused_by_age(self):
        from fylane import FylaneError, Webhooks

        body = b'{"type": "job.succeeded"}'
        header = self._sign(1_700_000_000, body)
        with self.assertRaises(FylaneError) as caught:
            Webhooks.verify(body, header, self.SECRET, _now=1_700_009_999.0)
        self.assertIn("replay", str(caught.exception))

    def test_a_malformed_header_is_refused(self):
        from fylane import FylaneError, Webhooks

        with self.assertRaises(FylaneError):
            Webhooks.verify(b"{}", "v1=deadbeef", self.SECRET)


if __name__ == "__main__":
    unittest.main()
