#!/usr/bin/env python3
"""Compatibility command for installed preview tooling; use import-jobs.py."""
import runpy
from pathlib import Path

if __name__ == "__main__":
    runpy.run_path(str(Path(__file__).with_name("import-jobs.py")), run_name="__main__")
