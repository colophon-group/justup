#!/usr/bin/env python3
"""Exec the reviewed model broker under its own UID using a root-created fd3 socket.

No auth/config is created here. The broker owns its attestation, fixed tool/model
registry, per-invocation trace cleanup and protected auth-refresh checks.
"""
from __future__ import annotations

import importlib.util
import json
import os
from pathlib import Path
import stat

BASE = Path('/srv/justup_preview')
EMPTY_TOOL_CATALOG_SHA256 = '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945'


def validate_configuration(config, release, manifest):
    expected = {'enabled': True, 'cliVersion': manifest['codexVersion'],
                'codexPath': str(Path(release) / manifest['codexEntrypoint']),
                'protectedAuthHome': str(BASE / 'model/credentials'),
                'invocationRoot': str(BASE / 'model/invocations'),
                'taskCwd': str(BASE / 'model/task-cwd')}
    if not isinstance(config, dict) or config != expected or config.get('enabled') is not True:
        raise ValueError('Broker configuration differs from the fixed native executable and private paths.')
    return config


def validate_attestation(report, manifest, host_plan):
    expected = {'approved': True, 'cliVersion': manifest['codexVersion'], 'model': 'gpt-6-luna',
                'executorBoundary': 'dedicated_uid_broker', 'socketPath': str(BASE / 'broker/model.sock'),
                'deniedPathsVerified': True, 'retentionVerified': True,
                'buildIdentity': manifest['buildIdentity'], 'hostPlanSha256': host_plan}
    if (not isinstance(report, dict) or any(type(report.get(key)) is not type(value) or report.get(key) != value for key, value in expected.items())
            or report.get('toolCatalogSha256') != EMPTY_TOOL_CATALOG_SHA256):
        raise ValueError('Broker isolation evidence is unavailable or does not match the pinned boundary.')


def child_environment(manifest, host_plan, process_id):
    return {'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8', 'TZ': 'UTC', 'HOME': '/nonexistent',
            'TMPDIR': str(BASE / 'model/invocations'), 'JUSTUP_MODEL_BROKER_CONFIG': str(BASE / 'model/config/broker.json'),
            'JUSTUP_DEMO_SOURCE_COMMIT': manifest['sourceCommit'], 'JUSTUP_DEMO_BUILD_ID': manifest['buildIdentity'],
            'JUSTUP_DEMO_HOST_PLAN_SHA256': host_plan, 'LISTEN_PID': str(process_id), 'LISTEN_FDS': '1'}


def main():
    try:
        if os.getuid() == 0 or os.environ.get('LISTEN_PID') != str(os.getpid()) or os.environ.get('LISTEN_FDS') != '1':
            raise ValueError('A dedicated UID and exactly one systemd socket are required.')
        if not stat.S_ISSOCK(os.fstat(3).st_mode):
            raise ValueError('The inherited descriptor is not the broker socket.')
        release = (BASE / 'current').resolve(strict=True)
        if release.parent != BASE / 'releases':
            raise ValueError('Broker release is outside the immutable inventory.')
        spec = importlib.util.spec_from_file_location('preview_artifact', Path(__file__).with_name('preview-artifact.py'))
        artifact = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(artifact)
        manifest = artifact.verify_directory(release)
        host_plan = artifact.read_host_plan(BASE)
        if 'app/server/model-broker.mjs' not in manifest['files']:
            raise ValueError('This release has no real model broker.')
        config = BASE / 'model/config/broker.json'
        reviewed = BASE / 'model/config/isolation-reviewed.json'
        for path in (config, reviewed):
            if path.is_symlink() or not path.is_file() or path.stat().st_uid != 0 or path.stat().st_mode & 0o022 or path.stat().st_size > 16_384:
                raise ValueError('Broker configuration and isolation evidence must be root-owned and read-only.')
        configured = validate_configuration(json.loads(config.read_text()), release, manifest)
        validate_attestation(json.loads(reviewed.read_text()), manifest, host_plan)
        executable = Path(configured['codexPath'])
        if executable.resolve(strict=True) != executable or executable.stat().st_uid != 0 or executable.stat().st_mode & 0o022:
            raise ValueError('Broker native executable must remain immutable and root-owned.')
        # Python is replaced, so LISTEN_PID remains the PID which Node sees. The
        # child model CLI never inherits fd3; the broker closes extra descriptors.
        environment = child_environment(manifest, host_plan, os.getpid())
        os.set_inheritable(3, True)
        node = str(release / 'runtime/bin/node')
        os.execve(node, [node, str(release / 'app/server/model-broker.mjs')], environment)
    except (ValueError, OSError, KeyError, json.JSONDecodeError):
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
