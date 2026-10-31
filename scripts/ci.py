"""Select and run Justup pull-request checks; read when changing CI impact rules."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
from urllib.parse import unquote, urlsplit


ROOT = Path(__file__).resolve().parents[1]
GUIDELINES = {f"Q{n}" for n in range(1, 12)} | {f"T{n}" for n in range(1, 5)}
CHECK = re.compile(r"^\s*-\s*\[([ xX])\]\s*((?:Q|T)\d+)\b.*?—\s*(Applied|N/A):\s*(.*?)\s*$")
MARKDOWN_LINK = re.compile(r"!?\[[^\]]*\]\(([^)]+)\)")
WORK_BRANCH = re.compile(r"^(?:work|hotfix)/[a-z0-9]+(?:-[a-z0-9]+)+$")
RELEASE_BRANCH = re.compile(r"^release/v(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$")


def validate_branch_name(name: str) -> None:
    if not (WORK_BRANCH.fullmatch(name) or RELEASE_BRANCH.fullmatch(name)):
        raise ValueError(
            "Name the branch for the work: work/<semantic-slug>, "
            "hotfix/<semantic-slug>, or release/vX.Y.Z. "
            "Do not use a contributor or agent prefix."
        )


def run(*command: str, capture: bool = False) -> str:
    result = subprocess.run(command, cwd=ROOT, text=True, check=True, capture_output=capture)
    return result.stdout if capture else ""


def validate_pr_body(body: str | None) -> None:
    if not body:
        raise ValueError("Pull request description is empty; complete the repository template.")
    seen: set[str] = set()
    for line in body.splitlines():
        match = CHECK.match(line)
        if not match:
            continue
        checked, guideline, disposition, explanation = match.groups()
        if guideline not in GUIDELINES or guideline in seen:
            raise ValueError(f"Unexpected or repeated checklist item: {guideline}")
        seen.add(guideline)
        if checked.lower() != "x":
            raise ValueError(f"Check {guideline} after giving its explanation.")
        cleaned = explanation.strip().strip("[]").lower()
        without_links = MARKDOWN_LINK.sub("", explanation)
        if not cleaned or cleaned in {
            "explanation or evidence",
            "current behavior documented or specific n/a reason",
            "what was replaced or removed, or specific n/a reason",
            "not needed",
            "not applicable",
            "n/a",
            "yes",
            "done",
        } or "[" in without_links or "]" in without_links:
            raise ValueError(f"Replace the placeholder with a specific {disposition} explanation for {guideline}.")
    missing = GUIDELINES - seen
    if missing:
        raise ValueError("Complete every checklist item: " + ", ".join(sorted(missing)))


def changed_paths(base: str, head: str) -> list[str]:
    if not re.fullmatch(r"[0-9a-f]{40}", base) or not re.fullmatch(r"[0-9a-f]{40}", head):
        raise ValueError("The pull-request event lacks exact Git commit IDs.")
    output = run("git", "diff", "--name-only", "--no-renames", f"{base}...{head}", capture=True)
    paths = sorted(set(output.splitlines()))
    if not paths:
        raise ValueError("The pull request has no changed paths to check.")
    return paths


def classify(path: str) -> str:
    if path in {"README.md", "AGENTS.md", ".github/PULL_REQUEST_TEMPLATE.md", "scripts/README.md", "deploy/frontend/README.md"}:
        return "docs"
    if path.startswith("docs/") and path.endswith(".md"):
        return "docs"
    if path.startswith(".github/ISSUE_TEMPLATE/") and path.endswith(".md"):
        return "docs"
    if path.endswith(".md") and path.startswith(("prototype/", "apps/", "src/", "web/", "server/")):
        return "docs"
    if path.startswith(("deploy/frontend/", "deploy/justup-preview/", "scripts/preview-")) or (path.startswith("scripts/frontend-") and path.endswith(".mjs")):
        return "deployment"
    if path in {"scripts/ci.py", "scripts/test-server.mjs", "scripts/test-deployment.mjs", "scripts/test-python.py", ".gitignore", ".github/CODEOWNERS"} or path.startswith(".github/workflows/"):
        return "tooling"
    if path == "scripts/import-demo-jobs.py" or (path.startswith("scripts/test_") and path.endswith(".py")):
        return "app"
    if path in {"package.json", "package-lock.json", "npm-shrinkwrap.json", "scripts/check-syntax.mjs"}:
        return "app"
    if path.startswith(("prototype/", "tests/browser/", "server/")):
        return "app"
    if path.startswith("playwright.config."):
        return "app"
    return "unknown"


def select(paths: list[str], base_branch: str, full_override: bool) -> tuple[bool, bool, str]:
    kinds = {classify(path) for path in paths}
    full = full_override or "unknown" in kinds or "app" in kinds or "tooling" in kinds or "deployment" in kinds
    blocked_main = base_branch == "main" and bool(kinds & {"app", "deployment", "unknown"})
    if full_override:
        reason = "full-ci label requested every available suite"
    elif "unknown" in kinds:
        reason = "unrecognized path requires the full suite"
    elif "deployment" in kinds:
        reason = "deployment contracts changed; run syntax, edge/server contracts and browser journeys"
    elif "app" in kinds:
        reason = "application or test files require syntax, deployment, server and browser checks"
    elif "tooling" in kinds:
        reason = "CI tooling changed; run every available suite"
    else:
        reason = "guide and template changes need the fast policy and link checks"
    return full, blocked_main, reason


def check_local_links() -> int:
    count = 0
    for document in sorted(ROOT.rglob("*.md")):
        if any(part in {".git", "node_modules"} for part in document.parts):
            continue
        for raw in MARKDOWN_LINK.findall(document.read_text(encoding="utf-8")):
            target = raw.strip().split(" ", 1)[0].strip("<>")
            parsed = urlsplit(target)
            if parsed.scheme or target.startswith(("#", "//")) or not parsed.path:
                continue
            linked = (document.parent / unquote(parsed.path)).resolve()
            if not linked.is_file():
                raise ValueError(f"Broken local link in {document.relative_to(ROOT)}: {raw}")
            count += 1
    return count


def browser_scripts_present() -> bool:
    package = ROOT / "package.json"
    if not package.is_file():
        return False
    scripts = json.loads(package.read_text(encoding="utf-8")).get("scripts", {})
    return "test:syntax" in scripts and "test:browser" in scripts and (ROOT / "package-lock.json").is_file()


def full_script_present() -> bool:
    package = ROOT / "package.json"
    if not package.is_file() or not (ROOT / "package-lock.json").is_file():
        return False
    scripts = json.loads(package.read_text(encoding="utf-8")).get("scripts", {})
    return "test:full" in scripts


def application_present() -> bool:
    return any((ROOT / path).exists() for path in ("prototype", "apps", "src", "web", "server"))


def append_summary(lines: list[str]) -> None:
    target = os.getenv("GITHUB_STEP_SUMMARY")
    if target:
        with open(target, "a", encoding="utf-8") as file:
            file.write("\n".join(lines) + "\n")


def run_pr(event_path: Path) -> None:
    event = json.loads(event_path.read_text(encoding="utf-8"))
    pr = event["pull_request"]
    validate_branch_name(pr["head"]["ref"])
    base_branch = pr["base"]["ref"]
    paths = changed_paths(pr["base"]["sha"], pr["head"]["sha"])
    full_override = any(label.get("name") == "full-ci" for label in pr.get("labels", []))
    full, blocked_main, reason = select(paths, base_branch, full_override)
    summary = ["### CI selection", f"- Target: `{base_branch}`", f"- Reason: {reason}", "- Changed paths:"]
    summary.extend(f"  - `{path}` ({classify(path)})" for path in paths)
    if blocked_main:
        summary.append("- Release gate: runtime changes to `main` are blocked until real preview verification exists.")
    append_summary(summary)
    print("\n".join(summary))

    validate_pr_body(pr.get("body"))
    run("git", "diff", "--check", f"{pr['base']['sha']}...{pr['head']['sha']}")
    links = check_local_links()
    print(f"Checked {links} local Markdown links and all contribution checklist items.")

    if blocked_main:
        raise ValueError("Application or unrecognized changes cannot target main until the real release preview gate exists; target dev.")

    if not full:
        print("Runtime suites skipped: only guides and templates changed.")
        append_summary(["- Runtime suites: skipped; guides and templates only."])
        return

    if not full_script_present():
        raise ValueError("A broad or unrecognized change requires a registered test:full suite; add it or update the reviewed CI impact rules.")

    if not browser_scripts_present():
        if not application_present() and not any(classify(path) in {"app", "unknown"} for path in paths):
            print("Browser suite unavailable: this baseline has no application runner yet; CI tooling checks passed.")
            append_summary(["- Browser suite: unavailable; no application runner exists in this baseline."])
            selftest()
            return
        raise ValueError("The full suite is required, but package.json, package-lock.json or test scripts are missing.")

    selftest()
    run("npm", "ci")
    run(str(ROOT / "node_modules/.bin/playwright"), "install", "--with-deps", "chromium")
    scripts = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))["scripts"]
    for suite in ("syntax", "deployment", "server", "python", "browser"):
        command = f"test:{suite}"
        if command not in scripts:
            raise ValueError(f"Registered full suite is missing {command}")
        started = time.monotonic()
        run("npm", "run", command)
        seconds = time.monotonic() - started
        append_summary([f"- {suite} runner: completed in {seconds:.2f}s; exact files and unavailable-suite reasons are in its log."])
    append_summary(["- Full suite: passed (syntax, deployment/server/Python contracts and locked Playwright browser journeys)."])


def selftest() -> None:
    for name in ("work/neutral-branch-names", "work/fresh-job-workspace-browser-tests", "hotfix/restore-login", "release/v1.2.3"):
        validate_branch_name(name)
    for name in ("codex/product-design", "feature/fresh-job-workspace", "work/agent", "release/v1.2", "release/v01.2.3"):
        try:
            validate_branch_name(name)
        except ValueError:
            pass
        else:
            raise AssertionError(f"Invalid branch name passed validation: {name}")
    assert select(["docs/README.md"], "dev", False)[:2] == (False, False)
    assert select(["prototype/app.js"], "dev", False)[:2] == (True, False)
    assert select(["prototype/app.js"], "main", False)[:2] == (True, True)
    assert select(["mystery/file"], "dev", False)[:2] == (True, False)
    assert select(["scripts/ci.py"], "dev", False)[:2] == (True, False)
    assert classify("scripts/README.md") == "docs"
    assert classify("deploy/frontend/README.md") == "docs"
    assert select(["deploy/frontend/worker.mjs"], "dev", False)[:2] == (True, False)
    assert select(["deploy/frontend/worker.mjs"], "main", False)[:2] == (True, True)
    assert select(["scripts/frontend-smoke.mjs"], "main", False)[:2] == (True, True)
    assert select(["prototype/privacy.html", "prototype/policies.css"], "dev", False)[:2] == (True, False)
    assert select(["prototype/usage.html"], "main", False)[:2] == (True, True)
    assert select(["docs/demo-preview-hosting.md"], "dev", True)[:2] == (True, False)
    assert select(["new-server/runtime.go"], "main", False)[:2] == (True, True)
    assert select([".github/workflows/ci.yml"], "dev", False)[:2] == (True, False)
    assert classify("scripts/unregistered.mjs") == "unknown"
    assert classify("scripts/test-server.mjs") == "tooling"
    assert select(["deploy/justup-preview/limits.test.mjs", "scripts/preview-install.sh"], "dev", False)[:2] == (True, False)
    assert select(["scripts/import-demo-jobs.py", "scripts/test_import_demo_jobs.py"], "dev", False)[:2] == (True, False)
    assert select(["scripts/import-demo-jobs.py"], "main", False)[:2] == (True, True)
    assert select(["server/auth.mjs", "server/auth.test.mjs"], "dev", False)[:2] == (True, False)
    assert select(["server/auth.mjs"], "main", False)[:2] == (True, True)
    browser_pr_paths = [
        ".gitignore", "package.json", "package-lock.json", "playwright.config.mjs",
        "scripts/check-syntax.mjs", "tests/browser/flows.spec.mjs",
    ]
    assert {classify(path) for path in browser_pr_paths} == {"tooling", "app"}
    assert select(browser_pr_paths, "dev", False)[:2] == (True, False)
    body = "\n".join(f"- [x] {guideline} Rule — N/A: no behavior in this guide" for guideline in sorted(GUIDELINES))
    validate_pr_body(body)
    linked = body.replace(
        "Q9 Rule — N/A: no behavior in this guide",
        "Q9 Rule — Applied: dependency decision is in the [workflow issue](https://github.com/colophon-group/justup/issues/18)",
    )
    validate_pr_body(linked)
    try:
        validate_pr_body(body.replace("[x] Q1", "[ ] Q1"))
    except ValueError:
        pass
    else:
        raise AssertionError("An unchecked guideline must fail validation")
    try:
        validate_pr_body(body.replace("N/A: no behavior in this guide", "Applied: [explanation or evidence]", 1))
    except ValueError:
        pass
    else:
        raise AssertionError("A template placeholder must fail validation")
    print("CI selection and checklist self-tests passed.")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    run_command = subparsers.add_parser("run")
    run_command.add_argument("--event", type=Path, required=True)
    subparsers.add_parser("selftest")
    args = parser.parse_args()
    try:
        if args.command == "selftest":
            selftest()
        else:
            run_pr(args.event)
    except (ValueError, KeyError, subprocess.CalledProcessError) as error:
        print(f"CI / decision failed: {error}", file=sys.stderr)
        append_summary([f"- Result: failed — {error}"])
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
