from __future__ import annotations

import io
import json

import pytest

from odometry_scope.__main__ import handle
from odometry_scope.protocol import EngineError, dispatch, read_request, write_response


class TestReadRequest:
    def test_parses_a_valid_request(self) -> None:
        op, payload = read_request(io.StringIO('{"op":"summarize","input":{"records":[]}}'))
        assert op == "summarize"
        assert payload == {"records": []}

    @pytest.mark.parametrize(
        ("raw", "code"),
        [
            ("", "EMPTY_INPUT"),
            ("{not json", "BAD_JSON"),
            ("[1,2,3]", "BAD_SHAPE"),
            ('{"input":1}', "MISSING_OP"),
            ('{"op":"","input":1}', "MISSING_OP"),
        ],
    )
    def test_rejects_malformed_input_with_a_stable_code(self, raw: str, code: str) -> None:
        with pytest.raises(EngineError) as caught:
            read_request(io.StringIO(raw))
        assert caught.value.code == code


class TestWriteResponse:
    def test_writes_exactly_one_line_of_json(self) -> None:
        buffer = io.StringIO()
        write_response({"ok": True, "value": {"a": 1}, "durationMs": 2}, stream=buffer)
        lines = buffer.getvalue().strip().split("\n")
        assert len(lines) == 1
        assert json.loads(lines[0]) == {"ok": True, "value": {"a": 1}, "durationMs": 2}

    def test_writes_an_error_response_without_raising(self) -> None:
        buffer = io.StringIO()
        write_response(
            {"ok": False, "error": {"code": "X", "message": "y"}, "durationMs": 0},
            stream=buffer,
        )
        assert json.loads(buffer.getvalue())["ok"] is False


class TestDispatch:
    def test_routes_to_a_handler(self) -> None:
        assert dispatch({"echo": lambda payload: payload}, "echo", 7) == 7

    def test_unknown_op_names_the_available_ones(self) -> None:
        with pytest.raises(EngineError) as caught:
            dispatch({}, "nope", None)
        assert caught.value.code == "UNKNOWN_OP"
        assert "available" in caught.value.message


class TestHandle:
    def test_handle_routes_to_the_real_operations(self) -> None:
        result = handle(
            "summarize",
            {"channels": {"t": [0.0, 1.0], "x": [0.0, 1.0], "y": [0.0, 0.0], "theta": [0.0, 0.0]}},
        )
        assert result["count"] == 2
        assert result["durationS"] == 1.0

    def test_unknown_operation_is_an_error_not_a_crash(self) -> None:
        with pytest.raises(EngineError) as caught:
            handle("nope", None)
        assert caught.value.code == "UNKNOWN_OP"

    def test_a_failing_handler_propagates_its_code(self) -> None:
        with pytest.raises(EngineError) as caught:
            handle("integrate", {"channels": "not-an-object"})
        assert caught.value.code == "BAD_SHAPE"
