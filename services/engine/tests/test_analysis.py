"""Tests for the deterministic engine.

Three layers, because each catches a different class of regression:

  * unit tests pin the behaviour of every exported operation, including boundary values
  * property tests (hypothesis) pin the invariants that must hold for *any* input
  * a golden-file test pins exact output for a known input, which is the anti-drift guard
"""

from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Any

import pytest
from hypothesis import given, settings
from hypothesis import strategies as st

from odometry_scope.analysis import (
    OPERATIONS,
    analyse,
    attribute,
    classify,
    divergence,
    integrate,
    normalize,
    summarize,
)
from odometry_scope.kinematics import (
    SeriesLengthError,
    derivative_series,
    integrate_track,
    IntegrationParams,
    interpolate,
    path_length,
    unwrap_angle,
    wrap_to_pi,
)
from odometry_scope.protocol import EngineError

GOLDEN_DIR = Path(__file__).parent / "golden"


def straight_track(
    count: int = 40, speed: float = 1.0, rate: float = 20.0, yaw: float = 0.0
) -> dict[str, list[float]]:
    """A constant-speed, constant-yaw-rate drive — the simplest non-trivial track."""
    dt = 1.0 / rate
    times = [i * dt for i in range(count)]
    return {
        "t": times,
        "v": [speed] * count,
        "omega": [yaw] * count,
    }


def position_of(track: dict[str, list[float]], params: IntegrationParams) -> dict[str, list[float]]:
    integrated = integrate_track(
        track["t"], track["v"], track["omega"], params
    )
    return {"x": integrated.xs, "y": integrated.ys, "theta": integrated.thetas}


class TestUnwrapAngle:
    def test_empty_series(self) -> None:
        assert unwrap_angle([]) == []

    def test_already_continuous_is_unchanged(self) -> None:
        assert unwrap_angle([0.0, 0.5, 1.0]) == [0.0, 0.5, 1.0]

    def test_a_wrap_across_pi_is_removed(self) -> None:
        # 3.0 -> -3.0 is a +0.283 rad step once unwrapped, not a -6.0 rad jump.
        assert unwrap_angle([3.0, -3.0]) == pytest.approx([3.0, 3.0 + 0.28318530717958623])

    def test_never_jumps_by_more_than_half_a_turn(self) -> None:
        # Unwrapping removes 2*pi teleports; it must not flatten a genuine reversal, so the
        # invariant is "no step exceeds pi", not "never decreases".
        wrapped = [0.0, 3.0, -3.0, 3.0, -3.0, 0.1]
        out = unwrap_angle(wrapped)
        for i in range(1, len(out)):
            assert abs(out[i] - out[i - 1]) <= math.pi + 1e-9


class TestDerivativeSeries:
    def test_rejects_a_series_that_is_too_short(self) -> None:
        with pytest.raises(SeriesLengthError):
            derivative_series([0.0], [1.0])

    def test_rejects_mismatched_lengths(self) -> None:
        with pytest.raises(SeriesLengthError):
            derivative_series([0.0, 1.0], [1.0])

    def test_a_straight_line_has_its_slope(self) -> None:
        times = [0.0, 1.0, 2.0, 3.0]
        values = [0.0, 2.0, 4.0, 6.0]
        assert derivative_series(times, values) == pytest.approx([2.0, 2.0, 2.0, 2.0])


class TestIntegrateTrack:
    def test_a_single_sample_is_just_the_initial_condition(self) -> None:
        track = integrate_track([0.0], [1.0], [0.0], IntegrationParams(x0=2.0, y0=3.0, theta0=0.5))
        assert track.xs == [2.0]
        assert track.ys == [3.0]
        assert track.path_length == 0.0

    def test_straight_line_advance_is_exact(self) -> None:
        # With theta pinned at 0 the ODE reduces to dx/dt = v, which RK4 integrates exactly.
        track = integrate_track([0.0, 1.0], [2.0, 2.0], [0.0, 0.0], IntegrationParams())
        assert track.xs[1] == pytest.approx(2.0, abs=1e-12)
        assert track.ys[1] == pytest.approx(0.0, abs=1e-12)

    def test_rejects_mismatched_series_lengths(self) -> None:
        with pytest.raises(SeriesLengthError):
            integrate_track([0.0, 1.0], [1.0], [0.0, 0.0], IntegrationParams())

    def test_rejects_a_substep_count_below_one(self) -> None:
        with pytest.raises(ValueError):
            integrate_track([0.0, 1.0], [1.0, 1.0], [0.0, 0.0], IntegrationParams(substeps=0))

    def test_more_substeps_track_the_analytic_arc_closer(self) -> None:
        # A constant turn rate has a closed-form arc; RK4 converges on it as substeps rise.
        coarse = integrate_track([0.0, 1.0], [1.0, 1.0], [1.0, 1.0], IntegrationParams(substeps=1))
        fine = integrate_track([0.0, 1.0], [1.0, 1.0], [1.0, 1.0], IntegrationParams(substeps=64))
        exact = (math.sin(1.0), 1.0 - math.cos(1.0))
        assert abs(fine.xs[1] - exact[0]) < abs(coarse.xs[1] - exact[0])

    def test_estimating_the_error_reports_a_positive_local_truncation(self) -> None:
        turning = integrate_track(
            [0.0, 1.0], [1.0, 1.0], [1.0, 1.0], IntegrationParams(substeps=4, estimate_error=True)
        )
        straight = integrate_track(
            [0.0, 1.0], [1.0, 1.0], [0.0, 0.0], IntegrationParams(substeps=4, estimate_error=True)
        )
        assert turning.max_local_error > 0.0
        assert straight.max_local_error == pytest.approx(0.0, abs=1e-15)


class TestInterpolate:
    def test_reproduces_the_source_grid(self) -> None:
        times = [0.0, 1.0, 2.0]
        values = [0.0, 10.0, 20.0]
        assert interpolate(times, values, times) == pytest.approx(values)

    def test_holds_the_nearest_endpoint_outside_the_range(self) -> None:
        out = interpolate([1.0, 2.0], [5.0, 6.0], [0.0, 3.0])
        assert out == pytest.approx([5.0, 6.0])

    def test_rejects_mismatched_lengths(self) -> None:
        with pytest.raises(SeriesLengthError):
            interpolate([0.0, 1.0], [1.0], [0.0])


class TestWrapToPi:
    @pytest.mark.parametrize("angle", [0.0, math.pi, -math.pi, 7.0, -7.0, 2.0 * math.pi])
    def test_result_is_always_inside_the_principal_range(self, angle: float) -> None:
        assert -math.pi - 1e-12 <= wrap_to_pi(angle) <= math.pi + 1e-12


class TestNormalize:
    def test_reads_common_field_aliases(self) -> None:
        result = normalize(
            {
                "samples": [
                    {"time": 0.0, "px": 0.0, "py": 0.0, "yaw": 0.0, "speed": 1.0, "yaw_rate": 0.0},
                    {"time": 1.0, "px": 1.0, "py": 0.0, "yaw": 0.0, "speed": 1.0, "yaw_rate": 0.0},
                ]
            }
        )
        assert result["channels"]["t"] == [0.0, 1.0]
        assert result["channels"]["x"] == [0.0, 1.0]
        assert result["count"] == 2

    def test_sorts_out_of_order_samples_and_says_so(self) -> None:
        result = normalize({"samples": [{"t": 1.0}, {"t": 0.0}, {"t": 2.0}]})
        assert result["channels"]["t"] == [0.0, 1.0, 2.0]
        assert result["reordered"] is True

    def test_an_already_sorted_log_is_not_flagged_as_reordered(self) -> None:
        assert normalize({"samples": [{"t": 0.0}, {"t": 1.0}]})["reordered"] is False

    def test_computes_the_sample_rate(self) -> None:
        result = normalize({"samples": [{"t": i * 0.5} for i in range(5)]})
        assert result["rateHz"] == pytest.approx(2.0)
        assert result["durationS"] == pytest.approx(2.0)

    def test_rejects_a_non_list(self) -> None:
        with pytest.raises(EngineError) as caught:
            normalize({"samples": "nope"})
        assert caught.value.code == "BAD_SHAPE"

    def test_rejects_a_sample_that_is_not_an_object(self) -> None:
        with pytest.raises(EngineError) as caught:
            normalize({"samples": [1]})
        assert caught.value.code == "BAD_SHAPE"

    def test_rejects_a_non_finite_value(self) -> None:
        with pytest.raises(EngineError) as caught:
            normalize({"samples": [{"t": float("nan")}]})
        assert caught.value.code == "BAD_SHAPE"

    def test_rejects_samples_without_a_timestamp(self) -> None:
        with pytest.raises(EngineError) as caught:
            normalize({"samples": [{"x": 1.0}]})
        assert caught.value.code == "MISSING_FIELD"

    @settings(max_examples=50, deadline=None)
    @given(st.lists(st.floats(-1e3, 1e3, allow_nan=False), min_size=1, max_size=12))
    def test_the_data_result_is_order_independent(self, stamps: list[float]) -> None:
        samples = [{"t": stamp} for stamp in stamps]
        forward = normalize({"samples": samples})
        backward = normalize({"samples": list(reversed(samples))})
        # `reordered` is excluded on purpose: it describes the input's arrival order, while
        # everything that describes the data must be identical.
        for field in ("channels", "count", "durationS", "rateHz", "presentFields", "issues"):
            assert forward[field] == backward[field]


class TestIntegrate:
    def test_derives_v_from_positions_when_absent(self) -> None:
        result = integrate(
            {
                "channels": {
                    "t": [0.0, 1.0, 2.0],
                    "x": [0.0, 1.0, 2.0],
                    "y": [0.0, 0.0, 0.0],
                    "theta": [0.0, 0.0, 0.0],
                }
            }
        )
        assert "derived 'v' from the position columns" in result["issues"]
        # Differentiating a position track and re-integrating it under a zero-order hold is
        # lossy: the endpoint differences do not sum back to the original path. That is
        # expected and is why the envelope is computed from the *stated* rate uncertainty
        # rather than from a round-trip through positions.
        assert 1.0 < result["x"][-1] <= 2.0

    def test_a_rate_only_track_is_reproduced_exactly(self) -> None:
        # The contract that matters: when rates are actually recorded, integration is faithful.
        result = integrate({"channels": straight_track(count=10, speed=1.5, rate=10.0)})
        assert result["x"][-1] == pytest.approx(1.5 * 0.9, abs=1e-12)

    def test_a_heading_only_track_still_supplies_omega(self) -> None:
        result = integrate(
            {
                "channels": {
                    "t": [0.0, 1.0, 2.0],
                    "x": [0.0, 1.0, 2.0],
                    "y": [0.0, 0.0, 0.0],
                    "theta": [0.0, 0.5, 1.0],
                }
            }
        )
        assert "derived 'omega' from the heading column" in result["issues"]

    def test_cannot_integrate_without_any_rate_information(self) -> None:
        with pytest.raises(EngineError) as caught:
            integrate({"channels": {"t": [0.0, 1.0]}})
        assert caught.value.code == "MISSING_FIELD"

    def test_rejects_columns_of_different_lengths(self) -> None:
        with pytest.raises(EngineError) as caught:
            integrate({"channels": {"t": [0.0, 1.0], "v": [1.0], "omega": [0.0, 0.0]}})
        assert caught.value.code == "LENGTH_MISMATCH"

    def test_rejects_a_negative_parameter(self) -> None:
        with pytest.raises(EngineError) as caught:
            integrate({"channels": straight_track(), "params": {"substeps": 0}})
        assert caught.value.code == "BAD_SHAPE"

    def test_reports_the_substeps_it_used(self) -> None:
        result = integrate({"channels": straight_track(), "params": {"substeps": 8}})
        assert result["substeps"] == 8

    def test_is_deterministic(self) -> None:
        payload = {"channels": straight_track(count=25, speed=1.5, yaw=0.2), "params": {"substeps": 4}}
        assert integrate(payload) == integrate(payload)


class TestDivergence:
    def test_an_estimate_matching_its_reference_shows_no_drift(self) -> None:
        track = straight_track(count=30)
        pose = position_of(track, IntegrationParams(estimate_error=True))
        result = divergence(
            {
                "estimate": {**track, "x": pose["x"], "y": pose["y"], "theta": pose["theta"]},
                "truth": {"t": track["t"], "x": pose["x"], "y": pose["y"], "theta": pose["theta"]},
            }
        )
        assert result["maxObserved"] == pytest.approx(0.0, abs=1e-12)
        assert result["exceeded"] is False
        assert result["firstExceedance"] is None

    def test_an_offset_estimate_drifts_and_escapes_a_tight_envelope(self) -> None:
        track = straight_track(count=30)
        pose = position_of(track, IntegrationParams())
        drifted_x = [value + 0.25 for value in pose["x"]]
        result = divergence(
            {
                "estimate": {**track, "x": drifted_x, "y": pose["y"]},
                "truth": {"t": track["t"], "x": pose["x"], "y": pose["y"]},
                "params": {"rateSigma": 0.0, "rateSigmaOmega": 0.0},
            }
        )
        assert result["exceeded"] is True
        assert result["firstExceedance"] is not None
        assert result["boundRatio"] > 1.0

    def test_strict_mode_raises_instead_of_reporting_an_escaped_bound(self) -> None:
        track = straight_track(count=20)
        pose = position_of(track, IntegrationParams())
        drifted_x = [value + 0.5 for value in pose["x"]]
        with pytest.raises(EngineError) as caught:
            divergence(
                {
                    "estimate": {**track, "x": drifted_x, "y": pose["y"]},
                    "truth": {"t": track["t"], "x": pose["x"], "y": pose["y"]},
                    "params": {"rateSigma": 0.0, "rateSigmaOmega": 0.0, "strict": True},
                }
            )
        assert caught.value.code == "BOUND_VIOLATION"
        assert "escaped the certified envelope" in caught.value.message

    def test_strict_mode_returns_normally_when_the_bound_holds(self) -> None:
        track = straight_track(count=20)
        pose = position_of(track, IntegrationParams(estimate_error=True))
        channels = {**track, "x": pose["x"], "y": pose["y"], "theta": pose["theta"]}
        result = divergence(
            {
                "estimate": channels,
                "truth": {"t": track["t"], "x": pose["x"], "y": pose["y"], "theta": pose["theta"]},
                "params": {"strict": True},
            }
        )
        assert result["exceeded"] is False

    def test_the_bound_never_shrinks(self) -> None:
        track = straight_track(count=40, speed=2.0)
        pose = position_of(track, IntegrationParams(estimate_error=True))
        result = divergence(
            {
                "estimate": {**track, "x": pose["x"], "y": pose["y"]},
                "truth": {"t": track["t"], "x": pose["x"], "y": pose["y"]},
            }
        )
        bounds = [step["bound"] for step in result["steps"]]
        for i in range(1, len(bounds)):
            assert bounds[i] >= bounds[i - 1] - 1e-15

    def test_the_bound_grows_like_a_random_walk_not_exponentially(self) -> None:
        # Regression guard. A worst-case (all steps erring together) Lipschitz propagation
        # compounds as (1 + v*h)^k and reaches astronomical values, which would make the
        # bound useless. The bound must stay in the sqrt(k) regime.
        track = straight_track(count=400, speed=1.2, rate=20.0)
        pose = position_of(track, IntegrationParams(estimate_error=True))
        result = divergence(
            {
                "estimate": {**track, "x": pose["x"], "y": pose["y"]},
                "truth": {"t": track["t"], "x": pose["x"], "y": pose["y"]},
            }
        )
        # A physically sane bound for ~20s of 1% rate uncertainty is centimetres, not metres.
        assert result["maxBound"] < 1.0
        assert result["maxBound"] > 0.0

    def test_doubling_the_run_does_not_roughly_square_the_bound(self) -> None:
        bounds = []
        for count in (100, 200):
            track = straight_track(count=count, speed=1.2, rate=20.0)
            pose = position_of(track, IntegrationParams(estimate_error=True))
            result = divergence(
                {
                    "estimate": {**track, "x": pose["x"], "y": pose["y"]},
                    "truth": {"t": track["t"], "x": pose["x"], "y": pose["y"]},
                }
            )
            bounds.append(result["maxBound"])
        # Four times the steps must not give anything like the 2**n an exponential model would.
        assert bounds[1] / bounds[0] < 3.0

    def test_a_tighter_stated_uncertainty_gives_a_tighter_bound(self) -> None:
        track = straight_track(count=40, speed=2.0, yaw=0.5)
        pose = position_of(track, IntegrationParams(estimate_error=True))
        channels = {**track, "x": pose["x"], "y": pose["y"]}
        truth = {"t": track["t"], "x": pose["x"], "y": pose["y"]}
        loose = divergence({"estimate": channels, "truth": truth, "params": {"rateSigma": 0.05}})
        tight = divergence({"estimate": channels, "truth": truth, "params": {"rateSigma": 0.0001}})
        assert tight["maxBound"] < loose["maxBound"]

    def test_truncates_the_reported_steps_and_says_so(self) -> None:
        track = straight_track(count=40)
        pose = position_of(track, IntegrationParams(estimate_error=True))
        result = divergence(
            {
                "estimate": {**track, "x": pose["x"], "y": pose["y"]},
                "truth": {"t": track["t"], "x": pose["x"], "y": pose["y"]},
                "params": {"maxSteps": 10},
            }
        )
        assert result["truncated"] is True
        assert result["stepCount"] == 9
        assert any("maxSteps" in issue for issue in result["issues"])

    def test_requires_a_position_track_on_the_estimate(self) -> None:
        with pytest.raises(EngineError) as caught:
            divergence({"estimate": straight_track(), "truth": {"t": [0.0]}})
        assert caught.value.code == "MISSING_FIELD"

    def test_the_shortest_usable_track_reports_exactly_one_step(self) -> None:
        track = straight_track(count=2)
        pose = {"x": [0.0, 1.0], "y": [0.0, 0.0]}
        result = divergence({"estimate": {**track, **pose}, "truth": {**track, **pose}})
        assert result["stepCount"] == 1
        assert len(result["steps"]) == 1

    @settings(max_examples=25, deadline=None)
    @given(
        st.floats(0.0, 5.0, allow_nan=False),
        st.floats(0.1, 2.0, allow_nan=False),
        st.integers(min_value=2, max_value=25),
    )
    def test_a_track_matching_its_reference_never_exceeds_its_bound(
        self, speed: float, rate: float, count: int
    ) -> None:
        track = straight_track(count=count, speed=speed, rate=rate)
        pose = position_of(track, IntegrationParams(estimate_error=True))
        channels = {**track, **pose}
        result = divergence(
            {
                "estimate": channels,
                "truth": {"t": track["t"], "x": pose["x"], "y": pose["y"]},
            }
        )
        assert result["exceeded"] is False

    def test_a_track_without_a_position_cannot_drift_and_is_refused(self) -> None:
        # Drift is a statement about two poses. Without a pose on the estimate there is
        # nothing to compare, and inventing one would be the whole product lying.
        with pytest.raises(EngineError) as caught:
            divergence({"estimate": straight_track(count=5), "truth": straight_track(count=5)})
        assert caught.value.code == "MISSING_FIELD"


class TestAttribute:
    def _payload(self, bias: float) -> dict[str, Any]:
        count = 40
        rate = 20.0
        times = [i / rate for i in range(count)]
        good_v = [1.0] * count
        good_w = [0.0] * count
        bad_v = [1.0 + bias] * count
        return {
            "fused": {"t": times, "v": good_v, "omega": good_w},
            "sensors": {
                "wheel": {"v": good_v, "omega": good_w, "weight": 0.5},
                "imu": {"v": bad_v, "omega": good_w, "weight": 0.5},
            },
            "truth": {"t": times, "x": [t * 1.0 for t in times], "y": [0.0] * count},
        }

    def test_a_consistently_over_reporting_wheel_is_named_primary(self) -> None:
        result = attribute(self._payload(bias=0.4))
        assert result["dominant"] == "imu"
        imu = next(entry for entry in result["sensors"] if entry["sensor"] == "imu")
        assert imu["verdict"] == "primary"
        assert imu["explainedFraction"] > 0.5

    def test_two_perfect_sensors_explain_nothing(self) -> None:
        result = attribute(self._payload(bias=0.0))
        for entry in result["sensors"]:
            assert entry["verdict"] == "negligible"
        assert result["baselineDrift"] == pytest.approx(0.0, abs=1e-9)

    def test_reports_how_far_the_supplied_fusion_is_from_the_sensors(self) -> None:
        result = attribute(self._payload(bias=0.4))
        # The payload declares a fused track at 1.0 while the sensors average 1.2.
        assert result["fusionInconsistency"] == pytest.approx(0.2, abs=1e-12)

    def test_the_under_reporting_wheel_is_named_and_the_accurate_lidar_is_masking(self) -> None:
        # The truth is 2.0 m/s. The wheel reports 1.0 and the lidar 2.0, so the fusion
        # averages 1.5 and under-drives. Removing the wheel leaves only the lidar, which is
        # correct — so the wheel is the liar. Removing the lidar leaves only the wheel,
        # which drifts further — so the lidar was hiding the problem rather than causing it.
        count = 40
        times = [i / 20.0 for i in range(count)]
        result = attribute(
            {
                "fused": {"t": times, "v": [1.0] * count, "omega": [0.0] * count},
                "sensors": {
                    "wheel": {"v": [1.0] * count, "omega": [0.0] * count, "weight": 0.5},
                    "lidar": {"v": [2.0] * count, "omega": [0.0] * count, "weight": 0.5},
                },
                "truth": {"t": times, "x": [2.0 * t for t in times], "y": [0.0] * count},
            }
        )
        wheel = next(entry for entry in result["sensors"] if entry["sensor"] == "wheel")
        lidar = next(entry for entry in result["sensors"] if entry["sensor"] == "lidar")
        assert result["dominant"] == "wheel"
        assert wheel["verdict"] == "primary"
        assert wheel["explainedFraction"] > 0.5
        assert lidar["verdict"] == "masking"
        assert lidar["explainedFraction"] < 0.0

    def test_requires_a_non_empty_sensor_map(self) -> None:
        with pytest.raises(EngineError) as caught:
            attribute({"fused": straight_track(), "truth": {"t": [0.0]}, "sensors": {}})
        assert caught.value.code == "BAD_SHAPE"

    def test_rejects_a_sensor_with_the_wrong_length(self) -> None:
        track = straight_track(count=5)
        with pytest.raises(EngineError) as caught:
            attribute(
                {
                    "fused": track,
                    "truth": {"t": track["t"], "x": track["t"], "y": [0.0] * 5},
                    "sensors": {"wheel": {"v": [1.0], "omega": [0.0], "weight": 1.0}},
                }
            )
        assert caught.value.code == "LENGTH_MISMATCH"

    def test_requires_the_reference_to_carry_a_position(self) -> None:
        track = straight_track(count=5)
        with pytest.raises(EngineError) as caught:
            attribute(
                {
                    "fused": track,
                    "truth": {"t": track["t"]},
                    "sensors": {"wheel": {"v": track["v"], "omega": track["omega"], "weight": 1.0}},
                }
            )
        assert caught.value.code == "MISSING_FIELD"

    def test_a_sole_weighted_sensor_is_called_out_rather_than_divided_by_zero(self) -> None:
        track = straight_track(count=10)
        result = attribute(
            {
                "fused": track,
                "truth": {"t": track["t"], "x": track["t"], "y": [0.0] * 10},
                "sensors": {"wheel": {"v": track["v"], "omega": track["omega"], "weight": 1.0}},
            }
        )
        assert result["sensors"][0]["verdict"] == "sole-source"


class TestClassify:
    def _envelope(self, **overrides: Any) -> dict[str, Any]:
        base = {
            "maxObserved": 0.5,
            "maxBound": 1.0,
            "firstExceedance": None,
            "exceeded": False,
        }
        base.update(overrides)
        return base

    def test_a_ratio_at_or_below_one_is_ok_and_certified(self) -> None:
        result = classify({"envelope": self._envelope()})
        assert result["severity"] == "ok"
        assert result["confidence"] == "certified"
        assert result["withinEnvelope"] is True

    def test_a_small_exceedance_is_a_watch(self) -> None:
        result = classify(
            {"envelope": self._envelope(maxObserved=1.5, maxBound=1.0, firstExceedance=7)}
        )
        assert result["severity"] == "watch"
        assert result["confidence"] == "unbounded"
        assert result["firstExceedanceStep"] == 7

    def test_a_large_exceedance_is_drifting(self) -> None:
        result = classify(
            {"envelope": self._envelope(maxObserved=5.0, maxBound=1.0, firstExceedance=3)}
        )
        assert result["severity"] == "drifting"

    def test_never_reports_certified_once_the_bound_is_escaped(self) -> None:
        result = classify(
            {
                "envelope": self._envelope(maxObserved=0.99, maxBound=1.0, firstExceedance=2),
                "attribution": {"dominant": "imu"},
            }
        )
        assert result["confidence"] == "unbounded"
        assert result["dominantSensor"] == "imu"
        assert "sensor 'imu'" in result["summary"]

    def test_a_zero_bound_does_not_divide_by_zero(self) -> None:
        result = classify({"envelope": self._envelope(maxObserved=0.0, maxBound=0.0)})
        assert result["boundRatio"] == 0.0

    def test_requires_an_envelope(self) -> None:
        with pytest.raises(EngineError) as caught:
            classify({"envelope": None})
        assert caught.value.code == "BAD_SHAPE"


class TestSummarize:
    def test_reports_the_operators_numbers(self) -> None:
        track = straight_track(count=20, speed=2.0, rate=10.0)
        result = summarize({"channels": {**track, "x": [t * 2.0 for t in track["t"]], "y": [0.0] * 20}})
        assert result["count"] == 20
        assert result["durationS"] == pytest.approx(1.9)
        assert result["rateHz"] == pytest.approx(19 / 1.9)
        assert result["meanSpeed"] == pytest.approx(2.0)

    def test_a_rates_only_track_is_reported_without_a_path(self) -> None:
        result = summarize({"channels": straight_track(count=5)})
        assert result["pathLength"] == 0.0
        assert "no position columns" in result["issues"][0]

    def test_max_yaw_rate_is_a_magnitude(self) -> None:
        track = straight_track(count=5, yaw=-0.4)
        assert summarize({"channels": track})["maxYawRate"] == pytest.approx(0.4)

    def test_rejects_a_non_numeric_column(self) -> None:
        with pytest.raises(EngineError) as caught:
            summarize({"channels": {"t": [0.0, "fast"]}})
        assert caught.value.code == "BAD_SHAPE"


class TestDispatch:
    def test_every_advertised_operation_is_callable(self) -> None:
        for name in OPERATIONS:
            assert callable(OPERATIONS[name])

    def test_an_unknown_operation_names_the_available_ones(self) -> None:
        with pytest.raises(EngineError) as caught:
            analyse("nope", None)
        assert caught.value.code == "UNKNOWN_OP"
        assert "divergence" in caught.value.message


class TestGoldenFile:
    """Anti-drift: a known input must keep producing a known output.

    If the integrator, the envelope, or the attribution changes by even a small amount, this
    test fails and the change has to be argued for rather than discovered later in the field.
    """

    def test_divergence_matches_the_committed_golden_output(self) -> None:
        track = straight_track(count=30, speed=1.2, rate=20.0, yaw=0.15)
        pose = position_of(track, IntegrationParams(estimate_error=True))
        drifted_x = [value + 0.02 * i for i, value in enumerate(pose["x"])]
        result = divergence(
            {
                "estimate": {**track, "x": drifted_x, "y": pose["y"], "theta": pose["theta"]},
                "truth": {"t": track["t"], "x": pose["x"], "y": pose["y"], "theta": pose["theta"]},
                "params": {"rateSigma": 0.005, "rateSigmaOmega": 0.002},
            }
        )
        golden = json.loads((GOLDEN_DIR / "divergence.json").read_text(encoding="utf-8"))
        assert result["stepCount"] == golden["stepCount"]
        assert result["exceeded"] == golden["exceeded"]
        assert result["firstExceedance"] == golden["firstExceedance"]
        assert result["maxObserved"] == pytest.approx(golden["maxObserved"], abs=1e-12)
        assert result["maxBound"] == pytest.approx(golden["maxBound"], abs=1e-12)
        assert result["boundRatio"] == pytest.approx(golden["boundRatio"], abs=1e-9)
        assert result["rmsObserved"] == pytest.approx(golden["rmsObserved"], abs=1e-12)

    def test_attribute_matches_the_committed_golden_output(self) -> None:
        count = 40
        times = [i / 20.0 for i in range(count)]
        result = attribute(
            {
                "fused": {"t": times, "v": [1.0] * count, "omega": [0.0] * count},
                "sensors": {
                    "wheel": {"v": [1.0] * count, "omega": [0.0] * count, "weight": 0.6},
                    "imu": {"v": [1.12] * count, "omega": [0.0] * count, "weight": 0.4},
                },
                "truth": {"t": times, "x": [1.0 * t for t in times], "y": [0.0] * count},
            }
        )
        golden = json.loads((GOLDEN_DIR / "attribute.json").read_text(encoding="utf-8"))
        assert result["dominant"] == golden["dominant"]
        assert result["baselineDrift"] == pytest.approx(golden["baselineDrift"], abs=1e-12)
        assert result["fusionInconsistency"] == pytest.approx(
            golden["fusionInconsistency"], abs=1e-12
        )
        for entry, expected in zip(result["sensors"], golden["sensors"], strict=True):
            assert entry["sensor"] == expected["sensor"]
            assert entry["verdict"] == expected["verdict"]
            assert entry["driftWithout"] == pytest.approx(expected["driftWithout"], abs=1e-12)
            assert entry["explainedFraction"] == pytest.approx(
                expected["explainedFraction"], abs=1e-9
            )


class TestProperties:
    @settings(max_examples=100, deadline=None)
    @given(st.lists(st.floats(-50.0, 50.0, allow_nan=False), max_size=20))
    def test_unwrap_preserves_the_first_sample(self, angles: list[float]) -> None:
        if angles:
            assert unwrap_angle(angles)[0] == angles[0]

    @settings(max_examples=50, deadline=None)
    @given(
        st.lists(st.floats(-20.0, 20.0, allow_nan=False, width=32), min_size=2, max_size=20),
    )
    def test_path_length_is_never_negative(self, coords: list[float]) -> None:
        assert path_length(coords, list(reversed(coords))) >= 0.0

    @settings(max_examples=40, deadline=None)
    @given(st.floats(0.0, 3.0, allow_nan=False), st.integers(min_value=2, max_value=20))
    def test_driving_straight_never_reverses_in_x(self, speed: float, count: int) -> None:
        # Only valid with a fixed heading: a turning robot may legitimately lose ground in x.
        track = integrate_track(
            [i / 10.0 for i in range(count)],
            [speed] * count,
            [0.0] * count,
            IntegrationParams(substeps=4),
        )
        for i in range(1, len(track.xs)):
            assert track.xs[i] >= track.xs[i - 1] - 1e-9

    @settings(max_examples=200, deadline=None)
    @given(
        st.floats(0.0, 5.0, allow_nan=False, allow_subnormal=True),
        st.integers(min_value=2, max_value=15),
    )
    def test_a_subnormal_rate_never_freezes_the_bound_below_its_drift(
        self, speed: float, count: int
    ) -> None:
        # Regression guard for a real underflow defect. A subnormal speed makes the injected
        # noise square to zero in float64; the bound then stays at exactly 0.0 while the
        # observed drift is the smallest representable float, so the run reports an escape
        # that did not happen. Hypothesis found this with a denormal speed.
        track = straight_track(count=count, speed=speed)
        pose = position_of(track, IntegrationParams(estimate_error=True))
        result = divergence(
            {
                "estimate": {**track, "x": pose["x"], "y": pose["y"]},
                "truth": {"t": track["t"], "x": pose["x"], "y": pose["y"]},
                "params": {"rateSigma": 0.01, "rateSigmaOmega": 0.005},
            }
        )
        if result["maxObserved"] > 0.0:
            assert result["maxBound"] > 0.0

    def test_a_denormal_speed_does_not_report_a_false_escape(self) -> None:
        # The concrete case Hypothesis found, kept as a named regression.
        track = straight_track(count=3, speed=2.225073858507203e-309, rate=1.75)
        pose = position_of(track, IntegrationParams(estimate_error=True))
        result = divergence(
            {
                "estimate": {**track, "x": pose["x"], "y": pose["y"]},
                "truth": {"t": track["t"], "x": pose["x"], "y": pose["y"]},
                "params": {"rateSigma": 0.01, "rateSigmaOmega": 0.005},
            }
        )
        assert result["maxObserved"] == pytest.approx(5e-324, abs=0.0)
        assert result["maxBound"] > 0.0
        assert result["exceeded"] is False

    @settings(max_examples=30, deadline=None)
    @given(st.floats(0.0, 5.0, allow_nan=False), st.integers(min_value=2, max_value=15))
    def test_summarize_never_reports_a_negative_duration(self, speed: float, count: int) -> None:
        result = summarize({"channels": straight_track(count=count, speed=speed)})
        assert result["durationS"] >= 0.0
        assert result["rateHz"] >= 0.0
