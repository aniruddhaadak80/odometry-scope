"""The deterministic operations.

These are the parts of Odometry Scope that must never be a model call. Each function is pure:
it reads its arguments, it returns a value, and it touches nothing else — no clock, no network,
no filesystem, no randomness.

The product question these answer is *which sensor lied*. Given a fused pose estimate and a
reference track, the engine:

  normalize   canonicalises a recorded sample log into typed channels
  integrate   dead-reckons a pose series from a rate series (RK4 + step doubling)
  divergence  reports observed drift against a propagated, certified error envelope
  attribute   ablates one sensor's contribution and reports how much drift it explained
  classify    turns an envelope plus an attribution into a bounded verdict
  summarize   aggregates a run into the few numbers an operator actually reads

``divergence`` is the load-bearing one. It does not merely *report* drift: when asked to be
strict it raises ``BOUND_VIOLATION`` rather than return a confidence the numerics did not
earn. A tool that always answers "probably fine" is worthless for finding a lying IMU.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any, Final, TypedDict

from .kinematics import (
    IntegratedTrack,
    IntegrationParams,
    SeriesLengthError,
    derivative_series,
    integrate_track,
    interpolate,
    speed_series,
    unwrap_angle,
    wrap_to_pi,
)
from .protocol import EngineError

# Recording is noisy at the percent level even on good hardware; this is the default 1-sigma
# rate uncertainty used when the caller does not state one.
DEFAULT_RATE_SIGMA: Final[float] = 0.01
DEFAULT_RATE_SIGMA_OMEGA: Final[float] = 0.005

# Guard rails so a malformed log cannot make the engine allocate without bound.
MAX_SERIES: Final[int] = 200_000
MAX_REPORTED_STEPS: Final[int] = 4_096

# Smallest value whose square survives float64. Squaring anything below this underflows to
# zero, which would let the envelope freeze while observed drift kept growing. sqrt of the
# smallest subnormal, so it is used directly as a step-noise magnitude.
TINY_SQUARED: Final[float] = 1.4916681462400413e-154

# Thresholds for the bounded verdict. Named so the classification is auditable, not magic.
PRIMARY_EXPLANED: Final[float] = 0.5
CONTRIBUTING_EXPLANED: Final[float] = 0.1
MASKING_EXPLANED: Final[float] = -0.1
WATCH_BOUND_RATIO: Final[float] = 1.0
DRIFTING_BOUND_RATIO: Final[float] = 2.0

# Aliases accepted by `normalize`, so a log from a real recorder does not need pre-editing.
FIELD_ALIASES: Final[dict[str, str]] = {
    "t": "t",
    "time": "t",
    "stamp": "t",
    "x": "x",
    "px": "x",
    "y": "y",
    "py": "y",
    "theta": "theta",
    "yaw": "theta",
    "heading": "theta",
    "v": "v",
    "speed": "v",
    "linear_velocity": "v",
    "omega": "omega",
    "yaw_rate": "omega",
    "angular_velocity": "omega",
}

CANONICAL_FIELDS: Final[tuple[str, ...]] = ("t", "x", "y", "theta", "v", "omega")


class Channels(TypedDict):
    """A pose/rate series stored as parallel typed columns.

    Columnar rather than one object per sample: every consumer here sweeps a whole channel
    linearly, and packing the columns keeps a 200k-sample track to six contiguous buffers.
    """

    t: list[float]
    x: list[float]
    y: list[float]
    theta: list[float]
    v: list[float]
    omega: list[float]


class EnvelopeStep(TypedDict):
    t: float
    observed: float
    bound: float
    exceeded: bool


class EnvelopeOutput(TypedDict):
    steps: list[EnvelopeStep]
    stepCount: int
    truncated: bool
    maxObserved: float
    maxBound: float
    boundRatio: float
    rmsObserved: float
    terminalObserved: float
    terminalBound: float
    maxHeadingError: float
    firstExceedance: int | None
    exceeded: bool
    issues: list[str]


class AttributionEntry(TypedDict):
    sensor: str
    driftWithout: float
    delta: float
    explainedFraction: float
    verdict: str


class AttributionOutput(TypedDict):
    baselineDrift: float
    maxLocalError: float
    fusionInconsistency: float
    sensors: list[AttributionEntry]
    dominant: str | None


class VerdictOutput(TypedDict):
    severity: str
    confidence: str
    boundRatio: float
    firstExceedanceStep: int | None
    dominantSensor: str | None
    withinEnvelope: bool
    summary: str


# ------------------------------------------------------------------ validation helpers


def _require_mapping(payload: Any, code: str = "BAD_SHAPE") -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise EngineError(code, "expected a JSON object")
    return payload


def _require_series(values: Any, label: str) -> list[float]:
    if not isinstance(values, list):
        raise EngineError("BAD_SHAPE", f"{label} must be an array of numbers")
    if len(values) > MAX_SERIES:
        raise EngineError("SERIES_TOO_LONG", f"{label} has {len(values)} entries, max {MAX_SERIES}")
    out: list[float] = []
    for index, value in enumerate(values):
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise EngineError("BAD_SHAPE", f"{label}[{index}] must be a number")
        number = float(value)
        if math.isnan(number) or math.isinf(number):
            raise EngineError("BAD_SHAPE", f"{label}[{index}] must be finite")
        out.append(number)
    return out


def _require_channels(payload: Any, field: str, required: tuple[str, ...]) -> Channels:
    """Validate a channel block, requiring the named columns and zero-filling the rest."""
    block = payload.get(field)
    if not isinstance(block, dict):
        raise EngineError("BAD_SHAPE", f"{field!r} must be an object of channels")
    collected: dict[str, list[float]] = {}
    for name in CANONICAL_FIELDS:
        raw = block.get(name)
        if raw is None:
            if name in required:
                raise EngineError("MISSING_FIELD", f"{field}.{name} is required")
            collected[name] = []
            continue
        collected[name] = _require_series(raw, f"{field}.{name}")
    lengths = {len(collected[name]) for name in CANONICAL_FIELDS if collected[name]}
    if len(lengths) > 1:
        raise EngineError(
            "LENGTH_MISMATCH",
            f"{field} columns disagree in length: "
            + ", ".join(f"{name}={len(collected[name])}" for name in CANONICAL_FIELDS),
        )
    if not collected["t"]:
        raise EngineError("MISSING_FIELD", f"{field}.t must contain at least one sample")
    return Channels(
        t=collected["t"],
        x=collected["x"],
        y=collected["y"],
        theta=collected["theta"],
        v=collected["v"],
        omega=collected["omega"],
    )


def _params(payload: Any) -> dict[str, Any]:
    block = payload.get("params")
    if block is None:
        return {}
    return _require_mapping(block)


def _float_param(params: dict[str, Any], name: str, default: float) -> float:
    value = params.get(name, default)
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise EngineError("BAD_SHAPE", f"params.{name} must be a number")
    number = float(value)
    if math.isnan(number) or math.isinf(number) or number < 0.0:
        raise EngineError("BAD_SHAPE", f"params.{name} must be a finite, non-negative number")
    return number


def _int_param(params: dict[str, Any], name: str, default: int, minimum: int) -> int:
    value = params.get(name, default)
    if isinstance(value, bool) or not isinstance(value, int):
        raise EngineError("BAD_SHAPE", f"params.{name} must be an integer")
    if value < minimum:
        raise EngineError("BAD_SHAPE", f"params.{name} must be >= {minimum}, got {value}")
    return value


def _bool_param(params: dict[str, Any], name: str, default: bool) -> bool:
    value = params.get(name, default)
    if not isinstance(value, bool):
        raise EngineError("BAD_SHAPE", f"params.{name} must be a boolean")
    return value


# ------------------------------------------------------------------ derived channels


def _complete_channels(channels: Channels, issues: list[str]) -> Channels:
    """Fill any missing rate column by differentiating the pose columns.

    A recorded pose track without a rate track is normal; a rate track without a pose track is
    not usable for this product, and that is reported rather than silently invented.
    """
    times = channels["t"]
    if not channels["v"]:
        if channels["x"] and channels["y"]:
            channels["v"] = speed_series(times, channels["x"], channels["y"])
            issues.append("derived 'v' from the position columns")
        else:
            raise EngineError("MISSING_FIELD", "cannot integrate without 'v' or an (x, y) position pair")
    if not channels["omega"]:
        if channels["theta"]:
            channels["omega"] = derivative_series(times, unwrap_angle(channels["theta"]))
            issues.append("derived 'omega' from the heading column")
        else:
            raise EngineError(
                "MISSING_FIELD", "cannot integrate without 'omega' or a 'theta' heading column"
            )
    channels["theta"] = unwrap_angle(channels["theta"])
    return channels


def _translate_onto(channels: Channels, targets: list[float]) -> tuple[list[float], list[float], list[float]]:
    if not channels["x"] or not channels["y"]:
        raise EngineError("MISSING_FIELD", "a reference track needs 'x' and 'y' columns")
    xs = interpolate(channels["t"], channels["x"], targets)
    ys = interpolate(channels["t"], channels["y"], targets)
    if channels["theta"]:
        thetas = interpolate(channels["t"], unwrap_angle(channels["theta"]), targets)
    else:
        thetas = [0.0] * len(targets)
    return xs, ys, thetas


# ------------------------------------------------------------------ operations


def normalize(payload: Any) -> dict[str, Any]:
    """Canonicalise a recorded sample log into typed, sorted, unwrapped channels.

    Accepts common field aliases (``yaw`` for ``theta``, ``time`` for ``t``) so a log exported
    from a real recorder does not have to be hand-edited first. Output order depends only on
    the input, never on dict iteration order or the clock.
    """
    payload = _require_mapping(payload)
    samples = payload.get("samples")
    if not isinstance(samples, list):
        raise EngineError("BAD_SHAPE", "'samples' must be an array of sample objects")
    if len(samples) > MAX_SERIES:
        raise EngineError("SERIES_TOO_LONG", f"'samples' has {len(samples)} entries, max {MAX_SERIES}")

    issues: list[str] = []
    collected: dict[str, list[float]] = {name: [] for name in CANONICAL_FIELDS}
    seen: set[str] = set()
    for index, sample in enumerate(samples):
        if not isinstance(sample, dict):
            raise EngineError("BAD_SHAPE", f"samples[{index}] must be an object")
        for key, value in sample.items():
            canonical = FIELD_ALIASES.get(key.lower())
            if canonical is None:
                continue
            if isinstance(value, bool) or not isinstance(value, (int, float)):
                raise EngineError("BAD_SHAPE", f"samples[{index}].{key} must be a number")
            number = float(value)
            if math.isnan(number) or math.isinf(number):
                raise EngineError("BAD_SHAPE", f"samples[{index}].{key} must be finite")
            collected[canonical].append(number)
            seen.add(canonical)
        if "t" not in seen and "time" not in seen and "stamp" not in seen:
            raise EngineError("MISSING_FIELD", f"samples[{index}] has no timestamp field")

    if not collected["t"]:
        raise EngineError("MISSING_FIELD", "'samples' contains no timestamped rows")

    order = sorted(range(len(collected["t"])), key=lambda i: collected["t"][i])
    was_reordered = order != list(range(len(order)))
    channels: Channels = {
        "t": [collected["t"][i] for i in order],
        "x": [collected["x"][i] for i in order] if collected["x"] else [],
        "y": [collected["y"][i] for i in order] if collected["y"] else [],
        "theta": [collected["theta"][i] for i in order] if collected["theta"] else [],
        "v": [collected["v"][i] for i in order] if collected["v"] else [],
        "omega": [collected["omega"][i] for i in order] if collected["omega"] else [],
    }

    times = channels["t"]
    rate = 0.0
    if len(times) > 1 and times[-1] > times[0]:
        rate = (len(times) - 1) / (times[-1] - times[0])

    return {
        "channels": channels,
        "count": len(times),
        "durationS": (times[-1] - times[0]) if len(times) > 1 else 0.0,
        "rateHz": rate,
        "presentFields": sorted(seen),
        # `reordered` is reported on its own rather than in `issues`, because it describes how
        # the input arrived, not what the data is. Keeping it out of `issues` is what lets a
        # caller compare two normalizations of the same log in a different order and get an
        # identical result.
        "reordered": was_reordered,
        "issues": issues,
    }


def integrate(payload: Any) -> dict[str, Any]:
    """Dead-reckon a pose series from a rate series with RK4 and step-doubling error control."""
    payload = _require_mapping(payload)
    params = _params(payload)
    channels = _require_channels(payload, "channels", ("t",))
    issues: list[str] = []
    channels = _complete_channels(channels, issues)

    integration = IntegrationParams(
        substeps=_int_param(params, "substeps", 4, 1),
        x0=_float_param(params, "x0", 0.0),
        y0=_float_param(params, "y0", 0.0),
        theta0=_float_param(params, "theta0", 0.0),
        estimate_error=_bool_param(params, "estimateError", True),
    )
    try:
        track = integrate_track(channels["t"], channels["v"], channels["omega"], integration)
    except SeriesLengthError as error:
        raise EngineError("SERIES_TOO_SHORT", str(error)) from error

    return {
        "x": track.xs,
        "y": track.ys,
        "theta": track.thetas,
        "pathLength": track.path_length,
        "maxLocalError": track.max_local_error,
        "substeps": integration.substeps,
        "issues": issues,
    }


@dataclass(frozen=True)
class _EnvelopeSeries:
    """The two pose series being compared, already aligned onto one time base."""

    times: list[float]
    velocities: list[float]
    omegas: list[float]
    xs: list[float]
    ys: list[float]
    thetas: list[float]
    ref_x: list[float]
    ref_y: list[float]
    ref_theta: list[float]


@dataclass(frozen=True)
class _EnvelopeSettings:
    """The stated assumptions the bound is allowed to rely on."""

    reported: int
    rate_sigma: float
    rate_sigma_omega: float
    per_step_error: float


class _Accumulation(TypedDict):
    steps: list[EnvelopeStep]
    maxObserved: float
    maxBound: float
    rmsObserved: float
    maxHeadingError: float
    firstExceedance: int | None


def _accumulate_envelope(series: _EnvelopeSeries, settings: _EnvelopeSettings) -> _Accumulation:
    """Walk the track once, accumulating the propagated bound beside the observation.

    The bound is a running value, not a per-step constant. Each interval injects the stated
    rate uncertainty, amplified by the distance travelled over that interval because a
    heading error rotates the velocity vector and turns angular error into positional error.

    The injected amounts are accumulated as a sum of squares, i.e. the bound grows like the
    square root of the number of steps. That is the right model for *independent* per-step
    sensor noise. It deliberately does **not** model a worst case, where every step errs in
    the same direction at once: that compounds exponentially and produces a bound so wide it
    can never detect anything, which would make the whole product theatre.

    A systematic error — a wheel scale factor, a constant yaw bias — does not average out, so
    it grows roughly linearly and will eventually escape this envelope. That escape is the
    signal, not a defect in the bound.
    """
    steps: list[EnvelopeStep] = []
    bound = 0.0
    max_observed = 0.0
    max_bound = 0.0
    sum_squares = 0.0
    max_heading = 0.0
    first_exceedance: int | None = None

    for i in range(1, settings.reported):
        span = series.times[i] - series.times[i - 1]
        v = series.velocities[i - 1]
        omega = series.omegas[i - 1]
        observed = math.hypot(series.xs[i] - series.ref_x[i], series.ys[i] - series.ref_y[i])
        max_heading = max(max_heading, abs(wrap_to_pi(series.thetas[i] - series.ref_theta[i])))

        injected = (
            math.hypot(settings.rate_sigma * abs(v), settings.rate_sigma_omega * abs(omega))
            * span
            * (1.0 + abs(v) * span)
        )
        # The integrator's own truncation error rides along in the same sum of squares.
        step_noise = math.hypot(injected, settings.per_step_error)

        # Flooring the magnitude keeps it representable: below this value `step_noise ** 2`
        # underflows to zero in float64, which would silently freeze the bound while the
        # observed drift kept growing. A subnormal rate channel reaches here. See
        # docs/adr/0004.
        safe_noise = max(step_noise, TINY_SQUARED)
        bound = math.sqrt(bound * bound + safe_noise * safe_noise)

        exceeded = observed > bound
        if exceeded and first_exceedance is None:
            first_exceedance = i
        max_observed = max(max_observed, observed)
        max_bound = max(max_bound, bound)
        sum_squares += observed * observed
        steps.append({"t": series.times[i], "observed": observed, "bound": bound, "exceeded": exceeded})

    observed_count = max(settings.reported - 1, 0)
    return {
        "steps": steps,
        "maxObserved": max_observed,
        "maxBound": max_bound,
        "rmsObserved": math.sqrt(sum_squares / observed_count) if observed_count else 0.0,
        "maxHeadingError": max_heading,
        "firstExceedance": first_exceedance,
    }


def divergence(payload: Any) -> EnvelopeOutput:
    """Compare an estimate against a reference track inside a propagated error envelope.

    The bound is not a constant confidence band. It is accumulated per step from two
    contributions the caller can state: the assumed 1-sigma uncertainty in the rate channels,
    and the integrator's own local truncation error. A heading error also rotates the velocity
    vector, so position uncertainty is amplified by ``1 + |v| * h`` each step — which is why
    the envelope widens with distance travelled rather than growing linearly with time.

    With ``params.strict`` the function raises ``BOUND_VIOLATION`` the moment an observation
    escapes the bound. That refusal is the product's position: an unbounded drift is a result,
    not an error to be smoothed away.
    """
    payload = _require_mapping(payload)
    params = _params(payload)
    issues: list[str] = []
    estimate = _complete_channels(_require_channels(payload, "estimate", ("t",)), issues)
    reference = _require_channels(payload, "truth", ("t",))
    if not estimate["x"] or not estimate["y"]:
        raise EngineError("MISSING_FIELD", "the estimate track needs 'x' and 'y' columns to drift")

    rate_sigma = _float_param(params, "rateSigma", DEFAULT_RATE_SIGMA)
    rate_sigma_omega = _float_param(params, "rateSigmaOmega", DEFAULT_RATE_SIGMA_OMEGA)
    strict = _bool_param(params, "strict", False)
    max_steps = _int_param(params, "maxSteps", MAX_REPORTED_STEPS, 2)

    ref_x, ref_y, ref_theta = _translate_onto(reference, estimate["t"])
    estimate_theta = estimate["theta"] if estimate["theta"] else [0.0] * len(estimate["t"])

    integration = IntegrationParams(
        substeps=_int_param(params, "substeps", 4, 1),
        estimate_error=True,
    )
    try:
        track: IntegratedTrack = integrate_track(
            estimate["t"], estimate["v"], estimate["omega"], integration
        )
    except SeriesLengthError as error:
        raise EngineError("SERIES_TOO_SHORT", str(error)) from error

    total = len(estimate["t"])
    reported = min(total, max_steps)
    truncated = reported < total
    if truncated:
        issues.append(f"reported the first {reported} of {total} steps; raise params.maxSteps for all")

    run = _accumulate_envelope(
        _EnvelopeSeries(
            times=estimate["t"],
            velocities=estimate["v"],
            omegas=estimate["omega"],
            xs=estimate["x"],
            ys=estimate["y"],
            thetas=estimate_theta,
            ref_x=ref_x,
            ref_y=ref_y,
            ref_theta=ref_theta,
        ),
        _EnvelopeSettings(
            reported=reported,
            rate_sigma=rate_sigma,
            rate_sigma_omega=rate_sigma_omega,
            per_step_error=track.max_local_error / max(total, 1),
        ),
    )

    observed_count = max(reported - 1, 0)
    steps = run["steps"]
    max_observed = run["maxObserved"]
    max_bound = run["maxBound"]
    first_exceedance = run["firstExceedance"]

    if strict and first_exceedance is not None:
        raise EngineError(
            "BOUND_VIOLATION",
            "observed drift escaped the certified envelope at step "
            f"{first_exceedance} (t={estimate['t'][first_exceedance]:.6f}s, "
            f"observed={max_observed:.6f}m, bound={max_bound:.6f}m); "
            "the drift is real and unbounded by the stated sensor assumptions",
        )

    return {
        "steps": steps,
        "stepCount": observed_count,
        "truncated": truncated,
        "maxObserved": max_observed,
        "maxBound": max_bound,
        "boundRatio": (max_observed / max_bound) if max_bound > 0.0 else 0.0,
        "rmsObserved": run["rmsObserved"],
        "terminalObserved": steps[-1]["observed"] if steps else 0.0,
        "terminalBound": steps[-1]["bound"] if steps else 0.0,
        "maxHeadingError": run["maxHeadingError"],
        "firstExceedance": first_exceedance,
        "exceeded": first_exceedance is not None,
        "issues": issues,
    }


def attribute(payload: Any) -> AttributionOutput:
    """Ablate one sensor at a time and report how much drift it explained.

    The fused rate series is treated as a weighted mean of per-sensor estimates. Removing a
    sensor and renormalising the remaining weights gives the estimate the robot would have
    produced without it; re-integrating that and comparing terminal drift against the
    reference says how much of the drift that sensor was responsible for.

    A negative explained fraction is a real and useful outcome: it means the sensor was
    *masking* drift rather than causing it.
    """
    payload = _require_mapping(payload)
    params = _params(payload)
    issues: list[str] = []
    fused = _complete_channels(_require_channels(payload, "fused", ("t",)), issues)
    reference = _require_channels(payload, "truth", ("t",))
    sensors = payload.get("sensors")
    if not isinstance(sensors, dict) or not sensors:
        raise EngineError("BAD_SHAPE", "'sensors' must be a non-empty object of per-sensor rates")

    times = fused["t"]
    ref_x, ref_y, _ = _translate_onto(reference, times)
    integration = IntegrationParams(
        substeps=_int_param(params, "substeps", 4, 1),
        estimate_error=True,
    )

    def drift_of(velocities: list[float], omegas: list[float]) -> float:
        track = integrate_track(times, velocities, omegas, integration)
        return math.hypot(track.xs[-1] - ref_x[-1], track.ys[-1] - ref_y[-1])

    parsed: dict[str, tuple[list[float], list[float], float]] = {}
    for name, block in sensors.items():
        if not isinstance(name, str) or not name:
            raise EngineError("BAD_SHAPE", "sensor names must be non-empty strings")
        sensor = _require_mapping(block, "BAD_SHAPE")
        velocities = _require_series(sensor.get("v"), f"sensors.{name}.v")
        omegas = _require_series(sensor.get("omega"), f"sensors.{name}.omega")
        if len(velocities) != len(times) or len(omegas) != len(times):
            raise EngineError(
                "LENGTH_MISMATCH",
                f"sensors.{name} has {len(velocities)}/{len(omegas)} samples but the fused "
                f"track has {len(times)}",
            )
        weight = _float_param(sensor, "weight", 1.0)
        parsed[name] = (velocities, omegas, weight)

    total_weight = sum(weight for _, _, weight in parsed.values())
    if total_weight <= 0.0:
        raise EngineError("BAD_SHAPE", "the sum of sensor weights must be positive")

    # Derive the fusion the sensors imply, rather than trusting the supplied fused series, so
    # the ablation and the baseline are guaranteed to be consistent with each other.
    derived_v = [
        sum(velocities[i] * weight for velocities, _, weight in parsed.values()) / total_weight
        for i in range(len(times))
    ]
    derived_omega = [
        sum(omegas[i] * weight for _, omegas, weight in parsed.values()) / total_weight
        for i in range(len(times))
    ]
    baseline = drift_of(derived_v, derived_omega)
    speed_gap = max(abs(derived_v[i] - fused["v"][i]) for i in range(len(times)))
    rate_gap = max(abs(derived_omega[i] - fused["omega"][i]) for i in range(len(times)))
    inconsistency = max(speed_gap, rate_gap)

    entries: list[AttributionEntry] = []
    for name in sorted(parsed):
        remaining = {k: value for k, value in parsed.items() if k != name}
        remaining_weight = sum(w for _, _, w in remaining.values())
        if remaining_weight <= 0.0:
            # Ablating the only weighted sensor leaves no estimate at all.
            entries.append(
                {
                    "sensor": name,
                    "driftWithout": baseline,
                    "delta": 0.0,
                    "explainedFraction": 0.0,
                    "verdict": "sole-source",
                }
            )
            continue
        without_v = [
            sum(velocities[i] * w for velocities, _, w in remaining.values()) / remaining_weight
            for i in range(len(times))
        ]
        without_omega = [
            sum(omegas[i] * w for _, omegas, w in remaining.values()) / remaining_weight
            for i in range(len(times))
        ]
        without = drift_of(without_v, without_omega)
        delta = baseline - without
        fraction = (delta / baseline) if baseline > 0.0 else 0.0
        entries.append(
            {
                "sensor": name,
                "driftWithout": without,
                "delta": delta,
                "explainedFraction": fraction,
                "verdict": _attribution_verdict(fraction),
            }
        )

    dominant: str | None = None
    if entries:
        dominant = max(entries, key=lambda entry: entry["explainedFraction"])["sensor"]

    return {
        "baselineDrift": baseline,
        "maxLocalError": 0.0,
        "fusionInconsistency": inconsistency,
        "sensors": entries,
        "dominant": dominant,
    }


def _attribution_verdict(fraction: float) -> str:
    if fraction >= PRIMARY_EXPLANED:
        return "primary"
    if fraction >= CONTRIBUTING_EXPLANED:
        return "contributing"
    if fraction <= MASKING_EXPLANED:
        return "masking"
    return "negligible"


def classify(payload: Any) -> VerdictOutput:
    """Turn an envelope and an attribution into a bounded verdict.

    ``confidence`` is the honest part: while the observation stays inside the envelope the
    verdict is ``certified``; the moment it escapes, there is no bound left and the verdict is
    ``unbounded``. The tool never converts an unbounded result into a confident one.
    """
    payload = _require_mapping(payload)
    envelope = _require_mapping(payload.get("envelope"), "BAD_SHAPE")
    attribution = payload.get("attribution")
    dominant: str | None = None
    if attribution is not None:
        block = _require_mapping(attribution, "BAD_SHAPE")
        name = block.get("dominant")
        dominant = name if isinstance(name, str) and name else None

    max_observed = _series_number(envelope, "maxObserved")
    max_bound = _series_number(envelope, "maxBound")
    first_exceedance = envelope.get("firstExceedance")
    step_index = first_exceedance if isinstance(first_exceedance, int) else None
    ratio = (max_observed / max_bound) if max_bound > 0.0 else 0.0
    within = step_index is None

    if ratio >= DRIFTING_BOUND_RATIO:
        severity = "drifting"
    elif ratio > WATCH_BOUND_RATIO:
        severity = "watch"
    else:
        severity = "ok"

    if within:
        summary = (
            f"drift stayed inside the certified envelope for the whole run "
            f"(peak {max_observed:.3f}m against a {max_bound:.3f}m bound)"
        )
    else:
        summary = (
            f"drift escaped the certified envelope at step {step_index} "
            f"(peak {max_observed:.3f}m against a {max_bound:.3f}m bound, ratio {ratio:.2f})"
        )
    if dominant:
        summary += f"; sensor '{dominant}' explains the most of it"

    return {
        "severity": severity,
        "confidence": "certified" if within else "unbounded",
        "boundRatio": ratio,
        "firstExceedanceStep": step_index,
        "dominantSensor": dominant,
        "withinEnvelope": within,
        "summary": summary,
    }


def _series_number(payload: dict[str, Any], name: str) -> float:
    value = payload.get(name, 0.0)
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise EngineError("BAD_SHAPE", f"envelope.{name} must be a number")
    number = float(value)
    if math.isnan(number) or math.isinf(number):
        raise EngineError("BAD_SHAPE", f"envelope.{name} must be finite")
    return number


def summarize(payload: Any) -> dict[str, Any]:
    """Aggregate a run into the few numbers an operator actually reads."""
    payload = _require_mapping(payload)
    params = _params(payload)
    issues: list[str] = []
    channels = _require_channels(payload, "channels", ("t",))
    if channels["x"] and channels["y"]:
        channels = _complete_channels(channels, issues)
        integration = IntegrationParams(
            substeps=_int_param(params, "substeps", 4, 1), estimate_error=True
        )
        try:
            track = integrate_track(channels["t"], channels["v"], channels["omega"], integration)
        except SeriesLengthError as error:
            raise EngineError("SERIES_TOO_SHORT", str(error)) from error
        path = track.path_length
        terminal = {"x": track.xs[-1], "y": track.ys[-1], "theta": track.thetas[-1]}
        max_local_error = track.max_local_error
    else:
        path = 0.0
        terminal = {"x": 0.0, "y": 0.0, "theta": 0.0}
        max_local_error = 0.0
        issues.append("no position columns; reported rates only")

    times = channels["t"]
    duration = (times[-1] - times[0]) if len(times) > 1 else 0.0
    rate = (len(times) - 1) / duration if duration > 0.0 else 0.0
    speeds = channels["v"] or [0.0]
    omegas = channels["omega"] or [0.0]

    return {
        "count": len(times),
        "durationS": duration,
        "rateHz": rate,
        "pathLength": path,
        "meanSpeed": sum(speeds) / len(speeds),
        "maxSpeed": max(speeds),
        "maxYawRate": max(abs(value) for value in omegas),
        "terminalPose": terminal,
        "maxLocalError": max_local_error,
        "issues": issues,
    }


OPERATIONS: dict[str, Any] = {
    "normalize": normalize,
    "integrate": integrate,
    "divergence": divergence,
    "attribute": attribute,
    "classify": classify,
    "summarize": summarize,
}


def analyse(op: str, payload: Any) -> Any:
    handler = OPERATIONS.get(op)
    if handler is None:
        known = ", ".join(sorted(OPERATIONS))
        raise EngineError("UNKNOWN_OP", f"unknown op {op!r}; available: {known}")
    return handler(payload)
