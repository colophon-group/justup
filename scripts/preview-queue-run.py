#!/usr/bin/env python3
"""Exec the fixed queue role with protected JSON, no inherited provider environment.

The operator prepares configuration and the cumulative ledger separately. This
launcher validates their boundary; it never creates, resets or repairs a ledger.
"""
from __future__ import annotations

import importlib.util
import json
import os
from pathlib import Path
import stat

BASE = Path('/srv/justup_preview')
CONFIG_PATH = BASE / 'queue/config/runner.json'
LEDGER_PATH = BASE / 'queue/budget/jev.jsonl'
CONFIG_KEYS = {'dbPath', 'sharedState', 'sourceCommit', 'buildIdentity', 'runnerStatusPath',
               'model', 'jev', 'matching', 'verificationTtlMs'}
MODEL_KEYS = {'enabled', 'isolationVerified', 'cliVersion', 'socketPath', 'attestationPath',
              'toolCatalogSha256', 'companyResearchVerified'}


def validate_configuration(config, manifest):
    if (not isinstance(config, dict) or set(config) - CONFIG_KEYS
            or config.get('dbPath') != str(BASE / 'state/preview.sqlite')
            or config.get('sharedState') is not True
            or config.get('runnerStatusPath') != str(BASE / 'state/runner-status.json')
            or config.get('sourceCommit') != manifest['sourceCommit']
            or config.get('buildIdentity') != manifest['buildIdentity']):
        raise ValueError('Queue configuration differs from the fixed candidate and state boundary.')
    model = config.get('model', {})
    if (not isinstance(model, dict) or set(model) - MODEL_KEYS
            or ('socketPath' in model and model['socketPath'] != str(BASE / 'broker/model.sock'))
            or ('attestationPath' in model and model['attestationPath'] != str(BASE / 'broker/isolation-reviewed.json'))):
        raise ValueError('Queue model access differs from the dedicated broker boundary.')
    if model.get('enabled') is True and (model.get('cliVersion') != '0.143.0'
            or model.get('isolationVerified') is not True or not model.get('socketPath') or not model.get('attestationPath')):
        raise ValueError('Enabled model access requires the pinned reviewed broker.')
    jev = config.get('jev', {})
    if not isinstance(jev, dict):
        raise ValueError('Queue provider configuration is unavailable.')
    if jev.get('enabled') is True:
        budget = jev.get('cumulativeBudget', {})
        if (not isinstance(budget, dict) or budget.get('path') != str(LEDGER_PATH)
                or budget.get('excludedDirectories') != [str(BASE / 'state'), str(BASE / 'state/backups')]):
            raise ValueError('Cumulative ledger must stay outside the database and backups.')
    return config


def validate_ledger(path=LEDGER_PATH):
    path = Path(path)
    parent = path.parent
    if parent.resolve(strict=True) != parent or path.resolve(strict=True) != path:
        raise ValueError('Ledger paths must be canonical and may not be symlinks.')
    for entry, mode, directory in ((parent, 0o700, True), (path, 0o600, False)):
        meta = entry.lstat()
        if (meta.st_uid != os.getuid() or stat.S_IMODE(meta.st_mode) != mode
                or not (stat.S_ISDIR(meta.st_mode) if directory else stat.S_ISREG(meta.st_mode))
                or (not directory and (meta.st_nlink != 1 or not 1 <= meta.st_size <= 4 * 1024 ** 2))):
            raise ValueError('Ledger storage must already be private and queue-owned.')


def child_environment():
    return {'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8', 'TZ': 'UTC', 'HOME': '/nonexistent',
            'TMPDIR': str(BASE / 'queue/work'), 'JUSTUP_DEMO_RUNNER_CONFIG': str(CONFIG_PATH)}


def main():
    try:
        if os.getuid() == 0 or os.umask(0o007) & 0o070:
            raise ValueError('Queue requires a dedicated UID and group-readable state mask.')
        release = (BASE / 'current').resolve(strict=True)
        if release.parent != BASE / 'releases':
            raise ValueError('Queue release is outside the immutable inventory.')
        spec = importlib.util.spec_from_file_location('preview_artifact', Path(__file__).with_name('preview-artifact.py'))
        artifact = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(artifact)
        manifest = artifact.verify_directory(release)
        required = {'runner', 'demo-runner-adapter', 'demo-composition', 'model-broker', 'model-runner',
                    'intent', 'companies', 'matching', 'jev', 'jev-budget'}
        if not {f'app/server/{name}.mjs' for name in required} <= manifest['files'].keys():
            raise ValueError('This release has no complete fixed queue composition.')
        meta = CONFIG_PATH.lstat()
        if (CONFIG_PATH.resolve(strict=True) != CONFIG_PATH or not stat.S_ISREG(meta.st_mode)
                or meta.st_uid != 0 or meta.st_gid != os.getgid() or stat.S_IMODE(meta.st_mode) != 0o640
                or meta.st_nlink != 1 or meta.st_size > 32_768):
            raise ValueError('Queue configuration must be a protected root-owned file.')
        config = validate_configuration(json.loads(CONFIG_PATH.read_text()), manifest)
        if config.get('jev', {}).get('enabled') is True:
            validate_ledger()
        node = str(release / 'runtime/bin/node')
        os.execve(node, [node, str(release / 'app/server/runner.mjs')], child_environment())
    except (ValueError, OSError, KeyError, json.JSONDecodeError):
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
