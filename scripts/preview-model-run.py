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
import re

BASE = Path('/srv/justup_preview')


def validate_configuration(config, release, manifest):
    expected = {'enabled': True, 'cliVersion': '0.143.0',
                'codexPath': str(Path(release) / manifest['codexEntrypoint']),
                'protectedAuthHome': str(BASE / 'model/credentials'),
                'invocationRoot': str(BASE / 'model/invocations'),
                'taskCwd': str(BASE / 'model/task-cwd')}
    if not isinstance(config, dict) or config != expected or config.get('enabled') is not True:
        raise ValueError('Broker configuration differs from the fixed native executable and private paths.')
    return config


def validate_attestation(report):
    expected = {'approved': True, 'cliVersion': '0.143.0', 'model': 'gpt-6-luna',
                'executorBoundary': 'dedicated_uid_broker', 'socketPath': str(BASE / 'broker/model.sock'),
                'deniedPathsVerified': True, 'retentionVerified': True}
    if (not isinstance(report, dict) or any(type(report.get(key)) is not type(value) or report.get(key) != value for key, value in expected.items())
            or not isinstance(report.get('toolCatalogSha256'), str)
            or not re.fullmatch('[a-f0-9]{64}', report['toolCatalogSha256'])):
        raise ValueError('Broker isolation evidence is unavailable or does not match the pinned boundary.')


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
        if 'app/server/model-broker.mjs' not in manifest['files']:
            raise ValueError('This release has no real model broker.')
        config = BASE / 'model/config/broker.json'
        reviewed = BASE / 'model/config/isolation-reviewed.json'
        for path in (config, reviewed):
            if path.is_symlink() or not path.is_file() or path.stat().st_uid != 0 or path.stat().st_mode & 0o022 or path.stat().st_size > 16_384:
                raise ValueError('Broker configuration and isolation evidence must be root-owned and read-only.')
        configured = validate_configuration(json.loads(config.read_text()), release, manifest)
        validate_attestation(json.loads(reviewed.read_text()))
        executable = Path(configured['codexPath'])
        if executable.resolve(strict=True) != executable or executable.stat().st_uid != 0 or executable.stat().st_mode & 0o022:
            raise ValueError('Broker native executable must remain immutable and root-owned.')
        # Python is replaced, so LISTEN_PID remains the PID which Node sees. The
        # child model CLI never inherits fd3; the broker closes extra descriptors.
        environment = {'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8', 'TZ': 'UTC', 'HOME': '/nonexistent',
                       'TMPDIR': str(BASE / 'model/invocations'), 'JUSTUP_MODEL_BROKER_CONFIG': str(config),
                       'LISTEN_PID': str(os.getpid()), 'LISTEN_FDS': '1'}
        os.set_inheritable(3, True)
        node = str(release / 'runtime/bin/node')
        os.execve(node, [node, str(release / 'app/server/model-broker.mjs')], environment)
    except (ValueError, OSError, KeyError, json.JSONDecodeError):
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
