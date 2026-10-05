#!/usr/bin/env python3
"""Entry point: one request on stdin, one response on stdout.

This is a pure-function boundary on purpose. There is no server to start, no port to
claim, and no state that can survive between calls, so two concurrent invocations can
never interfere with each other.
"""

from __future__ import annotations

import sys
import time
from typing import Any

from .analysis import analyse
from .protocol import EngineError, read_request, write_response


def handle(op: str, payload: Any) -> Any:
    return analyse(op, payload)


def main() -> int:
    started = time.perf_counter()
    try:
        op, payload = read_request()
        value = handle(op, payload)
    except EngineError as error:
        duration = int((time.perf_counter() - started) * 1000)
        write_response({"ok": False, "error": {"code": error.code, "message": error.message},
                        "durationMs": duration})
        return 0
    except Exception as error:  # noqa: BLE001 - the boundary must never leak a traceback
        duration = int((time.perf_counter() - started) * 1000)
        write_response(
            {"ok": False,
             "error": {"code": "INTERNAL", "message": f"{type(error).__name__}: {error}"},
             "durationMs": duration},
            stream=sys.stderr,
        )
        write_response({"ok": False,
                        "error": {"code": "INTERNAL",
                                  "message": f"{type(error).__name__}: {error}"},
                        "durationMs": duration})
        return 0
    duration = int((time.perf_counter() - started) * 1000)
    write_response({"ok": True, "value": value, "durationMs": duration})
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
