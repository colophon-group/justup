#!/usr/bin/env python3
"""Exec the fixed queue role with protected JSON, no inherited provider environment.

The operator prepares configuration and the cumulative ledger separately. This
launcher validates their boundary; it never creates, resets or repairs a ledger.
"""
from __future__ import annotations

import errno
import importlib.util
import fcntl
import json
import os
from pathlib import Path
import pwd
import re
import socket
import stat
import sys

BASE = Path('/srv/justup_preview')
CONFIG_PATH = BASE / 'queue/config/runner.json'
LEDGER_PATH = BASE / 'queue/budget/jev.jsonl'
CONFIG_KEYS = {'dbPath', 'sharedState', 'runnerStatusPath',
               'model', 'jev', 'matching', 'verificationTtlMs', 'hiringWire', 'sourceCoverage', 'emailVerification', 'stripeBilling'}
MODEL_KEYS = {'enabled', 'isolationVerified', 'cliVersion', 'socketPath', 'attestationPath',
              'taskProfiles', 'companyResearchVerified'}
BUDGET_RESOURCE = 'https://github.com/colophon-group/justup/issues/49'
BUDGET_IDENTITIES = {'canonical-v1': 'jev-evaluation-budget', 'legacy-v1': 'demo-jev-evaluation-budget'}
LUNA_UNIT = 'justup-preview-luna-qualification.service'
LUNA_ENTRYPOINT = 'app/server/evals/luna-qualification-cli.mjs'
LUNA_FILES = {LUNA_ENTRYPOINT, 'app/server/evals/luna-qualification.mjs',
              'app/server/evals/luna-qualification-review.mjs', 'app/server/evals/luna-qualification-v1.json'}
JEV_UNIT = 'justup-preview-jev-qualification.service'


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
    if 'stripeBilling' in config:
        artifact = artifact_module()
        artifact.validate_stripe_billing(config['stripeBilling'], role='queue')
        if config['stripeBilling'].get('enabled') is True and not artifact.BILLING_MODULES <= manifest.get('files', {}).keys():
            raise ValueError('Test billing requires its complete fixed runtime graph.')
    if 'emailVerification' in config:
        email = config['emailVerification']
        if not isinstance(email, dict) or (email != {'enabled': False} and (
                set(email) != {'enabled', 'apiKey', 'verificationKey', 'maxDaily', 'maxMonthly'}
                or email.get('enabled') is not True
                or not isinstance(email.get('apiKey'), str) or not 8 <= len(email['apiKey']) <= 512
                or any(ord(char) < 33 or ord(char) > 126 for char in email['apiKey'])
                or not isinstance(email.get('verificationKey'), str) or not 32 <= len(email['verificationKey'].encode()) <= 512
                or any(ord(char) < 32 or ord(char) > 126 for char in email['verificationKey'])
                or type(email.get('maxDaily')) is not int or not 1 <= email['maxDaily'] <= 10
                or type(email.get('maxMonthly')) is not int or not 1 <= email['maxMonthly'] <= 100)):
            raise ValueError('Email verification requires exact bounded queue-only configuration.')
        if email.get('enabled') is True and not {'app/server/email-verification.mjs', 'app/server/account-provider-clients.mjs'} <= manifest.get('files', {}).keys():
            raise ValueError('Email verification requires its fixed runtime graph.')
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
    if not isinstance(jev, dict) or type(jev.get('qualificationOnly', False)) is not bool:
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


def artifact_module():
    spec = importlib.util.spec_from_file_location('preview_artifact', Path(__file__).with_name('preview-artifact.py'))
    artifact = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(artifact)
    return artifact


def protected_qualification(cgroup, status, unit=LUNA_UNIT):
    relative = next((line[3:] for line in cgroup.splitlines() if line.startswith('0::')), '')
    parts = Path(relative).parts
    return (len(parts) >= 3 and parts[-2:] == ('justup-preview.slice', unit)
            and re.search(r'^NoNewPrivs:\s+1$', status, re.MULTILINE) is not None
            and re.search(r'^CapEff:\s+0+$', status, re.MULTILINE) is not None)


def verify_qualification_access():
    directories = ('state', 'config', 'model', 'logs', 'queue/config', 'queue/budget', 'queue/work',
                   'queue/source-coverage-v1', 'queue/source-coverage-v2', 'queue/qualification/receipts')
    for path in directories:
        if os.access(BASE / path, os.R_OK) or os.access(BASE / path, os.X_OK):
            raise ValueError('Luna qualification can reach a private runtime directory.')
    for family in (socket.AF_INET, socket.AF_INET6):
        try:
            with socket.socket(family, socket.SOCK_STREAM):
                pass
        except OSError as error:
            if error.errno not in (errno.EAFNOSUPPORT, errno.EACCES, errno.EPERM):
                raise
        else:
            raise ValueError('Luna qualification can open an Internet socket.')


def qualification_environment(manifest, host_plan):
    if (pwd.getpwuid(os.getuid()).pw_name != 'justup-preview-runner'
            or not protected_qualification(Path('/proc/self/cgroup').read_text(), Path('/proc/self/status').read_text())):
        raise ValueError('Luna qualification requires its fixed hardened transient service.')
    grant = os.environ.get('JUSTUP_LUNA_GRANT_SHA256', '')
    if not re.fullmatch(r'[a-f0-9]{64}', grant) or not LUNA_FILES <= manifest['files'].keys():
        raise ValueError('The qualified sandbox requires its exact approved grant and fixed case graph.')
    verify_qualification_access()
    return {'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8', 'TZ': 'UTC', 'HOME': '/nonexistent',
            'JUSTUP_LUNA_GRANT_SHA256': grant,
            'JUSTUP_SOURCE_COMMIT': manifest['sourceCommit'], 'JUSTUP_BUILD_ID': manifest['buildIdentity'],
            'JUSTUP_HOST_PLAN_SHA256': host_plan}


def jev_qualification_environment(manifest, host_plan, artifact):
    if (pwd.getpwuid(os.getuid()).pw_name != 'justup-preview-runner'
            or not protected_qualification(Path('/proc/self/cgroup').read_text(),
                                           Path('/proc/self/status').read_text(), JEV_UNIT)):
        raise ValueError('JEV qualification requires its fixed hardened transient service.')
    expected = ('JUSTUP_JEV_REVIEWED_BUILD', 'JUSTUP_JEV_REVIEWED_PLAN', 'JUSTUP_JEV_REVIEWED_FIXTURE')
    fixture = manifest['files'].get('app/server/evals/matching-cases-v1.json')
    if (tuple(os.environ.get(key) for key in expected) != (manifest['buildIdentity'], host_plan, fixture)
            or not artifact.JEV_QUALIFICATION_FILES <= manifest['files'].keys()):
        raise ValueError('JEV qualification differs from the reviewed build, host plan or cases.')
    return {**child_environment(manifest, host_plan), 'JUSTUP_RUN_JEV_QUALIFICATION': 'true'}


def acquire_broker_lock():
    # Both queue roles keep this lock across exec. The root-owned socket parent
    # has a stable inode, and neither role can replace it.
    directory = BASE / 'broker'
    fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        meta = os.fstat(fd)
        if meta.st_uid != 0 or stat.S_IMODE(meta.st_mode) != 0o750:
            raise ValueError('The model broker directory must remain root controlled.')
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        return fd
    except BaseException:
        os.close(fd)
        raise


def execute_release(release, entrypoint, environment):
    node = str(release / 'runtime/bin/node')
    lock = acquire_broker_lock()
    try:
        os.set_inheritable(lock, True)
        os.execve(node, [node, str(release / entrypoint)], environment)
    finally:
        os.close(lock)


def validate_jev_operation(jev, qualification):
    if qualification != jev.get('qualificationOnly', False) or (qualification and jev.get('enabled') is not True):
        raise ValueError('The protected JEV configuration does not authorize this queue operation.')
    if jev.get('enabled') is True:
        validate_ledger(expected_identity=budget_identity(jev['cumulativeBudget']))


def main():
    try:
        qualification = sys.argv[1:] == ['--qualify-model']
        jev_qualification = sys.argv[1:] == ['--qualify-jev']
        if sys.argv[1:] and not (qualification or jev_qualification):
            raise ValueError('Unsupported queue launcher operation.')
        if os.getuid() == 0:
            raise ValueError('Queue requires a dedicated UID and group-readable state mask.')
        prior_mask = os.umask(0o077 if qualification else 0o007)
        if (prior_mask != 0o077 if qualification else bool(prior_mask & 0o070)):
            raise ValueError('Queue role started with the wrong state mask.')
        release = (BASE / 'current').resolve(strict=True)
        if release.parent != BASE / 'releases':
            raise ValueError('Queue release is outside the immutable inventory.')
        artifact = artifact_module()
        manifest = artifact.verify_directory(release)
        host_plan = artifact.read_host_plan(BASE)
        if qualification:
            return execute_release(release, LUNA_ENTRYPOINT, qualification_environment(manifest, host_plan))
        environment = (jev_qualification_environment(manifest, host_plan, artifact) if jev_qualification
                       else child_environment(manifest, host_plan))
        artifact.check_database_schema(BASE / 'state/preview.sqlite', manifest, allow_missing=not jev_qualification)
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
        validate_jev_operation(config.get('jev', {}), jev_qualification)
        entrypoint = artifact.JEV_QUALIFICATION_ENTRYPOINT if jev_qualification else 'app/server/runner.mjs'
        return execute_release(release, entrypoint, environment)
    except (ValueError, OSError, KeyError, json.JSONDecodeError):
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
