"""The wire protocol between the TypeScript host and this engine.

One JSON object in on stdin, one JSON object out on stdout:

    {"op": "<operation>", "input": <any JSON value>}

    {"ok": true,  "value": <result>, "durationMs": 3}
    {"ok": false, "error": {"code": "<CODE>", "message": "<human readable>"}, "durationMs": 3}

Nothing else is ever written to stdout. Diagnostics go to stderr, so a caller can parse
stdout unconditionally.
"""

from __future__ import annotations

import json
import sys
from collections.abc import Callable
from typing import Any, Final, TypedDict

MAX_INPUT_BYTES: Final[int] = 8 * 1024 * 1024


class EngineError(Exception):
    """An error with a stable code, so the host can map it to an exit code or HTTP status."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


class SuccessResponse(TypedDict):
    ok: bool
    value: Any
    durationMs: int


class ErrorBody(TypedDict):
    code: str
    message: str


class ErrorResponse(TypedDict):
    ok: bool
    error: ErrorBody
    durationMs: int


Handler = Callable[[Any], Any]


def read_request(stream: Any = None) -> tuple[str, Any]:
    """Read and parse exactly one request. Raises EngineError on anything malformed."""
    stream = sys.stdin if stream is None else stream
    raw = stream.read(MAX_INPUT_BYTES + 1)
    if len(raw) > MAX_INPUT_BYTES:
        raise EngineError("INPUT_TOO_LARGE", f"request exceeds {MAX_INPUT_BYTES} bytes")
    if not raw.strip():
        raise EngineError("EMPTY_INPUT", "expected one JSON object on stdin")
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as cause:
        raise EngineError("BAD_JSON", f"stdin is not valid JSON: {cause}") from cause
    if not isinstance(parsed, dict):
        raise EngineError("BAD_SHAPE", "request must be a JSON object")
    op = parsed.get("op")
    if not isinstance(op, str) or not op:
        raise EngineError("MISSING_OP", "request is missing a string \"op\"")
    return op, parsed.get("input")


def write_response(response: SuccessResponse | ErrorResponse, stream: Any = None) -> None:
    stream = sys.stdout if stream is None else stream
    stream.write(json.dumps(response, separators=(",", ":"), default=str))
    stream.write("\n")
    stream.flush()


def dispatch(handlers: dict[str, Handler], op: str, payload: Any) -> Any:
    """Route to a handler, converting any exception into a stable error code."""
    handler = handlers.get(op)
    if handler is None:
        known = ", ".join(sorted(handlers))
        raise EngineError("UNKNOWN_OP", f"unknown op {op!r}; available: {known}")
    return handler(payload)
