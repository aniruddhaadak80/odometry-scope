"""Deterministic engine for odometry-scope.

The engine is deliberately dependency-free. Every operation is a pure function:
same input, same output, no clock, no network, no randomness. Time and any entropy
must be passed in by the caller.
"""

from .protocol import EngineError, dispatch
from .analysis import OPERATIONS, analyse

__all__ = ["EngineError", "dispatch", "OPERATIONS", "analyse"]
__version__ = "0.1.0"
