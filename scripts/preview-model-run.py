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
            if path.is_symlink() or not path.is_file() or path.stat().st_uid != 0 or path.stat().st_mode & 0o022:
                raise ValueError('Broker configuration and isolation evidence must be root-owned and read-only.')
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
