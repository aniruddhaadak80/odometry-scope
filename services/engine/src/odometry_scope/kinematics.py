"""Pure numerics for dead-reckoning a planar pose.

Nothing in this module reads a clock, the filesystem, the network, or a random source. Every
function takes values and returns values. That is what makes the drift bound reported by
``divergence`` *certifiable* rather than merely plausible: the same inputs always produce
bit-identical outputs, so a bound that holds today holds tomorrow.

The model is the planar unicycle in SE(2):

    dx/dt     = v * cos(theta)
    dy/dt     = v * sin(theta)
    dtheta/dt = omega

``v`` and ``omega`` are held constant across each sample interval (zero-order hold), which is
what a real wheel-odometry or gyro stream actually gives you. The state is advanced with RK4,
and the local truncation error of each interval is estimated by step doubling, so the
integrator's own error contributes to the certified bound instead of being ignored.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

# Sub-steps per recorded sample interval. Frozen so a bound is reproducible across runs.
DEFAULT_SUBSTEPS = 4

# Denominator of the RK4 Richardson step-doubling estimate: 2**4 - 1.
RICHARDSON_DENOMINATOR = 15.0

# A series shorter than this cannot support a derivative or an interval.
MIN_SERIES = 2


class SeriesLengthError(ValueError):
    """Raised when a series is too short for the requested operation."""


@dataclass(frozen=True)
class IntegrationParams:
    """Everything that can change an integration result, in one typed argument.

    Passing a frozen dataclass instead of a long parameter list keeps the call sites honest:
    there is no way to accidentally swap two adjacent floats.
    """

    substeps: int = DEFAULT_SUBSTEPS
    x0: float = 0.0
    y0: float = 0.0
    theta0: float = 0.0
    estimate_error: bool = False


@dataclass(frozen=True)
class IntegratedTrack:
    """A dead-reckoned pose series plus the integrator's own error accounting."""

    xs: list[float]
    ys: list[float]
    thetas: list[float]
    path_length: float
    max_local_error: float


def unwrap_angle(thetas: list[float]) -> list[float]:
    """Map a wrapped angle series onto a continuous one.

    A recorded heading usually arrives wrapped into [-pi, pi]. Integrating a wrapped series
    directly produces teleports of 2*pi, which would dominate every downstream drift figure,
    so the series is unwrapped before anything else touches it.
    """
    if not thetas:
        return []
    out = [thetas[0]]
    for value in thetas[1:]:
        previous = out[-1]
        delta = value - previous
        while delta > math.pi:
            delta -= 2.0 * math.pi
        while delta < -math.pi:
            delta += 2.0 * math.pi
        out.append(previous + delta)
    return out


def derivative_series(times: list[float], values: list[float]) -> list[float]:
    """Central-difference derivative, falling back to one-sided differences at the ends."""
    n = len(values)
    if n < MIN_SERIES:
        raise SeriesLengthError(f"need at least {MIN_SERIES} samples, got {n}")
    if len(times) != n:
        raise SeriesLengthError(f"times has {len(times)} entries but values has {n}")

    out = [0.0] * n
    out[0] = _slope(times[0], times[1], values[0], values[1])
    out[-1] = _slope(times[-2], times[-1], values[-2], values[-1])
    for i in range(1, n - 1):
        out[i] = _slope(times[i - 1], times[i + 1], values[i - 1], values[i + 1])
    return out


def _slope(t_before: float, t_after: float, v_before: float, v_after: float) -> float:
    span = t_after - t_before
    if span <= 0.0:
        return 0.0
    return (v_after - v_before) / span


def speed_series(times: list[float], xs: list[float], ys: list[float]) -> list[float]:
    """Planar speed derived from a position series."""
    distances = [0.0]
    for i in range(1, len(xs)):
        distances.append(math.hypot(xs[i] - xs[i - 1], ys[i] - ys[i - 1]))
    return derivative_series(times, distances)


def _derivative(state: tuple[float, float, float], control: tuple[float, float]) -> tuple[
    float, float, float
]:
    v, omega = control
    _, _, theta = state
    return (v * math.cos(theta), v * math.sin(theta), omega)


def rk4_step(state: tuple[float, float, float], control: tuple[float, float], h: float) -> tuple[
    float, float, float
]:
    """One classical RK4 step of the unicycle model over a zero-order-hold control."""
    k1 = _derivative(state, control)
    k2 = _derivative((state[0] + h * k1[0] / 2.0, state[1] + h * k1[1] / 2.0, state[2] + h * k1[2] / 2.0), control)
    k3 = _derivative((state[0] + h * k2[0] / 2.0, state[1] + h * k2[1] / 2.0, state[2] + h * k2[2] / 2.0), control)
    k4 = _derivative((state[0] + h * k3[0], state[1] + h * k3[1], state[2] + h * k3[2]), control)

    scale = h / 6.0
    return (
        state[0] + scale * (k1[0] + 2.0 * k2[0] + 2.0 * k3[0] + k4[0]),
        state[1] + scale * (k1[1] + 2.0 * k2[1] + 2.0 * k3[1] + k4[1]),
        state[2] + scale * (k1[2] + 2.0 * k2[2] + 2.0 * k3[2] + k4[2]),
    )


def integrate_track(
    times: list[float],
    velocities: list[float],
    omegas: list[float],
    params: IntegrationParams,
) -> IntegratedTrack:
    """Dead-reckon a pose series from a body-frame rate series.

    The first sample is the initial condition supplied by ``params``; each subsequent sample
    is reached by advancing the model across the interval that precedes it.
    """
    n = len(times)
    if n == 0:
        return IntegratedTrack([], [], [], 0.0, 0.0)
    if len(velocities) != n or len(omegas) != n:
        raise SeriesLengthError(
            f"times has {n} entries but velocities/omegas have "
            f"{len(velocities)}/{len(omegas)}"
        )
    if params.substeps < 1:
        raise ValueError(f"substeps must be >= 1, got {params.substeps}")

    xs = [params.x0]
    ys = [params.y0]
    thetas = [params.theta0]
    state = (params.x0, params.y0, params.theta0)
    max_local_error = 0.0

    for i in range(1, n):
        span = times[i] - times[i - 1]
        control = (velocities[i - 1], omegas[i - 1])
        h = span / params.substeps
        for _ in range(params.substeps):
            state = rk4_step(state, control, h)
        if params.estimate_error:
            # Step doubling: one step of h against two of h/2. The disagreement divided by
            # 2**4 - 1 estimates the local truncation error of the single-step result.
            coarse = rk4_step(state, control, h)
            fine = rk4_step(rk4_step(state, control, h / 2.0), control, h / 2.0)
            local = max(
                abs(fine[0] - coarse[0]), abs(fine[1] - coarse[1]), abs(fine[2] - coarse[2])
            ) / RICHARDSON_DENOMINATOR
            max_local_error = max(max_local_error, local)
        xs.append(state[0])
        ys.append(state[1])
        thetas.append(state[2])

    return IntegratedTrack(xs, ys, thetas, path_length(xs, ys), max_local_error)


def path_length(xs: list[float], ys: list[float]) -> float:
    total = 0.0
    for i in range(1, len(xs)):
        total += math.hypot(xs[i] - xs[i - 1], ys[i] - ys[i - 1])
    return total


def interpolate(times: list[float], values: list[float], targets: list[float]) -> list[float]:
    """Linearly resample ``values`` onto ``targets``.

    Used to put a reference track onto an estimate's own time base so the two can be compared
    step by step. Outside the source range the nearest endpoint is *held* rather than
    extrapolated: inventing pose beyond the recorded window would show up downstream as
    apparent drift that no sensor actually produced.
    """
    if len(times) != len(values):
        raise SeriesLengthError(f"times has {len(times)} entries but values has {len(values)}")
    if not times:
        return [0.0] * len(targets)

    out: list[float] = []
    cursor = 0
    for target in targets:
        if target <= times[0]:
            out.append(values[0])
            continue
        if target >= times[-1]:
            out.append(values[-1])
            continue
        while cursor + 2 < len(times) and times[cursor + 1] < target:
            cursor += 1
        t0 = times[cursor]
        t1 = times[cursor + 1]
        v0 = values[cursor]
        v1 = values[cursor + 1]
        if t1 == t0:
            out.append(v0)
            continue
        out.append(v0 + (v1 - v0) * (target - t0) / (t1 - t0))
    return out


def wrap_to_pi(angle: float) -> float:
    """Fold an angle into [-pi, pi]."""
    folded = math.fmod(angle + math.pi, 2.0 * math.pi)
    if folded < 0.0:
        folded += 2.0 * math.pi
    return folded - math.pi
