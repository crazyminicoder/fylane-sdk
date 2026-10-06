"""Errors, envelope-faithful.

A refusal from the API arrives as its own error envelope — code, message,
request id, docs URL — and is raised as a FylaneApiError carrying exactly
that, nothing invented. A *processing* failure is not an exception: a
finished job in state ``failed`` is a result, returned.
"""

from __future__ import annotations

from typing import Any, Dict, Optional


class FylaneError(Exception):
    """The SDK's own refusals — misuse the API never saw."""


class FylaneApiError(FylaneError):
    """The API's refusal, verbatim."""

    def __init__(self, status: int, envelope: Dict[str, Any]):
        self.status = status
        self.code: str = str(envelope.get("code", "unknown"))
        self.message: str = str(envelope.get("message", "The request failed."))
        self.request_id: Optional[str] = envelope.get("request_id")
        self.docs_url: Optional[str] = envelope.get("docs_url")
        self.retryable: bool = bool(envelope.get("retryable", False))
        self.details: Optional[Dict[str, Any]] = envelope.get("details")
        super().__init__(f"{self.code}: {self.message}")
