#!/usr/bin/env python
"""Regenerate the golden files consumed by tests/test_analysis.py::TestGoldenFile.

Run this only when a change to the numerics is intentional:

    python services/engine/tests/make_golden.py

Review the diff before committing it. A golden diff is the evidence that the integrator, the
error envelope, or the attribution actually moved.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from odometry_scope.analysis import attribute, divergence  # noqa: E402
from odometry_scope.kinematics import integrate_track, IntegrationParams  # noqa: E402

GOLDEN_DIR = Path(__file__).resolve().parent / "golden"


def straight_track(count: int = 30, speed: float = 1.0, rate: float = 20.0, yaw: float = 0.0):
    dt = 1.0 / rate
    times = [i * dt for i in range(count)]
    return {"t": times, "v": [speed] * count, "omega": [yaw] * count}


def divergence_golden() -> dict[str, object]:
    track = straight_track(count=30, speed=1.2, rate=20.0, yaw=0.15)
    track_ = integrate_track(track["t"], track["v"], track["omega"], IntegrationParams(estimate_error=True))
    drifted_x = [value + 0.02 * i for i, value in enumerate(track_.xs)]
    result = divergence(
        {
            "estimate": {**track, "x": drifted_x, "y": track_.ys, "theta": track_.thetas},
            "truth": {
                "t": track["t"],
                "x": track_.xs,
                "y": track_.ys,
                "theta": track_.thetas,
            },
            "params": {"rateSigma": 0.005, "rateSigmaOmega": 0.002},
        }
    )
    return {
        key: result[key]
        for key in ("stepCount", "exceeded", "firstExceedance", "maxObserved", "maxBound", "boundRatio", "rmsObserved")
    }


def attribute_golden() -> dict[str, object]:
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
    return {
        "baselineDrift": result["baselineDrift"],
        "fusionInconsistency": result["fusionInconsistency"],
        "dominant": result["dominant"],
        "sensors": [
            {
                "sensor": entry["sensor"],
                "verdict": entry["verdict"],
                "driftWithout": entry["driftWithout"],
                "explainedFraction": entry["explainedFraction"],
            }
            for entry in result["sensors"]
        ],
    }


def main() -> int:
    GOLDEN_DIR.mkdir(parents=True, exist_ok=True)
    for name, payload in (("divergence", divergence_golden()), ("attribute", attribute_golden())):
        target = GOLDEN_DIR / f"{name}.json"
        target.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        print(f"wrote {target}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
