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
MODEL_CATALOGUE_SHA256 = '0829441e0714986d05563eb5885fa7f22324eff3bf2446cc6be857a227c96402'
CODEX_SOURCE_COMMIT = 'ff6aec96948b70d94983af2641a6b67c94faeff5'
TASK_PROFILES = {
    'search_intent': {'toolPolicySha256': 'f9fbda3d5135a678ecfb68f59bf64a52854da040629ea3ce9116ec429b3dedc1', 'toolNames': []},
    'company_resolution': {'toolPolicySha256': 'a073f7fab18af21ef90c16bce81a687159da19cda045b2a6f1d19069e45ea559', 'toolNames': ['web.run']},
}


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
    if not isinstance(config, dict) or config != expected or config.get('enabled') is not True:
        raise ValueError('Broker configuration differs from the fixed native executable and private paths.')
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
