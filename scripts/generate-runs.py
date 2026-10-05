#!/usr/bin/env python
"""Generate the sample runs shipped with Odometry Scope.

The scenarios are *synthetic but physical*: a ground-truth manoeuvre is integrated from ideal
rates, then each simulated sensor is given a specific, documented defect (a scale factor, a
bias, a slip event). Every number the product reports about these runs is computed by the
deterministic engine from these files — nothing here is a pre-baked answer.

They are deterministic: running this script twice produces byte-identical output, which is
what lets a test assert the committed fixtures have not drifted.

    python scripts/generate-runs.py
"""

from __future__ import annotations

import json
import math
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "services" / "engine" / "src"))

from odometry_scope.kinematics import (  # noqa: E402
    integrate_track,
    IntegrationParams,
    unwrap_angle,
)

OUT_DIR = ROOT / "apps" / "web" / "data" / "runs"

# Ground truth is integrated at a high substep count so it is converged to well beyond the
# resolution of anything the product reports.
TRUTH_SUBSTEPS = 256
ESTIMATE_SUBSTEPS = 4


def build_profile(count: int, rate_hz: float) -> dict[str, list[float]]:
    """A repeatable manoeuvre: straight, 90 degree left, straight, 90 degree right.

    Built from elementary segments rather than a closed form so the profile is easy to read
    and easy to change.
    """
    dt = 1.0 / rate_hz
    times = [i * dt for i in range(count)]
    quarter = count // 4
    straight = quarter // 2

    velocities: list[float] = []
    omegas: list[float] = []
    for i in range(count):
        if i < straight:
            velocities.append(1.2)
            omegas.append(0.0)
        elif i < straight + quarter:
            velocities.append(0.8)
            omegas.append(0.6)
        elif i < 2 * straight + quarter:
            velocities.append(1.0)
            omegas.append(0.0)
        else:
            velocities.append(0.9)
            omegas.append(-0.5)
    return {"t": times, "v": velocities, "omega": omegas}


def fuse(ideal_v: list[float], ideal_w: list[float], sensors: dict[str, dict[str, Any]]) -> tuple[list[float], list[float]]:
    """Weighted mean of the per-sensor rate estimates — the fusion the product ablates."""
    total = sum(float(spec["weight"]) for spec in sensors.values())
    fused_v: list[float] = []
    fused_w: list[float] = []
    for i in range(len(ideal_v)):
        fused_v.append(
            sum(float(sensors[name]["v"][i]) * float(spec["weight"]) for name, spec in sensors.items())
            / total
        )
        fused_w.append(
            sum(float(sensors[name]["omega"][i]) * float(spec["weight"]) for name, spec in sensors.items())
            / total
        )
    return fused_v, fused_w


def make_scenario(
    *,
    slug: str,
    title: str,
    summary: str,
    rate_hz: float,
    duration_s: float,
    defects: dict[str, tuple[float, float, float]],
    weights: dict[str, float],
    params: dict[str, Any],
    notes: list[str],
) -> dict[str, Any]:
    """Build one run document.

    ``defects`` maps a sensor name to ``(speed_scale, yaw_scale, yaw_bias)``. A sensor with no
    entry is perfect, which is what makes the others identifiable by ablation.
    """
    count = int(round(duration_s * rate_hz)) + 1
    profile = build_profile(count, rate_hz)
    ideal_v, ideal_w = profile["v"], profile["omega"]

    truth = integrate_track(
        profile["t"], ideal_v, ideal_w, IntegrationParams(substeps=TRUTH_SUBSTEPS)
    )

    sensors: dict[str, dict[str, Any]] = {}
    for name, weight in weights.items():
        scale_v, scale_w, bias_w = defects.get(name, (1.0, 1.0, 0.0))
        sensors[name] = {
            "v": [value * scale_v for value in ideal_v],
            "omega": [value * scale_w + bias_w for value in ideal_w],
            "weight": weight,
        }

    fused_v, fused_w = fuse(ideal_v, ideal_w, sensors)
    estimate = integrate_track(
        profile["t"], fused_v, fused_w, IntegrationParams(substeps=ESTIMATE_SUBSTEPS)
    )

    heading = unwrap_angle(truth.thetas)
    return {
        "id": slug,
        "name": title,
        "summary": summary,
        "robot": " differential-drive research platform, 2 driven wheels + IMU + lidar",
        "rateHz": rate_hz,
        "sampleCount": count,
        "durationS": round(profile["t"][-1], 6),
        "pathLength": round(truth.path_length, 6),
        "notes": notes,
        "params": params,
        "estimate": {
            "t": [round(value, 9) for value in profile["t"]],
            "x": [round(value, 9) for value in estimate.xs],
            "y": [round(value, 9) for value in estimate.ys],
            "theta": [round(value, 9) for value in estimate.thetas],
            "v": [round(value, 9) for value in fused_v],
            "omega": [round(value, 9) for value in fused_w],
        },
        "truth": {
            "t": [round(value, 9) for value in profile["t"]],
            "x": [round(value, 9) for value in truth.xs],
            "y": [round(value, 9) for value in truth.ys],
            "theta": [round(value, 9) for value in heading],
        },
        "sensors": {
            name: {
                "v": [round(value, 9) for value in spec["v"]],
                "omega": [round(value, 9) for value in spec["omega"]],
                "weight": spec["weight"],
            }
            for name, spec in sorted(sensors.items())
        },
    }


SCENARIOS: list[dict[str, Any]] = [
    {
        "slug": "wheel-scale-drift",
        "title": "Corridor circuit — 2% wheel over-report",
        "summary": (
            "Wheel encoders over-report distance by 2% and carry a small yaw bias. The pose "
            "estimate is self-consistent with the fusion, so nothing looks wrong until it is "
            "compared against ground truth."
        ),
        "rate_hz": 20.0,
        "duration_s": 24.0,
        "defects": {
            "wheel": (1.02, 1.0, 0.008),
            "imu": (1.004, 1.0, 0.0),
        },
        "weights": {"wheel": 0.5, "imu": 0.2, "lidar": 0.3},
        "params": {"rateSigma": 0.01, "rateSigmaOmega": 0.005},
        "notes": [
            "wheel over-reports distance by 2% and adds +0.008 rad/s of yaw bias",
            "imu over-reports by a smaller 0.4%",
            "lidar is treated as ground-adjacent and is accurate",
            "a systematic bias grows like t while the envelope grows like sqrt(t), so this is "
            "expected to escape the envelope within the first step or two",
        ],
    },
    {
        "slug": "imu-yaw-bias",
        "title": "Loading dock loop — 0.9% IMU speed bias",
        "summary": (
            "Every rate source is nearly right, but the IMU reads 0.9% high. The resulting "
            "drift stays small in metres, so eyeballing the trajectory hides it until the "
            "envelope is computed."
        ),
        "rate_hz": 20.0,
        "duration_s": 18.0,
        "defects": {
            "imu": (1.009, 1.0, 0.0),
            "wheel": (1.0, 1.0, 0.0),
        },
        "weights": {"wheel": 0.45, "imu": 0.35, "lidar": 0.2},
        "params": {"rateSigma": 0.01, "rateSigmaOmega": 0.005},
        "notes": [
            "imu over-reports speed by 0.9% with no yaw error at all",
            "wheel and lidar are both exact, which is what makes the IMU identifiable",
        ],
    },
    {
        "slug": "clean-run",
        "title": "Warehouse aisle — no detectable drift",
        "summary": (
            "A healthy run. Every sensor is inside its stated uncertainty, so drift never "
            "escapes the envelope and the verdict stays certified. This is the case that "
            "proves the tool does not manufacture findings."
        ),
        "rate_hz": 20.0,
        "duration_s": 16.0,
        "defects": {
            "wheel": (1.0003, 1.0, 0.0001),
            "imu": (0.9998, 1.0, 0.0),
        },
        "weights": {"wheel": 0.5, "imu": 0.2, "lidar": 0.3},
        "params": {"rateSigma": 0.01, "rateSigmaOmega": 0.005},
        "notes": [
            "sub-0.1% scale errors only, far inside the stated 1% rate uncertainty",
            "expected verdict: severity ok, confidence certified",
        ],
    },
]


def analyse(document: dict[str, Any]) -> dict[str, Any]:
    """Run the full analysis for one run document and return the RunAnalysis shape.

    The key set here is deliberately identical to what the ``analyze_run`` tool returns from
    the TypeScript side, so the committed analysis and a live CLI run agree field for field.
    ``packages/cli/src/runs.test.ts`` asserts exactly that.
    """
    from odometry_scope.analysis import attribute, classify, divergence, summarize  # noqa: PLC0415

    summary = summarize({"channels": document["estimate"]})
    envelope = divergence(
        {
            "estimate": document["estimate"],
            "truth": document["truth"],
            "params": document.get("params", {}),
        }
    )
    attribution = attribute(
        {
            "fused": document["estimate"],
            "sensors": document["sensors"],
            "truth": document["truth"],
        }
    )
    verdict = classify({"envelope": envelope, "attribution": attribution})

    return {
        "id": document["id"],
        "name": document["name"],
        "summary": document["summary"],
        "sampleCount": summary["count"],
        "durationS": summary["durationS"],
        "rateHz": summary["rateHz"],
        "pathLength": summary["pathLength"],
        "maxObserved": envelope["maxObserved"],
        "maxBound": envelope["maxBound"],
        "boundRatio": envelope["boundRatio"],
        "rmsObserved": envelope["rmsObserved"],
        "maxHeadingError": envelope["maxHeadingError"],
        "firstExceedance": envelope["firstExceedance"],
        "exceeded": envelope["exceeded"],
        "truncated": envelope["truncated"],
        "steps": envelope["steps"],
        "attribution": attribution["sensors"],
        "dominantSensor": attribution["dominant"],
        "baselineDrift": attribution["baselineDrift"],
        "fusionInconsistency": attribution["fusionInconsistency"],
        "notes": document.get("notes", []),
        "verdict": verdict,
    }


def main() -> int:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    for scenario in SCENARIOS:
        document = make_scenario(**scenario)
        stem = OUT_DIR / str(document["id"])
        (stem.parent / f"{document['id']}.json").write_text(
            json.dumps(document, separators=(",", ":"), sort_keys=True) + "\n", encoding="utf-8"
        )
        analysis = analyse(document)
        (stem.parent / f"{document['id']}.analysis.json").write_text(
            json.dumps(analysis, separators=(",", ":"), sort_keys=True) + "\n", encoding="utf-8"
        )
        verdict = analysis["verdict"]
        print(
            f"wrote {document['id']}: {verdict['severity']}/{verdict['confidence']} "
            f"ratio={analysis['boundRatio']:.2f} dominant={analysis['dominantSensor']}"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())