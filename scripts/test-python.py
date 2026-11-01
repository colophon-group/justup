"""Run available offline Python contracts; read when adding importer/preview tools."""

from pathlib import Path
import sys
import unittest

root = Path.cwd()
scripts = root / "scripts"
tests = sorted(scripts.glob("test_*.py"))
if not tests:
    if (scripts / "import-jobs.py").exists():
        raise SystemExit("Importer implementation exists without test_*.py behavioral contracts; verification cannot be skipped")
    print("Python suite unavailable: this candidate has no scripts/test_*.py contracts or job importer.")
    raise SystemExit(0)
if (scripts / "import-jobs.py").exists() and not (scripts / "test_import_jobs.py").is_file():
    raise SystemExit("Job importer requires scripts/test_import_jobs.py")
print("Python contract files:\n" + "\n".join(str(path.relative_to(root)) for path in tests), flush=True)
suite = unittest.defaultTestLoader.discover(str(scripts), pattern="test_*.py")
if not suite.countTestCases():
    raise SystemExit("Python files contain no discoverable tests")
result = unittest.TextTestRunner(verbosity=2).run(suite)
raise SystemExit(0 if result.wasSuccessful() else 1)
