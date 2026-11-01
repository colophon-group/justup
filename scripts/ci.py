"""Select and run Justup CI suites; read when changing impact or full-run rules."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import time
from urllib.parse import unquote, urlsplit


ROOT = Path(__file__).resolve().parents[1]
GUIDELINES = {f"Q{n}" for n in range(1, 12)} | {f"T{n}" for n in range(1, 5)}
CHECK = re.compile(r"^\s*-\s*\[([ xX])\]\s*((?:Q|T)\d+)\b.*?—\s*(Applied|N/A):\s*(.*?)\s*$")
MARKDOWN_LINK = re.compile(r"!?\[[^\]]*\]\(([^)]+)\)")
MARKDOWN_HEADER = re.compile(r"\A---\n(.*?)\n---\n", re.DOTALL)
WORK_BRANCH = re.compile(r"^(?:work|hotfix)/[a-z0-9]+(?:-[a-z0-9]+)+$")
RELEASE_BRANCH = re.compile(r"^release/v(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$")
FULL_SUITES = ("typecheck", "build", "web", "deployment", "server", "python", "browser")
IMPACT = {
    "docs": (),
    "web": ("typecheck", "build", "web", "deployment", "browser"),
    "server": ("server", "deployment", "python"),
    "python": ("python", "deployment"),
    "deployment": ("build", "deployment", "server", "python", "browser"),
    "tooling": FULL_SUITES,
    "unknown": FULL_SUITES,
}


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
    if path in {"README.md", "AGENTS.md", ".github/PULL_REQUEST_TEMPLATE.md", "scripts/README.md"} or (path.startswith("deploy/") and path.endswith("/README.md")):
        return "docs"
    if path.startswith("docs/") and path.endswith(".md"):
        return "docs"
    if path.startswith(".github/ISSUE_TEMPLATE/") and path.endswith(".md"):
        return "docs"
    if path.endswith(".md") and path.startswith(("apps/", "src/", "web/", "server/")):
        return "docs"
    if path.startswith(("deploy/", "scripts/preview-")) or (path.startswith("scripts/frontend-") and path.endswith(".mjs")):
        return "deployment"
    if path in {"scripts/ci.py", "scripts/test-server.mjs", "scripts/test-deployment.mjs", "scripts/test-python.py", "scripts/test-web.mjs", ".gitignore", ".github/CODEOWNERS"} or path.startswith(".github/workflows/"):
        return "tooling"
    if path == "scripts/import-jobs.py" or (path.startswith("scripts/test_") and path.endswith(".py")):
        return "python"
    if path in {"package.json", "package-lock.json", "npm-shrinkwrap.json", "vite.config.ts", "tsconfig.json"}:
        return "tooling"
    if path.startswith(("web/", "tests/browser/", "src/public/")):
        return "web"
    if path.startswith("server/"):
        return "server"
    if path.startswith(("vite.config.", "tsconfig")) or path.startswith("playwright.config."):
        return "tooling"
    return "unknown"


def select(paths: list[str], base_branch: str, full_override: bool) -> tuple[tuple[str, ...], bool, str]:
    kinds = {classify(path) for path in paths}
    selected = FULL_SUITES if full_override or base_branch == "main" else tuple(
        suite for suite in FULL_SUITES if any(suite in IMPACT[kind] for kind in kinds)
    )
    blocked_main = base_branch == "main" and bool(kinds - {"docs"})
    if base_branch == "main":
        reason = "release or hotfix target requires every suite"
    elif full_override:
        reason = "full-ci label requested every available suite"
    elif "unknown" in kinds:
        reason = "unrecognized path requires the full suite"
    else:
        reason = "reviewed impact map: " + ", ".join(sorted(kinds))
    return selected, blocked_main, reason


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


def check_guidebook(directory: Path = ROOT / "docs") -> int:
    index = directory / "README.md"
    if not index.is_file():
        raise ValueError("The docs directory needs a README guidebook.")
    linked: set[Path] = set()
    for raw in MARKDOWN_LINK.findall(index.read_text(encoding="utf-8")):
        target = raw.strip().split(" ", 1)[0].strip("<>")
        parsed = urlsplit(target)
        if parsed.scheme or not parsed.path:
            continue
        linked.add((directory / unquote(parsed.path)).resolve())

    guides = sorted(directory.glob("*.md"))
    for guide in guides:
        header = MARKDOWN_HEADER.match(guide.read_text(encoding="utf-8"))
        if not header:
            raise ValueError(f"Guide needs summary and read_when metadata: {guide.name}")
        fields = dict(line.split(":", 1) for line in header.group(1).splitlines() if ":" in line)
        if not all(fields.get(name, "").strip() for name in ("summary", "read_when")):
            raise ValueError(f"Guide needs summary and read_when metadata: {guide.name}")
        if guide != index and guide.resolve() not in linked:
            raise ValueError(f"Link this guide from docs/README.md: {guide.name}")
    return len(guides) - 1


def browser_scripts_present() -> bool:
    package = ROOT / "package.json"
    if not package.is_file():
        return False
    scripts = json.loads(package.read_text(encoding="utf-8")).get("scripts", {})
    return all(name in scripts for name in ("typecheck", "build", "test:web", "test:browser")) and (ROOT / "package-lock.json").is_file()


def full_script_present() -> bool:
    package = ROOT / "package.json"
    if not package.is_file() or not (ROOT / "package-lock.json").is_file():
        return False
    scripts = json.loads(package.read_text(encoding="utf-8")).get("scripts", {})
    return "test:full" in scripts


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
    selected, blocked_main, reason = select(paths, base_branch, full_override)
    summary = ["### CI selection", f"- Target: `{base_branch}`", f"- Reason: {reason}", "- Changed paths:"]
    summary.extend(f"  - `{path}` ({classify(path)})" for path in paths)
    summary.append("- Selected suites: " + (", ".join(selected) if selected else "policy and links only"))
    if blocked_main:
        summary.append("- Release gate: runtime changes to `main` are blocked until real preview verification exists.")
    append_summary(summary)
    print("\n".join(summary))

    validate_pr_body(pr.get("body"))
    if (ROOT / "prototype").exists():
        raise ValueError("Remove the legacy browser directory; only the built web application may remain.")
    run("git", "diff", "--check", f"{pr['base']['sha']}...{pr['head']['sha']}")
    links = check_local_links()
    guides = check_guidebook()
    print(f"Checked {links} local Markdown links, {guides} indexed guides and all contribution checklist items.")

    if not selected:
        print("Runtime suites skipped: only guides and templates changed.")
        append_summary(["- Runtime suites: skipped; guides and templates only."])
        return
    run_suites(selected)
    if blocked_main:
        raise ValueError("Runtime changes to main require the release preview gate, which is not implemented yet; target dev.")


def run_suites(selected: tuple[str, ...]) -> None:
    total_started = time.monotonic()
    if not selected or any(suite not in FULL_SUITES for suite in selected):
        raise ValueError("CI selected an empty or unrecognized runtime suite set.")
    if selected == FULL_SUITES and not full_script_present():
        raise ValueError("A full run requires a registered test:full suite.")
    package = ROOT / "package.json"
    lockfile = ROOT / "package-lock.json"
    if not package.is_file() or not lockfile.is_file():
        raise ValueError("Selected suites require package.json and package-lock.json.")
    scripts = json.loads(package.read_text(encoding="utf-8")).get("scripts", {})
    commands = required_commands(selected, scripts)
    if "browser" in selected and not browser_scripts_present():
        raise ValueError("The browser suite is required but its runner or lockfile is missing.")
    selftest()
    if selected != ("python",):
        started = time.monotonic()
        run("npm", "ci")
        append_summary([f"- Dependency installation: {time.monotonic() - started:.2f}s."])
    if "browser" in selected:
        started = time.monotonic()
        run(str(ROOT / "node_modules/.bin/playwright"), "install", "--with-deps", "chromium")
        append_summary([f"- Browser installation: {time.monotonic() - started:.2f}s."])
    for suite, command in zip(selected, commands):
        started = time.monotonic()
        try:
            run("npm", "run", command)
        except subprocess.CalledProcessError:
            append_summary([f"- {suite}: failed after {time.monotonic() - started:.2f}s."])
            raise
        append_summary([f"- {suite}: passed in {time.monotonic() - started:.2f}s; test files appear in the runner log."])
    append_summary([f"- Selected runtime suites: passed in {time.monotonic() - total_started:.2f}s."])


def required_commands(selected: tuple[str, ...], scripts: dict[str, str]) -> tuple[str, ...]:
    commands = tuple(suite if suite in {"typecheck", "build"} else f"test:{suite}" for suite in selected)
    for command in commands:
        if command not in scripts:
            raise ValueError(f"Selected suite is missing {command}; CI cannot report success.")
    return commands


def run_full() -> None:
    append_summary(["### Full dev suite", "- Source: checked-out dev commit.", "- Selected suites: " + ", ".join(FULL_SUITES)])
    run_suites(FULL_SUITES)


def selftest() -> None:
    assert check_guidebook() > 0
    with tempfile.TemporaryDirectory() as temporary:
        directory = Path(temporary)
        metadata = "---\nsummary: A useful guide.\nread_when: Changing this topic.\n---\n"
        (directory / "README.md").write_text(metadata + "[One](one.md)\n", encoding="utf-8")
        (directory / "one.md").write_text(metadata + "# One\n", encoding="utf-8")
        assert check_guidebook(directory) == 1
        (directory / "README.md").write_text(metadata + "# Index\n", encoding="utf-8")
        try:
            check_guidebook(directory)
        except ValueError as error:
            assert "Link this guide" in str(error)
        else:
            raise AssertionError("An unlisted guide must fail validation")
        (directory / "README.md").write_text(metadata + "[One](one.md)\n", encoding="utf-8")
        (directory / "one.md").write_text("# One\n", encoding="utf-8")
        try:
            check_guidebook(directory)
        except ValueError as error:
            assert "summary and read_when" in str(error)
        else:
            raise AssertionError("A guide without navigation metadata must fail validation")
    for name in ("work/neutral-branch-names", "work/fresh-job-workspace-browser-tests", "hotfix/restore-login", "release/v1.2.3"):
        validate_branch_name(name)
    for name in ("codex/product-design", "feature/fresh-job-workspace", "work/agent", "release/v1.2", "release/v01.2.3"):
        try:
            validate_branch_name(name)
        except ValueError:
            pass
        else:
            raise AssertionError(f"Invalid branch name passed validation: {name}")
    assert select(["docs/README.md"], "dev", False)[:2] == ((), False)
    assert select(["web/src/app/App.tsx"], "dev", False)[:2] == (("typecheck", "build", "web", "deployment", "browser"), False)
    assert select(["web/src/app/App.tsx"], "main", False)[:2] == (FULL_SUITES, True)
    assert select(["mystery/file"], "dev", False)[:2] == (FULL_SUITES, False)
    assert select(["scripts/ci.py"], "dev", False)[:2] == (FULL_SUITES, False)
    assert classify("scripts/README.md") == "docs"
    assert classify("deploy/frontend/README.md") == "docs"
    assert select(["deploy/frontend/worker.mjs"], "dev", False)[:2] == (("build", "deployment", "server", "python", "browser"), False)
    assert select(["deploy/frontend/worker.mjs"], "main", False)[:2] == (FULL_SUITES, True)
    assert select(["scripts/frontend-smoke.mjs"], "main", False)[:2] == (FULL_SUITES, True)
    assert select(["web/public/privacy.html", "web/public/policies.css"], "dev", False)[:2] == (("typecheck", "build", "web", "deployment", "browser"), False)
    assert select(["web/public/usage.html"], "main", False)[:2] == (FULL_SUITES, True)
    assert select(["docs/operations.md"], "dev", True)[:2] == (FULL_SUITES, False)
    assert select(["new-server/runtime.go"], "main", False)[:2] == (FULL_SUITES, True)
    assert select([".github/workflows/ci.yml"], "dev", False)[:2] == (FULL_SUITES, False)
    assert classify("scripts/unregistered.mjs") == "unknown"
    assert classify("scripts/test-server.mjs") == "tooling"
    assert classify("scripts/test-web.mjs") == "tooling"
    assert select(["web/src/api/client.ts", "web/src/app/App.tsx", "web/src/styles/index.css"], "dev", False)[:2] == (("typecheck", "build", "web", "deployment", "browser"), False)
    assert select(["web/src/app/App.tsx"], "main", False)[:2] == (FULL_SUITES, True)
    assert select(["vite.config.ts", "tsconfig.json"], "dev", False)[:2] == (FULL_SUITES, False)
    assert classify("web/README.md") == "docs"
    assert select(["deploy/justup-preview/limits.test.mjs", "scripts/preview-install.sh"], "dev", False)[:2] == (("build", "deployment", "server", "python", "browser"), False)
    assert select(["scripts/import-jobs.py", "scripts/test_import_jobs.py"], "dev", False)[:2] == (("deployment", "python"), False)
    assert select(["scripts/import-jobs.py"], "main", False)[:2] == (FULL_SUITES, True)
    assert select(["server/auth.mjs", "server/auth.test.mjs"], "dev", False)[:2] == (("deployment", "server", "python"), False)
    assert select(["server/auth.mjs"], "main", False)[:2] == (FULL_SUITES, True)
    browser_pr_paths = [
        ".gitignore", "package.json", "package-lock.json", "playwright.config.mjs",
        "vite.config.ts", "tsconfig.json", "tests/browser/flows.spec.mjs",
    ]
    assert {classify(path) for path in browser_pr_paths} == {"tooling", "web"}
    assert select(browser_pr_paths, "dev", False)[:2] == (FULL_SUITES, False)
    assert select(["server/auth.mjs", "web/src/app/App.tsx"], "dev", False)[0] == FULL_SUITES
    assert required_commands(("server",), {"test:server": "node scripts/test-server.mjs"}) == ("test:server",)
    try:
        required_commands(("server",), {})
    except ValueError:
        pass
    else:
        raise AssertionError("An unregistered selected suite must fail CI")
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
    subparsers.add_parser("full")
    args = parser.parse_args()
    try:
        if args.command == "selftest":
            selftest()
        elif args.command == "full":
            run_full()
        else:
            run_pr(args.event)
    except (ValueError, KeyError, subprocess.CalledProcessError) as error:
        print(f"CI / decision failed: {error}", file=sys.stderr)
        append_summary([f"- Result: failed — {error}"])
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
