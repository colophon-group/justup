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
import pwd
import stat

BASE = Path('/srv/justup_preview')
CONFIG_PATH = BASE / 'queue/config/runner.json'
LEDGER_PATH = BASE / 'queue/budget/jev.jsonl'
CONFIG_KEYS = {'dbPath', 'sharedState', 'runnerStatusPath',
               'model', 'jev', 'matching', 'verificationTtlMs', 'hiringWire', 'sourceCoverage'}
MODEL_KEYS = {'enabled', 'isolationVerified', 'cliVersion', 'socketPath', 'attestationPath',
              'taskProfiles', 'companyResearchVerified'}
BUDGET_RESOURCE = 'https://github.com/colophon-group/justup/issues/49'
BUDGET_IDENTITIES = {'canonical-v1': 'jev-evaluation-budget', 'legacy-v1': 'demo-jev-evaluation-budget'}


def budget_identity(budget):
    if (not isinstance(budget, dict) or set(budget) - {'path', 'excludedDirectories', 'approval', 'identityProfile'}
            or not isinstance(budget.get('identityProfile', 'canonical-v1'), str)
            or budget.get('identityProfile', 'canonical-v1') not in BUDGET_IDENTITIES):
        raise ValueError('Cumulative budget identity profile differs from the reviewed configuration.')
    selected = {'resourceId': BUDGET_RESOURCE, 'resourceSlug': BUDGET_IDENTITIES[budget.get('identityProfile', 'canonical-v1')]}
    approval = budget.get('approval')
    if not isinstance(approval, dict) or any(approval.get(key) != value for key, value in selected.items()):
        raise ValueError('Cumulative budget approval differs from its selected exact identity.')
    return selected


def model_contract():
    spec = importlib.util.spec_from_file_location('preview_model_run', Path(__file__).with_name('preview-model-run.py'))
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


def validate_configuration(config, manifest):
    if (not isinstance(config, dict) or set(config) - CONFIG_KEYS
            or config.get('dbPath') != str(BASE / 'state/preview.sqlite')
            or config.get('sharedState') is not True
            or config.get('runnerStatusPath') != str(BASE / 'state/runner-status.json')):
        raise ValueError('Queue configuration differs from the fixed candidate and state boundary.')
    if 'sourceCoverage' in config:
        source = config['sourceCoverage']
        if (not isinstance(source, dict) or set(source) != {'directory', 'sourceVersion'}
                or source.get('sourceVersion') not in ('jobseek-coverage-v1', 'jobseek-coverage-v2')
                or not isinstance(source.get('directory'), str)):
            raise ValueError('Source coverage must use the reviewed queue-only reader configuration.')
        directory = Path(source['directory'])
        if (not directory.is_absolute() or str(directory) != source['directory'] or '..' in directory.parts
                or directory.is_relative_to(BASE / 'state')):
            raise ValueError('Source coverage requires a canonical path outside shared state and backups.')
        if not {'app/server/source-coverage.mjs', 'app/server/hiring-wire-integration.mjs'} <= manifest.get('files', {}).keys():
            raise ValueError('Source coverage requires the fixed reader in this exact artifact.')
    model = config.get('model', {})
    if (not isinstance(model, dict) or set(model) - MODEL_KEYS
            or ('socketPath' in model and model['socketPath'] != str(BASE / 'broker/model.sock'))
            or ('attestationPath' in model and model['attestationPath'] != str(BASE / 'broker/isolation-reviewed.json'))):
        raise ValueError('Queue model access differs from the dedicated broker boundary.')
    if model.get('enabled') is True and (model.get('cliVersion') != manifest['codexVersion']
            or model.get('isolationVerified') is not True or not model.get('socketPath') or not model.get('attestationPath')):
        raise ValueError('Enabled model access requires the pinned reviewed broker.')
    if model.get('enabled') is True:
        profiles = model_contract().validate_task_profiles(model.get('taskProfiles'))
        if 'company_resolution' in profiles and model.get('companyResearchVerified') is not True:
            raise ValueError('Company web research requires a separately qualified task profile.')
    if 'hiringWire' in config:
        wire = config['hiringWire']
        model_uid = pwd.getpwnam('justup-preview-model').pw_uid if isinstance(wire, dict) and wire.get('enabled') is True else None
        contract = model_contract()
        if contract.validate_wire_configuration(wire, private=False, model_uid=model_uid):
            contract.validate_wire_inventory(manifest)
    jev = config.get('jev', {})
    if not isinstance(jev, dict):
        raise ValueError('Queue provider configuration is unavailable.')
    if jev.get('enabled') is True:
        budget = jev.get('cumulativeBudget', {})
        if (not isinstance(budget, dict) or budget.get('path') != str(LEDGER_PATH)
                or budget.get('excludedDirectories') != [str(BASE / 'state'), str(BASE / 'state/backups')]):
            raise ValueError('Cumulative ledger must stay outside the database and backups.')
        budget_identity(budget)
    return config


def validate_ledger(path=LEDGER_PATH, expected_identity=None):
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
    if expected_identity is not None:
        original = path.lstat()
        with os.fdopen(os.open(path, os.O_RDONLY | os.O_NOFOLLOW), 'rb') as stream:
            opened = os.fstat(stream.fileno())
            if (opened.st_dev, opened.st_ino, opened.st_size) != (original.st_dev, original.st_ino, original.st_size):
                raise ValueError('Ledger identity changed before its read-only header check.')
            first = stream.readline(4097)
        if len(first) > 4096 or not first.endswith(b'\n'):
            raise ValueError('Ledger approval header must be bounded and complete.')
        header = json.loads(first)
        if (not isinstance(header, dict) or type(header.get('schemaVersion')) is not int or header['schemaVersion'] != 1
                or header.get('kind') != 'approval' or any(header.get(key) != value for key, value in expected_identity.items())):
            raise ValueError('Ledger approval header differs from the selected exact budget identity.')


def child_environment(manifest, host_plan):
    return {'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8', 'TZ': 'UTC', 'HOME': '/nonexistent',
            'TMPDIR': str(BASE / 'queue/work'), 'JUSTUP_RUNNER_CONFIG': str(CONFIG_PATH),
            'JUSTUP_SOURCE_COMMIT': manifest['sourceCommit'], 'JUSTUP_BUILD_ID': manifest['buildIdentity'],
            'JUSTUP_HOST_PLAN_SHA256': host_plan}


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
        host_plan = artifact.read_host_plan(BASE)
        required = {'runner', 'runner-adapter', 'composition', 'model-broker', 'model-runner',
                    'intent', 'companies', 'matching', 'jev', 'jev-budget'}
        if not {f'app/server/{name}.mjs' for name in required} <= manifest['files'].keys():
            raise ValueError('This release has no complete fixed queue composition.')
        meta = CONFIG_PATH.lstat()
        if (CONFIG_PATH.resolve(strict=True) != CONFIG_PATH or not stat.S_ISREG(meta.st_mode)
                or meta.st_uid != 0 or meta.st_gid != os.getgid() or stat.S_IMODE(meta.st_mode) != 0o640
                or meta.st_nlink != 1 or meta.st_size > 32_768):
            raise ValueError('Queue configuration must be a protected root-owned file.')
        config = validate_configuration(json.loads(CONFIG_PATH.read_text()), manifest)
        if config.get('hiringWire', {}).get('enabled') is True:
            contract = model_contract()
            contract.validate_wire_attestation(contract.read_wire_attestation(config['hiringWire']['attestationPath']),
                                               config['hiringWire'], manifest, host_plan)
        if config.get('jev', {}).get('enabled') is True:
            validate_ledger(expected_identity=budget_identity(config['jev']['cumulativeBudget']))
        node = str(release / 'runtime/bin/node')
        os.execve(node, [node, str(release / 'app/server/runner.mjs')], child_environment(manifest, host_plan))
    except (ValueError, OSError, KeyError, json.JSONDecodeError):
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
