"""Fylane — the file-processing API, from Python.

    from fylane import Fylane

    fylane = Fylane(os.environ["FYLANE_API_KEY"])
    job = fylane.files.process("./report.docx", operation="convert")
"""

from .client import Batches, Files, Fylane, Jobs, Webhooks
from .errors import FylaneApiError, FylaneError

__all__ = ["Fylane", "Files", "Jobs", "Batches", "Webhooks", "FylaneApiError", "FylaneError"]
__version__ = "0.2.0"
