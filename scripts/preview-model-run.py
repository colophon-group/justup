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
import re
import stat

BASE = Path('/srv/justup_preview')
EMPTY_TOOL_CATALOG_SHA256 = '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945'
MODEL_CATALOGUE_SHA256 = '0829441e0714986d05563eb5885fa7f22324eff3bf2446cc6be857a227c96402'
CODEX_SOURCE_COMMIT = 'ff6aec96948b70d94983af2641a6b67c94faeff5'
TASK_PROFILES = {
    'search_intent': {'toolPolicySha256': 'f9fbda3d5135a678ecfb68f59bf64a52854da040629ea3ce9116ec429b3dedc1', 'toolNames': []},
    'company_resolution': {'toolPolicySha256': 'a073f7fab18af21ef90c16bce81a687159da19cda045b2a6f1d19069e45ea559', 'toolNames': ['web.run']},
}
WIRE_CATALOGUE_SHA256 = '5ed662f51bb5a9eda38e52fae474954574504286a851bfbad4a4aa6d32b4ed61'
WIRE_DYNAMIC_TOOLS_SHA256 = 'f3deb93a0fb67d8bb2861a7d0938e678384b1144964ed3bcd6bcf6cba59f3b56'
WIRE_DESCRIPTOR = {'profile': 'hiring_wire', 'model': 'gpt-6.1-sol', 'promptVersion': 'hiring-wire-editorial-v1',
                   'toolVersion': 'hiring-wire-tools-v1', 'toolSchemaSha256': 'e411813b3c2b73b84fb7871550d22c8c37f28cb4eaa8903c3696f5df08f9b0f4',
                   'maxMs': 90_000, 'maxToolCalls': 12, 'maxOutputBytes': 65_536, 'maxInputBytes': 262_144}
WIRE_TOOLS = ['preview_selection', 'read_facts', 'read_prior_editions', 'read_selection_script', 'replace_selection_script']
WIRE_MODULES = {'app/server/' + name + '.mjs' for name in (
    'hiring-wire', 'hiring-wire-facts', 'hiring-wire-editorial', 'hiring-wire-codex',
    'hiring-wire-codex-policy', 'hiring-wire-codex-broker', 'hiring-wire-integration', 'source-coverage')}


def validate_wire_inventory(manifest):
    files = manifest.get('files', {})
    if (not isinstance(files, dict) or not WIRE_MODULES <= files.keys()
            or files.get('app/server/hiring-wire-sol-catalogue.json') != WIRE_CATALOGUE_SHA256):
        raise ValueError('Hiring Wire requires the complete fixed runtime in this exact artifact.')


def validate_wire_configuration(config, *, private, model_uid=None):
    if config == {'enabled': False} and type(config.get('enabled')) is bool:
        return False
    proof = BASE / ('model/config' if private else 'broker') / 'hiring-wire-reviewed.json'
    if (not isinstance(config, dict) or set(config) != {'enabled', 'attestationPath', 'providerCatalogueSha256', 'modelUid', 'socketPath'}
            or config.get('enabled') is not True or config.get('attestationPath') != str(proof)
            or config.get('socketPath') != str(BASE / 'broker/model.sock')
            or not isinstance(config.get('providerCatalogueSha256'), str)
            or not re.fullmatch(r'[a-f0-9]{64}', config['providerCatalogueSha256'])
            or type(config.get('modelUid')) is not int or config['modelUid'] < 1 or config['modelUid'] != model_uid):
        raise ValueError('Hiring Wire configuration differs from the fixed private broker boundary.')
    return True


def validate_wire_attestation(report, config, manifest, host_plan):
    """Match the same immutable descriptor and independent proof as the Node policy."""
    expected = {'version': 1, 'approved': True, 'profile': 'hiring_wire', 'model': 'gpt-6.1-sol',
                'cliVersion': manifest['codexVersion'], 'cliSource': CODEX_SOURCE_COMMIT, 'nodeVersion': manifest['nodeVersion'],
                'policyVersion': 'hiring-wire-codex-v1', 'buildIdentity': manifest['buildIdentity'], 'hostPlanSha256': host_plan,
                'socketPath': config['socketPath'], 'descriptor': WIRE_DESCRIPTOR,
                'modelCatalogueSha256': WIRE_CATALOGUE_SHA256, 'dynamicToolsSha256': WIRE_DYNAMIC_TOOLS_SHA256,
                'providerCatalogue': {'verified': True, 'transport': 'responses_lite', 'sha256': config['providerCatalogueSha256'],
                                      'toolSchemaSha256': WIRE_DESCRIPTOR['toolSchemaSha256'], 'stockTools': 0, 'tools': WIRE_TOOLS},
                'executorBoundary': 'dedicated_uid_broker', 'modelUid': config['modelUid'], 'fd': 3,
                'deniedPathsVerified': True, 'retentionVerified': True, 'qualityVerified': True, 'sharedSlotVerified': True}
    if (not isinstance(report, dict)
            or json.dumps(report, sort_keys=True, separators=(',', ':'), allow_nan=False)
            != json.dumps(expected, sort_keys=True, separators=(',', ':'), allow_nan=False)):
        raise ValueError('Hiring Wire evidence differs from the exact artifact and private executor.')


def read_wire_attestation(path):
    path = Path(path)
    if path.resolve(strict=True) != path:
        raise ValueError('Hiring Wire proof must use its canonical immutable path.')
    meta = path.lstat()
    if (not stat.S_ISREG(meta.st_mode) or meta.st_uid != 0 or meta.st_nlink != 1
            or meta.st_mode & 0o222 or not 1 <= meta.st_size <= 16_384):
        raise ValueError('Hiring Wire proof must be root-owned, immutable and bounded.')
    for parent in path.parents:
        meta = parent.lstat()
        if not stat.S_ISDIR(meta.st_mode) or meta.st_uid != 0 or meta.st_mode & 0o022:
            raise ValueError('Hiring Wire proof ancestors must be root-owned and protected.')
    return json.loads(path.read_text())


def validate_task_profiles(profiles, *, attested=False):
    """Pin each task's policy separately; an empty-tool proof cannot approve web."""
    if not isinstance(profiles, dict) or not profiles or set(profiles) - TASK_PROFILES.keys():
        raise ValueError('Model task profiles must name reviewed task-specific policies.')
    enabled = set()
    for kind, entry in profiles.items():
        if entry == {'enabled': False} and type(entry.get('enabled')) is bool:
            continue
        keys = {'enabled', 'toolPolicySha256', 'modelCatalogueSha256'} | ({'toolProof'} if attested else set())
        if (not isinstance(entry, dict) or set(entry) != keys or entry.get('enabled') is not True
                or entry.get('toolPolicySha256') != TASK_PROFILES[kind]['toolPolicySha256']
                or entry.get('modelCatalogueSha256') != MODEL_CATALOGUE_SHA256):
            raise ValueError('Model task policy or catalogue identity differs from the reviewed profile.')
        if attested:
            proof = entry['toolProof']
            if not isinstance(proof, dict) or proof.get('toolNames') != TASK_PROFILES[kind]['toolNames']:
                raise ValueError('Model tool proof differs from the task-specific native tool names.')
            if proof.get('kind') == 'supported_static_policy':
                if (set(proof) != {'kind', 'actualWireObserved', 'sourceCommit', 'toolNames'}
                        or proof.get('actualWireObserved') is not False or proof.get('sourceCommit') != CODEX_SOURCE_COMMIT):
                    raise ValueError('Static policy proof must not claim an observed wire catalogue.')
            elif proof.get('kind') == 'actual_wire':
                checksum = proof.get('toolCatalogSha256', '')
                if (set(proof) != {'kind', 'actualWireObserved', 'toolCatalogSha256', 'toolNames'}
                        or proof.get('actualWireObserved') is not True or not isinstance(checksum, str)
                        or len(checksum) != 64 or any(char not in '0123456789abcdef' for char in checksum)
                        or (checksum == EMPTY_TOOL_CATALOG_SHA256) != (kind == 'search_intent')):
                    raise ValueError('Observed catalogue does not prove the task-specific native tools.')
            else:
                raise ValueError('A reviewed static policy or actual wire proof is required.')
        enabled.add(kind)
    if not enabled:
        raise ValueError('Enabled model access requires at least one qualified task profile.')
    return enabled


def validate_configuration(config, release, manifest):
    expected = {'enabled': True, 'cliVersion': manifest['codexVersion'],
                'codexPath': str(Path(release) / manifest['codexEntrypoint']),
                'protectedAuthHome': str(BASE / 'model/credentials'),
                'invocationRoot': str(BASE / 'model/invocations'),
                'taskCwd': str(BASE / 'model/task-cwd')}
    if (not isinstance(config, dict) or {key: value for key, value in config.items() if key != 'hiringWire'} != expected
            or config.get('enabled') is not True):
        raise ValueError('Broker configuration differs from the fixed native executable and private paths.')
    if 'hiringWire' in config and validate_wire_configuration(config['hiringWire'], private=True, model_uid=os.getuid()):
        validate_wire_inventory(manifest)
    return config


def validate_attestation(report, manifest, host_plan):
    expected = {'approved': True, 'cliVersion': manifest['codexVersion'], 'model': 'gpt-6-luna',
                'executorBoundary': 'dedicated_uid_broker', 'socketPath': str(BASE / 'broker/model.sock'),
                'deniedPathsVerified': True, 'retentionVerified': True,
                'buildIdentity': manifest['buildIdentity'], 'hostPlanSha256': host_plan}
    if (not isinstance(report, dict) or any(type(report.get(key)) is not type(value) or report.get(key) != value for key, value in expected.items())
            or 'toolCatalogSha256' in report):
        raise ValueError('Broker isolation evidence is unavailable or does not match the pinned boundary.')
    profiles = validate_task_profiles(report.get('taskProfiles'), attested=True)
    if 'company_resolution' in profiles and report.get('companyResearchVerified') is not True:
        raise ValueError('Company web research requires separately reviewed isolation evidence.')


def child_environment(manifest, host_plan, process_id):
    return {'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8', 'TZ': 'UTC', 'HOME': '/nonexistent',
            'TMPDIR': str(BASE / 'model/invocations'), 'JUSTUP_MODEL_BROKER_CONFIG': str(BASE / 'model/config/broker.json'),
            'JUSTUP_SOURCE_COMMIT': manifest['sourceCommit'], 'JUSTUP_BUILD_ID': manifest['buildIdentity'],
            'JUSTUP_HOST_PLAN_SHA256': host_plan, 'LISTEN_PID': str(process_id), 'LISTEN_FDS': '1'}


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
        if configured.get('hiringWire', {}).get('enabled') is True:
            validate_wire_attestation(read_wire_attestation(configured['hiringWire']['attestationPath']),
                                      configured['hiringWire'], manifest, host_plan)
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
