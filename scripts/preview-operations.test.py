#!/usr/bin/env python3
"""Observable artifact, boundary, privacy and recovery contracts; no remote writes."""
from __future__ import annotations

from copy import deepcopy
from contextlib import contextmanager, ExitStack
from datetime import datetime, timezone
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import sqlite3
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch
from types import SimpleNamespace
import uuid
from urllib.request import Request

sys.dont_write_bytecode = True
HERE = Path(__file__).parent


def load(name):
    spec = importlib.util.spec_from_file_location(name.replace('-', '_'), HERE / (name + '.py'))
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


host, artifact, launcher, recovery, http = [load(name) for name in
    ('preview-host', 'preview-artifact', 'preview-run', 'preview-recovery', 'preview-verify')]
queue = load('preview-queue-run')
model = load('preview-model-run')
CODEX_FIXTURES = {name: ('fixture native distribution ' + name).encode() for name in artifact.CODEX_FILES}


def profiles(*, attested=False):
    result = {kind: {'enabled': True, 'toolPolicySha256': entry['toolPolicySha256'],
                     'modelCatalogueSha256': model.MODEL_CATALOGUE_SHA256}
              for kind, entry in model.TASK_PROFILES.items()}
    if attested:
        for kind, entry in result.items():
            entry['toolProof'] = {'kind': 'supported_static_policy', 'actualWireObserved': False,
                                  'sourceCommit': model.CODEX_SOURCE_COMMIT,
                                  'toolNames': list(model.TASK_PROFILES[kind]['toolNames'])}
    return result


def wire_config(*, private=False):
    return {'enabled': True, 'attestationPath': '/srv/justup_preview/' + ('model/config' if private else 'broker') + '/hiring-wire-reviewed.json',
            'providerCatalogueSha256': 'd' * 64, 'modelUid': 1234, 'socketPath': '/srv/justup_preview/broker/model.sock'}


def wire_report(manifest, config):
    return {'version': 1, 'approved': True, 'profile': 'hiring_wire', 'model': 'gpt-6.1-sol',
            'cliVersion': manifest['codexVersion'], 'cliSource': model.CODEX_SOURCE_COMMIT, 'nodeVersion': manifest['nodeVersion'],
            'policyVersion': 'hiring-wire-codex-v1', 'buildIdentity': manifest['buildIdentity'], 'hostPlanSha256': 'f' * 64,
            'socketPath': config['socketPath'], 'descriptor': deepcopy(model.WIRE_DESCRIPTOR),
            'modelCatalogueSha256': model.WIRE_CATALOGUE_SHA256, 'dynamicToolsSha256': model.WIRE_DYNAMIC_TOOLS_SHA256,
            'providerCatalogue': {'verified': True, 'transport': 'responses_lite', 'sha256': config['providerCatalogueSha256'],
                                  'toolSchemaSha256': model.WIRE_DESCRIPTOR['toolSchemaSha256'], 'stockTools': 0, 'tools': list(model.WIRE_TOOLS)},
            'executorBoundary': 'dedicated_uid_broker', 'modelUid': config['modelUid'], 'fd': 3,
            'deniedPathsVerified': True, 'retentionVerified': True, 'qualityVerified': True, 'sharedSlotVerified': True}


def payload():
    files = {'runtime/bin/node': b'fixture runtime', 'runtime/LICENSE': b'fixture license',
             'app/scripts/import-jobs.py': b'# canonical importer fixture\n',
             'app/server/main.mjs': b'export const ready = true;'}
    files.update({'app/server/' + name + '.mjs': b'export {};' for name in
                 ('auth', 'http', 'store', 'feed', 'tasks', 'config', 'composition', 'runner', 'runner-adapter')})
    files.update(CODEX_FIXTURES)
    manifest = {'formatVersion': 2, 'sourceCommit': 'a' * 40, 'sourceTree': 'b' * 40,
                'schemaVersion': 1, 'nodeVersion': '24.22.2', 'platform': 'linux-arm64',
                'nodeArchiveSha256': artifact.NODE_ARCHIVE_SHA256, 'entrypoint': 'app/server/main.mjs',
                'codexVersion': artifact.CODEX_VERSION, 'codexTarget': artifact.CODEX_TARGET,
                'codexArchiveSha256': artifact.CODEX_ARCHIVE_SHA256, 'codexEntrypoint': artifact.CODEX_ENTRYPOINT,
                'files': {name: artifact.sha(data) for name, data in files.items()}}
    manifest['buildIdentity'] = artifact.identity(manifest)
    return manifest, files


def bundle(path, manifest=None, files=None, extra=None):
    initial, data = payload()
    manifest = initial if manifest is None else manifest
    files = data if files is None else files
    with tarfile.open(path, 'w') as tar:
        for name, value in {'manifest.json': json.dumps(manifest).encode(), **files}.items():
            entry = tarfile.TarInfo(name)
            entry.size = len(value)
            tar.addfile(entry, io.BytesIO(value))
        if extra is not None:
            tar.addfile(extra, io.BytesIO(b''))
    return artifact.sha(path.read_bytes())


class ArtifactContracts(unittest.TestCase):
    def setUp(self):
        # Substitute a small trusted distribution in offline fixture bundles.
        # Production pins are exercised against the real archive separately.
        pins = patch.dict(artifact.CODEX_FILES, {name: artifact.sha(data) for name, data in CODEX_FIXTURES.items()})
        pins.start()
        self.addCleanup(pins.stop)

    def test_backend_inventory_excludes_browser_sources_build_tools_and_dependencies(self):
        for path in ('app/web/dist/index.html', 'app/web/src/app.tsx', 'app/prototype/app.mjs',
                     'app/package.json', 'app/node_modules/react/index.js', 'app/scripts/frontend-prepare.mjs',
                     'app/server/demo-composition.mjs', 'app/server/demo-runner-adapter.mjs',
                     'app/server/hiring-wire-fixtures.mjs', 'app/server/hiring-wire-evals-v1.json',
                     'app/scripts/hiring-wire/arbitrary.mjs', 'app/scripts/hiring-wire/../enqueue.mjs',
                     'app/server/evals/luna-wire-catalogue.mjs',
                     'app/server/./evals/luna-wire-catalogue.mjs', 'app/server//evals/luna-wire-catalogue.mjs',
                     'runtime/codex/bin/codex-code-mode-host', 'runtime/codex/codex-path/rg', 'runtime/codex/codex-resources/zsh/bin/zsh'):
            with self.subTest(path=path):
                self.assertFalse(artifact.allowed(path))

    def test_wire_catalogue_and_fixed_operator_scripts_are_bounded_runtime_assets(self):
        manifest, _ = payload()
        for name in ('app/scripts/hiring-wire/enqueue.mjs', 'app/scripts/hiring-wire/check-snapshot.mjs'):
            self.assertTrue(artifact.allowed(name))
        manifest['files']['app/server/hiring-wire-codex.mjs'] = artifact.sha(b'export {};')
        manifest['files'].update({name: artifact.sha(b'export {};') for name in artifact.WIRE_MODULES})
        for checksum in (None, 'a' * 64, artifact.WIRE_CATALOGUE_SHA256):
            with self.subTest(checksum=checksum):
                if checksum is not None:
                    manifest['files'][artifact.WIRE_CATALOGUE] = checksum
                manifest['buildIdentity'] = artifact.identity(manifest)
                if checksum == artifact.WIRE_CATALOGUE_SHA256:
                    artifact.validate_manifest(manifest)
                else:
                    with self.assertRaisesRegex(ValueError, 'Hiring Wire'):
                        artifact.validate_manifest(manifest)
        for name in artifact.WIRE_MODULES - {'app/server/hiring-wire-codex.mjs'}:
            partial = deepcopy(manifest)
            del partial['files'][name]
            partial['buildIdentity'] = artifact.identity(partial)
            with self.subTest(missing=name), self.assertRaisesRegex(ValueError, 'Hiring Wire'):
                artifact.validate_manifest(partial)

    def test_canonical_importer_without_registered_contracts_cannot_skip_python_verification(self):
        for unrelated in (False, True):
            with self.subTest(unrelated=unrelated), tempfile.TemporaryDirectory() as temp:
                root = Path(temp)
                scripts = root / 'scripts'
                scripts.mkdir()
                (scripts / 'import-jobs.py').write_text('# importer implementation fixture\n')
                if unrelated:
                    (scripts / 'test_other.py').write_text('import unittest\nclass Other(unittest.TestCase):\n def test_other(self): pass\n')
                result = subprocess.run([sys.executable, str(HERE / 'test-python.py')], cwd=root,
                                        capture_output=True, text=True, timeout=10,
                                        env={'PATH': os.environ.get('PATH', ''), 'PYTHONDONTWRITEBYTECODE': '1'})
                self.assertNotEqual(result.returncode, 0)
                self.assertIn('Importer' if not unrelated else 'test_import_jobs.py', result.stderr)

    def test_canonical_importer_and_runtime_adapter_are_required_together(self):
        manifest, _ = payload()
        for name in ('app/scripts/import-jobs.py', 'app/server/config.mjs', 'app/server/composition.mjs', 'app/server/runner-adapter.mjs'):
            with self.subTest(name=name):
                incomplete = deepcopy(manifest)
                del incomplete['files'][name]
                incomplete['buildIdentity'] = artifact.identity(incomplete)
                with self.assertRaisesRegex(ValueError, 'missing required'):
                    artifact.validate_manifest(incomplete)
        for obsolete in ('app/scripts/import-demo-jobs.py', 'app/server/model-schemas/company-domain-proposal.schema.json'):
            self.assertFalse(artifact.allowed(obsolete))
    def test_inventory_accepts_exact_bytes_and_rejects_changed_payload(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / 'candidate.tar'
            checksum = bundle(path)
            manifest, files = artifact.read_bundle(path, checksum)
            self.assertEqual(manifest['sourceCommit'], 'a' * 40)
            self.assertIn('runtime/bin/node', files)
            bad = bytearray(path.read_bytes())
            bad[-1] = 1
            path.write_bytes(bad)
            with self.assertRaisesRegex(ValueError, 'SHA256 mismatch'):
                artifact.read_bundle(path, checksum)

    def test_rehashed_bundle_cannot_hide_payload_tampering(self):
        manifest, files = payload()
        files['app/server/main.mjs'] = b'changed bytes'
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / 'candidate.tar'
            checksum = bundle(path, manifest, files)
            with self.assertRaisesRegex(ValueError, 'complete manifest'):
                artifact.read_bundle(path, checksum)

    def test_traversal_symlink_and_unlisted_files_are_rejected(self):
        for name, kind in [('../escape', tarfile.REGTYPE), ('runtime/link', tarfile.SYMTYPE), ('app/server/extra.mjs', tarfile.REGTYPE)]:
            with self.subTest(name=name), tempfile.TemporaryDirectory() as temp:
                path = Path(temp) / 'candidate.tar'
                entry = tarfile.TarInfo(name)
                entry.type = kind
                entry.linkname = '/etc/passwd' if kind == tarfile.SYMTYPE else ''
                checksum = bundle(path, extra=entry)
                with self.assertRaises(ValueError):
                    artifact.read_bundle(path, checksum)

    def test_runtime_source_and_manifest_identity_are_mandatory(self):
        original, _ = payload()
        for key, value in [('sourceCommit', 'dev'), ('nodeVersion', '22'), ('platform', 'linux-x64'), ('buildIdentity', '0' * 64),
                           ('codexVersion', '0.143.0'), ('codexTarget', 'x86_64-unknown-linux-musl'),
                           ('codexArchiveSha256', 'f' * 64), ('codexEntrypoint', 'runtime/bin/arbitrary')]:
            with self.subTest(key=key):
                candidate = deepcopy(original)
                candidate[key] = value
                with self.assertRaises(ValueError):
                    artifact.validate_manifest(candidate)

    def test_host_plan_identity_requires_a_real_root_controlled_receipt(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp).resolve()
            marker = base / '.preview-install.json'
            marker.write_text(json.dumps({'formatVersion': 1, 'planSha256': 'f' * 64}))
            marker.chmod(0o644)
            original_lstat = Path.lstat
            owner = 0
            def metadata(path):
                actual = original_lstat(path)
                if path == marker:
                    return SimpleNamespace(st_mode=actual.st_mode, st_uid=owner,
                                           st_nlink=actual.st_nlink, st_size=actual.st_size)
                return actual
            with patch.object(Path, 'lstat', metadata):
                self.assertEqual(artifact.read_host_plan(base), 'f' * 64)
                owner = 1234
                with self.assertRaises(ValueError):
                    artifact.read_host_plan(base)
                owner = 0
                marker.chmod(0o666)
                with self.assertRaises(ValueError):
                    artifact.read_host_plan(base)
                marker.chmod(0o644)
                marker.write_text(json.dumps({'formatVersion': 1, 'planSha256': 'caller-selected'}))
                with self.assertRaises(ValueError):
                    artifact.read_host_plan(base)

    def test_streamed_staging_preserves_exact_native_bytes_and_executable_modes(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / 'releases').mkdir()
            bundle_path = root / 'candidate.tar'
            checksum = bundle(bundle_path)
            with patch.object(host, 'BASE', root), patch.object(host, 'require_operator'), patch.object(host, 'artifact_module', return_value=artifact):
                result = host.stage(bundle_path, checksum)
            release = root / 'releases' / result['staged']
            self.assertFalse(result['activated'])
            self.assertFalse((root / 'current').exists())
            for name, data in CODEX_FIXTURES.items():
                self.assertEqual((release / name).read_bytes(), data)
                self.assertEqual((release / name).stat().st_mode & 0o777, 0o555 if name in artifact.EXECUTABLES else 0o444)
            self.assertEqual(artifact.verify_directory(release)['buildIdentity'], result['staged'])
            _, retained = artifact.read_bundle(bundle_path, checksum, retain_files=False)
            self.assertEqual(retained, {})

    def test_company_runtime_requires_final_and_native_discovery_schema_assets(self):
        manifest, files = payload()
        files['app/server/companies.mjs'] = b'export {};'
        files['app/server/model-schemas/company.schema.json'] = b'{}'
        manifest['files'] = {name: artifact.sha(data) for name, data in files.items()}
        manifest['buildIdentity'] = artifact.identity(manifest)
        with self.assertRaisesRegex(ValueError, 'model schema asset'):
            artifact.validate_manifest(manifest)
        name = 'app/server/model-schemas/company-discovery.schema.json'
        manifest['files'][name] = artifact.sha(b'{}')
        manifest['buildIdentity'] = artifact.identity(manifest)
        self.assertTrue(artifact.allowed(name))
        self.assertEqual(artifact.validate_manifest(manifest)['buildIdentity'], manifest['buildIdentity'])

    def test_model_catalogue_is_required_packaged_and_digest_bound(self):
        manifest, files = payload()
        files['app/server/model-runner.mjs'] = b'export {};'
        manifest['files'] = {name: artifact.sha(data) for name, data in files.items()}
        manifest['buildIdentity'] = artifact.identity(manifest)
        with self.assertRaisesRegex(ValueError, 'model catalogue'):
            artifact.validate_manifest(manifest)
        files[artifact.MODEL_CATALOGUE] = b'{"models": []}'
        manifest['files'][artifact.MODEL_CATALOGUE] = artifact.sha(files[artifact.MODEL_CATALOGUE])
        manifest['buildIdentity'] = artifact.identity(manifest)
        self.assertTrue(artifact.allowed(artifact.MODEL_CATALOGUE))
        self.assertFalse(artifact.allowed('app/server/caller-catalogue.json'))
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / 'candidate.tar'
            checksum = bundle(path, manifest, files)
            verified, retained = artifact.read_bundle(path, checksum)
            self.assertEqual(verified['buildIdentity'], manifest['buildIdentity'])
            self.assertEqual(retained[artifact.MODEL_CATALOGUE], files[artifact.MODEL_CATALOGUE])
            files[artifact.MODEL_CATALOGUE] = b'{"models": ["changed"]}'
            checksum = bundle(path, manifest, files)
            with self.assertRaisesRegex(ValueError, 'complete manifest'):
                artifact.read_bundle(path, checksum)

    def test_deployed_inventory_is_readonly_complete_and_not_a_moving_link(self):
        manifest, files = payload()
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp) / 'release'
            root.mkdir()
            for name, value in {**files, 'manifest.json': json.dumps(manifest).encode()}.items():
                path = root / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(value)
                path.chmod(0o555 if name in artifact.EXECUTABLES else 0o444)
            self.assertEqual(artifact.verify_directory(root)['buildIdentity'], manifest['buildIdentity'])
            (root / 'app/server/main.mjs').chmod(0o644)
            with self.assertRaisesRegex(ValueError, 'read-only'):
                artifact.verify_directory(root)
            link = Path(temp) / 'current'
            link.symlink_to(root)
            with self.assertRaisesRegex(ValueError, 'moving symlink'):
                artifact.verify_directory(link)


class OperatorUpgradeContracts(unittest.TestCase):
    @contextmanager
    def installation(self):
        with tempfile.TemporaryDirectory() as temp, ExitStack() as patches:
            root = Path(temp).resolve()
            old_source, new_source, base, units, proc = [root / name for name in ('old', 'new', 'mount', 'units', 'proc')]
            (old_source / 'scripts').mkdir(parents=True)
            shutil.copytree(HERE.parent / 'deploy/justup-preview', old_source / 'deploy/justup-preview')
            for path in HERE.glob('preview-*.py'):
                if not path.name.endswith('.test.py'):
                    shutil.copyfile(path, old_source / 'scripts' / path.name)
            shutil.copytree(old_source, new_source)
            artifact_source = new_source / 'scripts/preview-artifact.py'
            artifact_source.write_text(artifact_source.read_text() + '\n# fixture revised operator bytes\n')
            base.mkdir()
            units.mkdir()
            proc.mkdir()
            ops = base / 'ops'
            ops.mkdir()
            for path in (old_source / 'scripts').iterdir():
                shutil.copyfile(path, ops / path.name)
                (ops / path.name).chmod(0o555)
            for name in host.UNITS:
                shutil.copyfile(old_source / 'deploy/justup-preview' / name, units / name)
            # Synthetic state is outside the update's only writable destinations.
            state = {}
            for name in ('model/credentials/auth.json', 'state/preview.sqlite', 'state/private-generation',
                         'queue/budget/jev.jsonl', 'config/api.json'):
                path = base / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(('private fixture ' + name).encode())
                path.chmod(0o600)
                state[name] = (path.read_bytes(), path.stat().st_ino)
            (base / 'current').symlink_to('releases/prior-build')
            current_inode = (base / 'current').lstat().st_ino
            image = root / 'preview.disk'
            image.write_bytes(b'physical boundary fixture')
            image.chmod(0o600)
            image_identity = (image.read_bytes(), image.stat().st_ino)
            for key, value in [('BASE', base), ('IMAGE', image), ('UNIT_ROOT', units), ('PROC_ROOT', proc), ('OPERATOR_UID', os.getuid())]:
                patches.enter_context(patch.object(host, key, value))
            old_plan = host.plan(old_source, 'a' * 64)
            new_plan = host.plan(new_source, 'a' * 64)
            previous = root / 'previous-plan.json'
            previous.write_text(json.dumps(old_plan))
            marker = base / '.preview-install.json'
            marker.write_text(json.dumps({'formatVersion': 1, 'planSha256': old_plan['planSha256']}))
            marker.chmod(0o644)
            commands = []
            def command(*args, **kwargs):
                commands.append(args)
                return 'inactive' if kwargs.get('capture') else None
            patches.enter_context(patch.object(host, 'reviewed'))
            patches.enter_context(patch.object(host, 'require_operator'))
            patches.enter_context(patch.object(host, 'guard', return_value={'verified': True}))
            patches.enter_context(patch.object(host, 'stop_preview'))
            patches.enter_context(patch.object(host, 'call', side_effect=command))
            patches.enter_context(patch.object(host.pwd, 'getpwnam', return_value=SimpleNamespace(pw_uid=os.getuid())))
            yield SimpleNamespace(root=root, base=base, units=units, proc=proc, old=old_source, new=new_source,
                                  before=old_plan, after=new_plan, previous=previous, marker=marker,
                                  state=state, current_inode=current_inode, image=image,
                                  image_identity=image_identity, commands=commands)

    def upgrade(self, fixture, old_sha=None):
        return host.upgrade_ops(fixture.new, fixture.previous,
                                fixture.before['planSha256'] if old_sha is None else old_sha,
                                fixture.after['planSha256'], 'a' * 64)

    def assert_private_state_unchanged(self, fixture):
        for name, expected in fixture.state.items():
            path = fixture.base / name
            self.assertEqual((path.read_bytes(), path.stat().st_ino), expected)
        self.assertEqual((fixture.base / 'current').lstat().st_ino, fixture.current_inode)
        self.assertEqual((fixture.image.read_bytes(), fixture.image.stat().st_ino), fixture.image_identity)
        self.assertFalse(any(item[:2] == ('systemctl', 'start') for item in fixture.commands))

    def test_scripts_only_upgrade_retains_state_receipt_history_and_caps(self):
        with self.installation() as fixture:
            result = self.upgrade(fixture)
            self.assertFalse(result['activated'])
            self.assertFalse(result['privateStateTouched'])
            self.assertEqual(json.loads(fixture.marker.read_text())['planSha256'], fixture.after['planSha256'])
            self.assertEqual(fixture.marker.stat().st_mode & 0o777, 0o444)
            self.assertFalse((fixture.base / host.UPGRADE_LOCK).exists())
            history = next((fixture.base / '.preview-ops-updates').iterdir())
            self.assertEqual(json.loads((history / 'previous-receipt.json').read_text())['planSha256'], fixture.before['planSha256'])
            self.assertEqual(host.digest(fixture.base / 'ops/preview-artifact.py'), fixture.after['files']['scripts/preview-artifact.py'])
            self.assertEqual(host.digest(history / 'previous-ops/preview-artifact.py'), fixture.before['files']['scripts/preview-artifact.py'])
            self.assert_private_state_unchanged(fixture)

    def test_wrong_old_receipt_plan_or_tampered_operator_bytes_are_not_adopted(self):
        for condition in ('wrong-plan', 'wrong-receipt', 'tampered-operator', 'changed-unit'):
            with self.subTest(condition=condition), self.installation() as fixture:
                old_sha = fixture.before['planSha256']
                if condition == 'wrong-plan':
                    old_sha = 'f' * 64
                elif condition == 'wrong-receipt':
                    fixture.marker.write_text(json.dumps({'formatVersion': 1, 'planSha256': 'f' * 64}))
                elif condition == 'tampered-operator':
                    target = fixture.base / 'ops/preview-artifact.py'
                    target.chmod(0o755)
                    target.write_bytes(b'tampered')
                    target.chmod(0o555)
                else:
                    (fixture.units / host.UNITS[-1]).write_bytes(b'tampered unit')
                with self.assertRaises(ValueError):
                    self.upgrade(fixture, old_sha)
                self.assertFalse((fixture.base / host.UPGRADE_LOCK).exists())
                self.assert_private_state_unchanged(fixture)

    def test_changed_resource_or_unit_definition_requires_another_workflow(self):
        for condition in ('resource', 'unit'):
            with self.subTest(condition=condition), self.installation() as fixture:
                if condition == 'resource':
                    fixture.before['imageBytes'] += 1
                    body = {key: value for key, value in fixture.before.items() if key != 'planSha256'}
                    fixture.before['planSha256'] = hashlib.sha256(json.dumps(body, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
                    fixture.previous.write_text(json.dumps(fixture.before))
                else:
                    (fixture.new / 'deploy/justup-preview' / host.UNITS[-1]).write_bytes(b'new unit')
                    fixture.after = host.plan(fixture.new, 'a' * 64)
                with self.assertRaises(ValueError):
                    self.upgrade(fixture)
                self.assertFalse((fixture.base / host.UPGRADE_LOCK).exists())
                self.assert_private_state_unchanged(fixture)

    def test_failed_directory_adoption_rolls_back_before_restoring_old_receipt(self):
        with self.installation() as fixture:
            rename = Path.rename
            def fail_new(path, target):
                if path.name == 'prepared-ops' and target == fixture.base / 'ops':
                    self.assertFalse(fixture.marker.exists())
                    raise OSError('simulated new directory failure')
                return rename(path, target)
            with patch.object(Path, 'rename', fail_new), self.assertRaises(OSError):
                self.upgrade(fixture)
            self.assertEqual(json.loads(fixture.marker.read_text())['planSha256'], fixture.before['planSha256'])
            self.assertEqual(host.digest(fixture.base / 'ops/preview-artifact.py'), fixture.before['files']['scripts/preview-artifact.py'])
            self.assertFalse((fixture.base / host.UPGRADE_LOCK).exists())
            self.assert_private_state_unchanged(fixture)

    def test_crash_after_swap_keeps_receipt_absent_and_runtime_blocked(self):
        class Crash(BaseException):
            pass
        with self.installation() as fixture:
            rename = Path.rename
            def crash(path, target):
                result = rename(path, target)
                if path.name == 'prepared-ops' and target == fixture.base / 'ops':
                    raise Crash()
                return result
            with patch.object(Path, 'rename', crash), self.assertRaises(Crash):
                self.upgrade(fixture)
            self.assertFalse(fixture.marker.exists())
            self.assertTrue((fixture.base / host.UPGRADE_LOCK).exists())
            with self.assertRaisesRegex(ValueError, 'adoption is blocked'):
                artifact.read_host_plan(fixture.base)
            self.assert_private_state_unchanged(fixture)

    def test_receipt_publication_failure_restores_only_verified_old_directory(self):
        with self.installation() as fixture:
            publish = host.publish_receipt
            attempts = 0
            def fail_new(marker, temporary, data):
                nonlocal attempts
                attempts += 1
                self.assertFalse(marker.exists())
                if attempts == 1:
                    raise OSError('simulated publication failure')
                self.assertEqual(host.digest(fixture.base / 'ops/preview-artifact.py'), fixture.before['files']['scripts/preview-artifact.py'])
                return publish(marker, temporary, data)
            with patch.object(host, 'publish_receipt', fail_new), self.assertRaises(OSError):
                self.upgrade(fixture)
            self.assertEqual(attempts, 2)
            self.assertEqual(json.loads(fixture.marker.read_text())['planSha256'], fixture.before['planSha256'])
            self.assertFalse((fixture.base / host.UPGRADE_LOCK).exists())
            self.assert_private_state_unchanged(fixture)

    def test_conflicting_receipt_is_not_removed_or_overwritten(self):
        with self.installation() as fixture:
            conflict = b'{"formatVersion":1,"planSha256":"another operator decision"}\n'
            def conflicting(marker, temporary, data):
                marker.write_bytes(conflict)
                raise FileExistsError('another receipt exists')
            with patch.object(host, 'publish_receipt', conflicting), self.assertRaisesRegex(ValueError, 'pending lock'):
                self.upgrade(fixture)
            self.assertEqual(fixture.marker.read_bytes(), conflict)
            self.assertTrue((fixture.base / host.UPGRADE_LOCK).exists())
            with self.assertRaisesRegex(ValueError, 'adoption is blocked'):
                artifact.read_host_plan(fixture.base)
            self.assert_private_state_unchanged(fixture)

    def test_active_dedicated_identity_blocks_replacement(self):
        with self.installation() as fixture:
            process = fixture.proc / '123'
            process.mkdir()
            dedicated_uid = os.getuid() + 1234
            # Model a nondumpable process: directory owner is the operator,
            # while the actual kernel-reported identities belong to the model.
            (process / 'status').write_text('Uid:\t' + '\t'.join([str(dedicated_uid)] * 4) + '\n')
            with patch.object(host.pwd, 'getpwnam', return_value=SimpleNamespace(pw_uid=dedicated_uid)):
                with self.assertRaisesRegex(ValueError, 'no running processes'):
                    self.upgrade(fixture)
            self.assertEqual(json.loads(fixture.marker.read_text())['planSha256'], fixture.before['planSha256'])
            self.assertEqual(host.digest(fixture.base / 'ops/preview-artifact.py'), fixture.before['files']['scripts/preview-artifact.py'])
            self.assert_private_state_unchanged(fixture)


class BoundaryContracts(unittest.TestCase):
    def setUp(self):
        # Isolated operator-owned fixture files belong to this test user; no
        # privileged filesystem or user/service operation runs in the suite.
        owner = patch.object(host, 'OPERATOR_UID', os.getuid())
        owner.start()
        self.addCleanup(owner.stop)

    def test_exact_size_sparse_image_is_rejected_before_mount_or_reserve_checks(self):
        with tempfile.TemporaryDirectory() as temp:
            image = Path(temp) / 'preview.disk'
            with image.open('wb') as stream:
                stream.truncate(host.DISK_LIMIT)
            image.chmod(0o600)
            self.assertEqual(image.stat().st_size, host.DISK_LIMIT)
            self.assertLess(image.stat().st_blocks * 512, host.DISK_LIMIT)
            with patch.object(host, 'IMAGE', image), patch.object(host, 'call', side_effect=AssertionError('must reject before mount commands')):
                with self.assertRaisesRegex(ValueError, 'physically preallocated'):
                    host.verify_storage()

    def test_format_preserves_reservation_and_guard_rejects_later_discard_without_reallocation(self):
        with tempfile.TemporaryDirectory() as temp:
            image = Path(temp) / 'preview.disk'
            image.write_bytes(b'x' * 8192)
            image.chmod(0o600)
            deferred_initialization = False
            def formatter(*args, **kwargs):
                nonlocal deferred_initialization
                # Model the observed external utility: default discard releases
                # extents immediately; lazy initialization can release them later.
                options = set(args[args.index('-E') + 1].split(',')) if '-E' in args else set()
                deferred_initialization = not {'lazy_itable_init=0', 'lazy_journal_init=0'} <= options
                if 'nodiscard' in options:
                    with image.open('r+b') as stream:
                        stream.write(b'formatted')
                else:
                    with image.open('wb') as stream:
                        stream.truncate(8192)
            with patch.object(host, 'IMAGE', image), patch.object(host, 'DISK_LIMIT', 8192), patch.object(host, 'call', side_effect=formatter):
                self.assertGreaterEqual(host.format_image().st_blocks * 512, 8192)
                if deferred_initialization:
                    with image.open('wb') as stream:
                        stream.truncate(8192)
                self.assertGreaterEqual(host.verify_image().st_blocks * 512, 8192)
                # A later trim/hole punch keeps logical size but removes reservation.
                with image.open('wb') as stream:
                    stream.truncate(8192)
                with patch.object(host, 'verify_caps', return_value={}), patch.object(host, 'stop_preview') as stopped:
                    with self.assertRaisesRegex(ValueError, 'physically preallocated'):
                        host.guard(stop_on_failure=True)
                    stopped.assert_called_once()
                self.assertLess(image.stat().st_blocks * 512, 8192)

    def test_sparse_teardown_still_requires_owned_plan_private_image_and_valid_backing(self):
        for condition in ('valid', 'wrong-plan', 'wrong-owner', 'public-image', 'wrong-backing'):
            with self.subTest(condition=condition), tempfile.TemporaryDirectory() as temp:
                root = Path(temp)
                base = root / 'mount'
                base.mkdir()
                marker = base / '.preview-install.json'
                marker.write_text(json.dumps({'formatVersion': 1, 'planSha256': 'a' * 64}))
                marker.chmod(0o644)
                image = root / 'preview.disk'
                with image.open('wb') as stream:
                    stream.truncate(8192)
                image.chmod(0o644 if condition == 'public-image' else 0o600)
                mounted = True
                def call(*args, **kwargs):
                    nonlocal mounted
                    if args == ('systemctl', 'stop', 'srv-justup_preview.mount'):
                        # A normal unmount reveals the original empty mountpoint.
                        base.rename(root / 'retained-filesystem')
                        base.mkdir()
                        mounted = False
                backing_error = ValueError('Wrong loop backing file.') if condition == 'wrong-backing' else None
                owner = os.getuid() + 1 if condition == 'wrong-owner' else os.getuid()
                with patch.object(host, 'BASE', base), patch.object(host, 'IMAGE', image), patch.object(host, 'DISK_LIMIT', 8192), \
                     patch.object(host, 'OPERATOR_UID', owner), patch.object(host.os, 'geteuid', return_value=0), \
                     patch.object(host, 'verify_caps', return_value={}), \
                     patch.object(host, '_mounted_image_size', return_value=8192, side_effect=backing_error), \
                     patch.object(host, 'stop_preview') as stopped, patch.object(host, 'call', side_effect=call) as commands, \
                     patch.object(host.os.path, 'ismount', side_effect=lambda path: path == base and mounted):
                    if condition == 'valid':
                        with self.assertRaisesRegex(ValueError, 'physically preallocated'):
                            host.verify_storage()
                        result = host.teardown(expected_plan='a' * 64)
                        self.assertTrue(result['stopped'])
                        self.assertTrue(result['imageRetained'])
                        self.assertTrue(image.exists())
                        self.assertFalse(mounted)
                        stopped.assert_called_once()
                    else:
                        with self.assertRaises(ValueError):
                            host.teardown(expected_plan=('b' if condition == 'wrong-plan' else 'a') * 64)
                        stopped.assert_not_called()
                        commands.assert_not_called()

    def cgroup(self, root, changed=None):
        values = {'cpu.max': '50000 100000', 'cpu.weight': '10', 'memory.high': str(768 * host.MIB),
                  'memory.max': str(host.GIB), 'memory.swap.max': '0', 'pids.max': '96'}
        values.update(changed or {})
        for name, value in values.items():
            (root / name).write_text(value)

    def test_kernel_values_prove_aggregate_ceiling_and_fail_if_widened(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            self.cgroup(root)
            self.assertEqual(host.verify_caps(root)['pids.max'], '96')
            for name, value in [('cpu.max', 'max 100000'), ('cpu.max', '60000 100000'), ('memory.max', str(2 * host.GIB)),
                                ('memory.swap.max', '1'), ('pids.max', '97'), ('memory.high', 'max'), ('cpu.weight', '100')]:
                with self.subTest(name=name, value=value):
                    self.cgroup(root, {name: value})
                    with self.assertRaises(ValueError):
                        host.verify_caps(root)

    def test_reserve_refuses_allocation_before_it_uses_host_floor(self):
        with self.assertRaisesRegex(ValueError, 'reserve'):
            host.root_reserve(extra=2 * host.GIB, available=10 * host.GIB - 1)
        self.assertEqual(host.root_reserve(extra=2 * host.GIB, available=10 * host.GIB), 10 * host.GIB)

    def test_guard_failure_stops_only_explicit_preview_units(self):
        def response(*args, **kwargs):
            return 'loaded' if '--property=LoadState' in args else 'inactive'
        with patch.object(host, 'verify_caps', side_effect=ValueError('limit missing')), patch.object(host, 'call', side_effect=response) as call:
            with self.assertRaises(ValueError):
                host.guard(stop_on_failure=True)
            stops = [item.args for item in call.call_args_list if item.args[:2] == ('systemctl', 'stop')]
            self.assertEqual(stops, [('systemctl', 'stop', unit) for unit in host.STOP_UNITS])
            self.assertFalse(any('jobseek' in str(item) or '*' in str(item) for item in call.call_args_list))

    def test_stop_refuses_to_switch_if_a_preview_writer_remains_running(self):
        def response(*args, **kwargs):
            return 'loaded' if '--property=LoadState' in args else 'active'
        with patch.object(host, 'call', side_effect=response):
            with self.assertRaisesRegex(ValueError, 'did not stop'):
                host.stop_preview()

    def test_slice_hierarchy_resolves_the_actual_aggregate_parent(self):
        with patch.object(Path, 'read_text', return_value='0::/justup.slice/justup-preview.slice/preview-test.service\n'):
            self.assertEqual(host.self_cgroup(), Path('/sys/fs/cgroup/justup.slice/justup-preview.slice'))

    def test_model_membership_and_socket_keep_api_and_database_separate(self):
        root = HERE.parent
        plan = host.plan(root, 'a' * 64)
        self.assertEqual(plan['groups'][host.STATE_GROUP], [host.USER, host.RUNNER_USER])
        self.assertEqual(plan['groups'][host.CLIENT_GROUP], [host.RUNNER_USER])
        self.assertTrue(all(host.MODEL_USER not in members for members in plan['groups'].values()))
        unit = (root / 'deploy/justup-preview/justup-preview-model.service').read_text()
        socket = (root / 'deploy/justup-preview/justup-preview-model.socket').read_text()
        self.assertIn('User=justup-preview-model', unit)
        self.assertIn('-/srv/justup_preview/state', unit)
        self.assertIn('-/srv/justup_preview/config', unit)
        self.assertIn('StandardOutput=null', unit)
        self.assertIn('SocketUser=root', socket)
        self.assertIn('SocketMode=0660', socket)
        self.assertIn('DirectoryMode=0750', socket)
        self.assertIn('ConditionPathExists=/srv/justup_preview/model/config/isolation-reviewed.json', socket)

    def test_model_launcher_requires_systemd_fd_before_any_credential_read(self):
        model = load('preview-model-run')
        with patch.object(model.os, 'getuid', return_value=1234), patch.dict(os.environ, {'LISTEN_PID': 'wrong', 'LISTEN_FDS': '1'}), patch.object(Path, 'read_text', side_effect=AssertionError('must not read credentials')):
            self.assertEqual(model.main(), 1)

    def test_model_configuration_cannot_choose_another_root_executable_or_private_path(self):
        model = load('preview-model-run')
        manifest, _ = payload()
        release = Path('/srv/justup_preview/releases') / manifest['buildIdentity']
        config = {'enabled': True, 'cliVersion': artifact.CODEX_VERSION, 'codexPath': str(release / artifact.CODEX_ENTRYPOINT),
                  'protectedAuthHome': '/srv/justup_preview/model/credentials',
                  'invocationRoot': '/srv/justup_preview/model/invocations', 'taskCwd': '/srv/justup_preview/model/task-cwd'}
        self.assertEqual(model.validate_configuration(config, release, manifest), config)
        for change in ({'codexPath': '/usr/local/bin/codex'}, {'cliVersion': '0.143.0'},
                       {'protectedAuthHome': '/root/.codex'}, {'taskCwd': '/srv/justup_preview/state'}, {'command': 'sh'},
                       {'buildIdentity': manifest['buildIdentity']}, {'hostPlanSha256': 'f' * 64}):
            with self.subTest(change=change), self.assertRaises(ValueError):
                model.validate_configuration({**config, **change}, release, manifest)
        with self.assertRaises(ValueError):
            model.validate_attestation({'approved': True}, manifest, 'f' * 64)

    def test_admitted_launcher_json_matches_actual_node_runner_and_broker_key_boundaries(self):
        manifest, _ = payload()
        release = Path('/srv/justup_preview/releases') / manifest['buildIdentity']
        broker = {'enabled': True, 'cliVersion': artifact.CODEX_VERSION,
                  'codexPath': str(release / artifact.CODEX_ENTRYPOINT),
                  'protectedAuthHome': '/srv/justup_preview/model/credentials',
                  'invocationRoot': '/srv/justup_preview/model/invocations',
                  'taskCwd': '/srv/justup_preview/model/task-cwd'}
        runner = {'dbPath': '/srv/justup_preview/state/preview.sqlite', 'sharedState': True,
                  'runnerStatusPath': '/srv/justup_preview/state/runner-status.json'}
        model.validate_configuration(broker, release, manifest)
        queue.validate_configuration(runner, manifest)
        manifest['files'].update({name: 'b' * 64 for name in model.WIRE_MODULES})
        manifest['files']['app/server/hiring-wire-sol-catalogue.json'] = model.WIRE_CATALOGUE_SHA256
        source = {'directory': '/unprovisioned/source-input', 'sourceVersion': 'jobseek-coverage-v1'}
        runner_cases = [runner, {**runner, 'hiringWire': {'enabled': False}},
                        {**runner, 'hiringWire': wire_config(), 'sourceCoverage': source}]
        broker_cases = [broker, {**broker, 'hiringWire': {'enabled': False}}, {**broker, 'hiringWire': wire_config(private=True)}]
        with patch.object(queue.pwd, 'getpwnam', return_value=SimpleNamespace(pw_uid=1234)), patch.object(model.os, 'getuid', return_value=1234):
            for admitted in runner_cases:
                queue.validate_configuration(admitted, manifest)
            for admitted in broker_cases:
                model.validate_configuration(admitted, release, manifest)
        unsupported = [{'hiringWire': {'enabled': False, 'command': 'caller'}},
                       {'sourceCoverage': {**source, 'sourceVersion': 'caller-version'}}, {'modulePath': '/caller/module.mjs'}]
        for extra in unsupported:
            with self.subTest(extra=extra):
                with self.assertRaises(ValueError):
                    model.validate_configuration({**broker, **extra}, release, manifest)
                with self.assertRaises(ValueError):
                    queue.validate_configuration({**runner, **extra}, manifest)
        script = r"""
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
const input = JSON.parse(readFileSync(0, 'utf8'));
const { bindRunnerConfig } = await import(input.adapterUrl);
const { validWireConfiguration } = await import(input.wireUrl);
for (const runner of input.runners) {
  const bound = bindRunnerConfig(runner, input.environment);
  assert.equal(bound.sourceCommit, input.environment.JUSTUP_SOURCE_COMMIT);
  assert.equal(bound.buildIdentity, input.environment.JUSTUP_BUILD_ID);
  assert.equal(bound.hostPlanSha256, input.environment.JUSTUP_HOST_PLAN_SHA256);
}
const source = readFileSync(new URL(input.brokerUrl), 'utf8');
// Evaluate the actual executable's key guard without starting its fd/auth boundary.
const guard = source.match(/Object\.keys\(supplied\)\.some\(key=>!\[[^\]]*\]\.includes\(key\)\)/)?.[0];
assert.ok(guard, 'The broker key boundary must remain independently testable.');
for (const broker of input.brokers) {
  assert.equal(runInNewContext(guard, { supplied: broker }), false);
  assert.equal(validWireConfiguration(broker.hiringWire), true);
}
assert.equal(runInNewContext(guard, { supplied: { ...input.broker, sourceCoverage: input.sourceCoverage } }), true);
for (const extra of input.unsupported) {
  assert.throws(() => bindRunnerConfig({ ...input.runner, ...extra }, input.environment));
  if (extra.hiringWire) assert.equal(validWireConfiguration(extra.hiringWire), false);
  else assert.equal(runInNewContext(guard, { supplied: { ...input.broker, ...extra } }), true);
}
process.stdout.write('actual_node_configuration_boundaries_match\n');
"""
        result = subprocess.run(['node', '--input-type=module', '-e', script], text=True,
                                input=json.dumps({'runner': runner, 'broker': broker, 'runners': runner_cases, 'brokers': broker_cases,
                                                  'sourceCoverage': source, 'unsupported': unsupported,
                                                  'environment': queue.child_environment(manifest, 'f' * 64),
                                                  'adapterUrl': (HERE.parent / 'server/runner-adapter.mjs').resolve().as_uri(),
                                                  'wireUrl': (HERE.parent / 'server/hiring-wire-codex-broker.mjs').resolve().as_uri(),
                                                  'brokerUrl': (HERE.parent / 'server/model-broker.mjs').resolve().as_uri()}),
                                capture_output=True, timeout=15,
                                env={'PATH': os.environ.get('PATH', ''), 'LANG': 'C.UTF-8'})
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('actual_node_configuration_boundaries_match', result.stdout)

    def test_stale_model_attestation_and_inherited_identity_cannot_match_current_release(self):
        model = load('preview-model-run')
        manifest, _ = payload()
        report = {'approved': True, 'cliVersion': artifact.CODEX_VERSION, 'model': 'gpt-6-luna',
                  'executorBoundary': 'dedicated_uid_broker', 'socketPath': '/srv/justup_preview/broker/model.sock',
                  'deniedPathsVerified': True, 'retentionVerified': True, 'companyResearchVerified': True,
                  'taskProfiles': profiles(attested=True),
                  'buildIdentity': manifest['buildIdentity'], 'hostPlanSha256': 'f' * 64}
        model.validate_attestation(report, manifest, 'f' * 64)
        for change in ({'buildIdentity': 'e' * 64}, {'hostPlanSha256': 'e' * 64}, {'approved': 1},
                       {'cliVersion': '0.143.0'}, {'toolCatalogSha256': 'c' * 64}):
            with self.subTest(change=change), self.assertRaises(ValueError):
                model.validate_attestation({**report, **change}, manifest, 'f' * 64)
        with patch.dict(os.environ, {'JUSTUP_BUILD_ID': 'untrusted', 'JUSTUP_HOST_PLAN_SHA256': 'untrusted', 'TYPESAFE_AI_TOKEN': 'private'}):
            env = model.child_environment(manifest, 'f' * 64, 1234)
        self.assertEqual(env['JUSTUP_BUILD_ID'], manifest['buildIdentity'])
        self.assertEqual(env['JUSTUP_HOST_PLAN_SHA256'], 'f' * 64)
        self.assertEqual(env['LISTEN_PID'], '1234')
        self.assertNotIn('TYPESAFE_AI_TOKEN', env)

    def test_wire_source_configuration_requires_its_exact_graph_and_stays_outside_shared_state(self):
        manifest, _ = payload()
        config = {'dbPath': '/srv/justup_preview/state/preview.sqlite', 'sharedState': True,
                  'runnerStatusPath': '/srv/justup_preview/state/runner-status.json'}
        source = {'directory': '/unprovisioned/source-input', 'sourceVersion': 'jobseek-coverage-v1'}
        with self.assertRaisesRegex(ValueError, 'exact artifact'):
            queue.validate_configuration({**config, 'sourceCoverage': source}, manifest)
        self.assertEqual(model.WIRE_MODULES, artifact.WIRE_MODULES)
        manifest['files'].update({name: 'b' * 64 for name in model.WIRE_MODULES})
        manifest['files']['app/server/hiring-wire-sol-catalogue.json'] = model.WIRE_CATALOGUE_SHA256
        with patch.object(Path, 'read_text', side_effect=AssertionError('Configuration must not read source bytes')):
            queue.validate_configuration({**config, 'sourceCoverage': source}, manifest)
        with patch.object(queue.pwd, 'getpwnam', side_effect=AssertionError('Disabled Wire must not inspect a UID')):
            queue.validate_configuration({**config, 'hiringWire': {'enabled': False}}, manifest)
        for change in ({'directory': 'relative/source'}, {'directory': '/source/../other'}, {'directory': '/source//input'},
                       {'directory': '/srv/justup_preview/state'}, {'directory': '/srv/justup_preview/state/backups'},
                       {'directory': '/srv/justup_preview/state/history'}, {'sourceVersion': 'unreviewed'}, {'enabled': True}):
            with self.subTest(change=change), self.assertRaises(ValueError):
                queue.validate_configuration({**config, 'sourceCoverage': {**source, **change}}, manifest)
        for private in (False, True):
            wire = wire_config(private=private)
            self.assertTrue(model.validate_wire_configuration(wire, private=private, model_uid=1234))
            for change in ({'attestationPath': '/unreviewed/proof.json'}, {'modelUid': 1}, {'modelUid': True},
                           {'socketPath': '/tmp/model.sock'}, {'enabled': 1}, {'buildIdentity': 'a' * 64}):
                with self.subTest(private=private, change=change), self.assertRaises(ValueError):
                    model.validate_wire_configuration({**wire, **change}, private=private, model_uid=1234)

    def test_wire_launcher_proof_matches_actual_node_descriptor_and_independent_attestation(self):
        manifest, _ = payload()
        config = wire_config()
        report = wire_report(manifest, config)
        model.validate_wire_attestation(report, config, manifest, 'f' * 64)
        rejected = []
        for change in ({'profile': 'search_intent'}, {'model': 'gpt-6-luna'}, {'buildIdentity': 'e' * 64},
                       {'hostPlanSha256': 'e' * 64}, {'modelUid': 1}, {'fd': 4}, {'qualityVerified': False},
                       {'sharedSlotVerified': False}, {'approved': 1}, {'dynamicToolsSha256': 'e' * 64},
                       {'descriptor': {**report['descriptor'], 'maxToolCalls': 13}},
                       {'providerCatalogue': {**report['providerCatalogue'], 'stockTools': 1}},
                       {'providerCatalogue': {**report['providerCatalogue'], 'tools': ['shell']}},
                       {'providerCatalogue': {**report['providerCatalogue'], 'sha256': 'e' * 64}}, {'extra': True}):
            bad = {**report, **change}
            with self.subTest(change=change), self.assertRaises(ValueError):
                model.validate_wire_attestation(bad, config, manifest, 'f' * 64)
            rejected.append(bad)
        script = r"""
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const input = JSON.parse(readFileSync(0, 'utf8'));
const { wireAttestationMatches } = await import(input.policyUrl);
assert.equal(wireAttestationMatches(input.report, input.config), true);
for (const report of input.rejected) assert.equal(wireAttestationMatches(report, input.config), false);
process.stdout.write('independent_wire_policy_matches\n');
"""
        result = subprocess.run(['node', '--input-type=module', '-e', script], text=True,
                                input=json.dumps({'report': report, 'rejected': rejected,
                                                  'config': {**config, 'buildIdentity': manifest['buildIdentity'], 'hostPlanSha256': 'f' * 64},
                                                  'policyUrl': (HERE.parent / 'server/hiring-wire-codex-policy.mjs').resolve().as_uri()}),
                                capture_output=True, timeout=15, env={'PATH': os.environ.get('PATH', ''), 'LANG': 'C.UTF-8'})
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('independent_wire_policy_matches', result.stdout)

    def test_wire_proof_requires_root_immutable_file_and_protected_ancestors(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp).resolve() / 'proof.json'
            path.write_text('{"synthetic":true}')
            size = path.stat().st_size
            def metadata(entry, change=None):
                change = change or {}
                if entry == path:
                    return SimpleNamespace(st_mode=stat.S_IFREG | change.get('file_mode', 0o440), st_uid=change.get('file_uid', 0),
                                           st_nlink=change.get('links', 1), st_size=change.get('size', size))
                return SimpleNamespace(st_mode=stat.S_IFDIR | change.get('parent_mode', 0o750), st_uid=change.get('parent_uid', 0))
            with patch.object(Path, 'lstat', lambda entry: metadata(entry)):
                self.assertEqual(model.read_wire_attestation(path), {'synthetic': True})
            for change in ({'file_mode': 0o640}, {'file_uid': 1234}, {'links': 2}, {'size': 16_385},
                           {'parent_mode': 0o770}, {'parent_uid': 1234}):
                with self.subTest(change=change), patch.object(Path, 'lstat', lambda entry: metadata(entry, change)), self.assertRaises(ValueError):
                    model.read_wire_attestation(path)

    def test_task_specific_static_and_observed_proof_cannot_approve_sibling_tools(self):
        configured = profiles()
        self.assertEqual(model.validate_task_profiles(configured), {'search_intent', 'company_resolution'})
        attested = profiles(attested=True)
        self.assertEqual(model.validate_task_profiles(attested, attested=True), set(configured))
        for kind in configured:
            proof = attested[kind]['toolProof']
            proof.clear()
            proof.update({'kind': 'actual_wire', 'actualWireObserved': True,
                          'toolNames': model.TASK_PROFILES[kind]['toolNames'],
                          'toolCatalogSha256': model.EMPTY_TOOL_CATALOG_SHA256 if kind == 'search_intent' else 'a' * 64})
        model.validate_task_profiles(attested, attested=True)
        for kind, change in [('search_intent', {'toolNames': ['web.run']}),
                             ('company_resolution', {'toolCatalogSha256': model.EMPTY_TOOL_CATALOG_SHA256}),
                             ('company_resolution', {'actualWireObserved': False})]:
            with self.subTest(kind=kind, change=change):
                wrong = deepcopy(attested)
                wrong[kind]['toolProof'].update(change)
                with self.assertRaises(ValueError):
                    model.validate_task_profiles(wrong, attested=True)
        wrong = profiles()
        wrong['search_intent']['toolPolicySha256'] = wrong['company_resolution']['toolPolicySha256']
        with self.assertRaises(ValueError):
            model.validate_task_profiles(wrong)
        with self.assertRaises(ValueError):
            model.validate_task_profiles({'future_task': configured['search_intent']})
        with self.assertRaises(ValueError):
            model.validate_task_profiles({})

    def test_api_environment_excludes_operator_credentials_and_fixes_storage(self):
        manifest, _ = payload()
        config = {'JUSTUP_ORIGIN': 'https://preview.example', 'JUSTUP_CSRF_SECRET': 'a' * 32,
                  'JUSTUP_CURSOR_SECRET': 'b' * 32}
        with patch.dict(os.environ, {'DOPPLER_TOKEN': 'private', 'OPENAI_API_KEY': 'private', 'DOCKER_HOST': 'private'}):
            env = launcher.child_environment(config, manifest)
        self.assertFalse({'DOPPLER_TOKEN', 'OPENAI_API_KEY', 'DOCKER_HOST'} & env.keys())
        self.assertEqual(env['JUSTUP_PORT'], '8787')
        self.assertEqual(env['JUSTUP_BUILD_ID'], manifest['buildIdentity'])
        self.assertEqual(env['JUSTUP_POLICIES_REVIEWED'], 'false')
        self.assertEqual(env['JUSTUP_SERVICES_ENABLED'], 'false')
        self.assertEqual(env['JUSTUP_SHARED_STATE'], 'true')
        self.assertEqual(env['JUSTUP_RUNNER_STATUS_PATH'], '/srv/justup_preview/state/runner-status.json')
        self.assertTrue(env['JUSTUP_DB_PATH'].startswith('/srv/justup_preview/'))
        with self.assertRaises(ValueError):
            launcher.child_environment({**config, 'DOPPLER_TOKEN': 'private'}, manifest)

    def test_admission_and_account_lifetime_are_deployment_configuration(self):
        manifest, _ = payload()
        config = {'JUSTUP_ORIGIN': 'https://justup.work', 'JUSTUP_CSRF_SECRET': 'a' * 32,
                  'JUSTUP_CURSOR_SECRET': 'b' * 32}
        default = launcher.child_environment(config, manifest)
        self.assertEqual(default['JUSTUP_REQUIRES_INVITATION'], 'true')
        self.assertNotIn('JUSTUP_ACCOUNT_TTL_MS', default)
        self.assertNotIn('JUSTUP_ACCOUNT_EXPIRES_AT', default)
        widened = {**config, 'JUSTUP_REQUIRES_INVITATION': 'false', 'JUSTUP_MAX_ACCOUNTS': 'none',
                   'JUSTUP_SESSION_TTL_MS': '604800000', 'JUSTUP_ACCOUNT_TTL_MS': 'none'}
        self.assertEqual(launcher.child_environment(widened, manifest)['JUSTUP_MAX_ACCOUNTS'], 'none')
        for change in ({'JUSTUP_DEMO_ORIGIN': config['JUSTUP_ORIGIN']}, {'JUSTUP_DB_PATH': '/tmp/other.sqlite'},
                       {'JUSTUP_REQUIRES_INVITATION': 'yes'}, {'JUSTUP_POLICIES_REVIEWED': 'yes'},
                       {'JUSTUP_MAX_ACCOUNTS': '0'}, {'JUSTUP_SESSION_TTL_MS': 'none'},
                       {'JUSTUP_ACCOUNT_EXPIRES_AT': '1.5'}, {'JUSTUP_ACCOUNT_TTL_MS': str(2 ** 53)}):
            with self.subTest(change=change), self.assertRaises(ValueError):
                launcher.child_environment({**config, **change}, manifest)

    def test_api_configuration_rejects_aliases_links_and_nonprivate_modes(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp).resolve()
            directory = root / 'real'
            directory.mkdir()
            path = directory / 'api.json'
            path.write_text('{}')
            path.chmod(0o600)
            self.assertEqual(launcher.read_configuration(path), {})
            alias = root / 'alias'
            alias.symlink_to(directory)
            with self.assertRaises(ValueError):
                launcher.read_configuration(alias / path.name)
            link = root / 'linked.json'
            os.link(path, link)
            with self.assertRaises(ValueError):
                launcher.read_configuration(path)
            link.unlink()
            path.chmod(0o640)
            with self.assertRaises(ValueError):
                launcher.read_configuration(path)

    def test_api_cannot_start_during_pending_upgrade_or_withdrawn_receipt(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp).resolve()
            release = base / 'releases' / ('a' * 64)
            release.mkdir(parents=True)
            (base / 'current').symlink_to(release)
            for condition in ('withdrawn-receipt', 'pending-upgrade'):
                if condition == 'pending-upgrade':
                    (base / '.preview-ops-upgrade.lock').write_text('pending fixture')
                with self.subTest(condition=condition), patch.object(launcher, 'BASE', base), \
                        patch.object(launcher, 'module', return_value=artifact), \
                        patch.object(launcher, 'read_configuration', side_effect=AssertionError('startup must stop before private config')):
                    self.assertEqual(launcher.main(), 1)
    def test_queue_boundary_records_uninitialized_private_ledger_and_no_frontend_build(self):
        root = HERE.parent
        plan = host.plan(root, 'a' * 64)
        ledger = plan['cumulativeJevLedger']
        self.assertEqual(ledger['owner'], host.RUNNER_USER)
        self.assertFalse(ledger['initializedByInstaller'])
        self.assertFalse(ledger['restoredWithDatabase'])
        self.assertEqual(ledger['maximumApprovedNanodollars'], 500000000)
        unit = (root / 'deploy/justup-preview/justup-preview-runner.service').read_text()
        self.assertIn('Slice=justup-preview.slice', unit)
        self.assertIn('UMask=0007', unit)
        self.assertIn('-/srv/justup_preview/model', unit)
        self.assertIn('-/srv/justup_preview/config', unit)
        self.assertNotIn('[Install]', unit)
        self.assertNotIn('npm', unit)
        api = (root / 'deploy/justup-preview/justup-preview-api.service').read_text()
        self.assertIn('-/srv/justup_preview/queue', api)

    def test_queue_pins_source_state_model_and_ledger_paths_without_inheriting_credentials(self):
        manifest, _ = payload()
        config = {'dbPath': '/srv/justup_preview/state/preview.sqlite', 'sharedState': True,
                  'runnerStatusPath': '/srv/justup_preview/state/runner-status.json',
                  'jev': {'enabled': True, 'cumulativeBudget': {'path': str(queue.LEDGER_PATH),
                           'excludedDirectories': ['/srv/justup_preview/state', '/srv/justup_preview/state/backups'],
                           'approval': {'resourceId': queue.BUDGET_RESOURCE, 'resourceSlug': 'jev-evaluation-budget'}}}}
        self.assertIs(queue.validate_configuration(config, manifest), config)
        model = {'enabled': True, 'cliVersion': artifact.CODEX_VERSION, 'isolationVerified': True,
                 'socketPath': '/srv/justup_preview/broker/model.sock',
                 'attestationPath': '/srv/justup_preview/broker/isolation-reviewed.json',
                 'taskProfiles': profiles(), 'companyResearchVerified': True}
        queue.validate_configuration({**config, 'model': model}, manifest)
        with self.assertRaises(ValueError):
            queue.validate_configuration({**config, 'model': {**model, 'toolCatalogSha256': 'c' * 64}}, manifest)
        for change in ({'sourceCommit': manifest['sourceCommit']}, {'buildIdentity': manifest['buildIdentity']},
                       {'hostPlanSha256': 'f' * 64}, {'model': {'buildIdentity': manifest['buildIdentity']}},
                       {'sharedState': False}, {'dbPath': '/private/production.sqlite'},
                       {'model': {'socketPath': '/tmp/other.sock'}}, {'command': 'arbitrary'},
                       {'jev': {'enabled': True, 'cumulativeBudget': {'path': '/srv/justup_preview/state/ledger'}}}):
            with self.subTest(change=change), self.assertRaises(ValueError):
                queue.validate_configuration({**config, **change}, manifest)
        with patch.dict(os.environ, {'TYPESAFE_AI_TOKEN': 'private', 'OPENAI_API_KEY': 'private', 'DOPPLER_TOKEN': 'private'}):
            env = queue.child_environment(manifest, 'f' * 64)
        self.assertFalse({'TYPESAFE_AI_TOKEN', 'OPENAI_API_KEY', 'DOPPLER_TOKEN'} & env.keys())
        self.assertEqual(env['JUSTUP_RUNNER_CONFIG'], str(queue.CONFIG_PATH))
        self.assertEqual(env['JUSTUP_SOURCE_COMMIT'], manifest['sourceCommit'])
        self.assertEqual(env['JUSTUP_BUILD_ID'], manifest['buildIdentity'])
        self.assertEqual(env['JUSTUP_HOST_PLAN_SHA256'], 'f' * 64)

    def test_queue_requires_existing_private_ledger_and_never_creates_or_repairs_it(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp).resolve()
            root.chmod(0o700)
            ledger = root / 'jev.jsonl'
            with self.assertRaises(FileNotFoundError):
                queue.validate_ledger(ledger)
            self.assertFalse(ledger.exists())
            ledger.write_bytes(b'{"kind":"approval"}\n')
            ledger.chmod(0o600)
            original = ledger.read_bytes()
            queue.validate_ledger(ledger)
            for unsafe in (0o640, 0o4600):
                ledger.chmod(unsafe)
                with self.assertRaises(ValueError):
                    queue.validate_ledger(ledger)
                self.assertEqual(ledger.read_bytes(), original)
            ledger.chmod(0o600)
            link = root / 'other.jsonl'
            link.symlink_to(ledger)
            with self.assertRaises(ValueError):
                queue.validate_ledger(link)

    def test_budget_identity_defaults_canonical_and_requires_explicit_exact_legacy_selection(self):
        canonical = {'approval': {'resourceId': queue.BUDGET_RESOURCE, 'resourceSlug': 'jev-evaluation-budget'}}
        self.assertEqual(queue.budget_identity(canonical), canonical['approval'])
        legacy = {'identityProfile': 'legacy-v1',
                  'approval': {'resourceId': queue.BUDGET_RESOURCE, 'resourceSlug': 'demo-jev-evaluation-budget'}}
        self.assertEqual(queue.budget_identity(legacy), legacy['approval'])
        for config in ({'approval': legacy['approval']}, {**legacy, 'identityProfile': 'canonical-v1'},
                       {**canonical, 'identityProfile': 'legacy-v1'}, {**canonical, 'identityProfile': None},
                       {**canonical, 'identityProfile': 'legacy'}, {**canonical, 'identityProfile': 'legacy-demo-v1'},
                       {**canonical, 'resetLedger': True},
                       {'approval': {**canonical['approval'], 'resourceId': 'https://other.example/approval'}}):
            with self.subTest(config=config), self.assertRaises(ValueError):
                queue.budget_identity(config)

    def test_selected_budget_header_check_preserves_existing_canonical_and_legacy_ledger_bytes(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp).resolve()
            root.chmod(0o700)
            ledger = root / 'jev.jsonl'
            for profile, slug in queue.BUDGET_IDENTITIES.items():
                header = {'schemaVersion': 1, 'kind': 'approval', 'resourceId': queue.BUDGET_RESOURCE, 'resourceSlug': slug,
                          'ledgerId': 'fixture-identity', 'approvalId': 'fixture-human-record', 'capNanodollars': 500000000}
                original = (json.dumps(header, separators=(',', ':')) + '\n{"kind":"reserve","reservedNanodollars":2688000}\n').encode()
                ledger.write_bytes(original)
                ledger.chmod(0o600)
                identity = queue.budget_identity({'identityProfile': profile, 'approval': header})
                queue.validate_ledger(ledger, expected_identity=identity)
                self.assertEqual(ledger.read_bytes(), original)
                wrong = {**identity, 'resourceSlug': 'jev-evaluation-budget' if profile == 'legacy-v1' else 'demo-jev-evaluation-budget'}
                with self.assertRaisesRegex(ValueError, 'selected exact budget identity'):
                    queue.validate_ledger(ledger, expected_identity=wrong)
                self.assertEqual(ledger.read_bytes(), original)

    def test_policy_gate_requires_reviewed_urls_and_version(self):
        manifest, _ = payload()
        config = {'JUSTUP_ORIGIN': 'https://preview.example', 'JUSTUP_CSRF_SECRET': 'a' * 32,
                  'JUSTUP_CURSOR_SECRET': 'b' * 32, 'JUSTUP_POLICIES_REVIEWED': 'true'}
        with self.assertRaises(ValueError):
            launcher.child_environment(config, manifest)

    def test_logs_keep_only_metadata_and_enforce_byte_and_age_limits(self):
        event = {'category': 'read', 'status': 200, 'durationMs': 2, 'query': 'private query',
                 'password': 'private password', 'ip': '203.0.113.1', 'error': 'raw provider response'}
        result = launcher.safe_log(event)
        self.assertEqual(result['category'], 'read')
        self.assertFalse(set(event) - {'category', 'status', 'durationMs'} & result.keys())
        self.assertIsNone(launcher.safe_log({'query': 'private'}))
        with tempfile.TemporaryDirectory() as temp:
            folder = Path(temp)
            old = folder / 'api-20000101.jsonl'
            old.write_text('old diagnostic')
            os.utime(old, (0, 0))
            launcher.log_event(event, folder)
            self.assertFalse(old.exists())
            today = next(folder.glob('*.jsonl'))
            self.assertNotIn('private', today.read_text())
            before = today.read_bytes()
            with patch.object(launcher, 'MAX_LOG_BYTES', len(before)):
                launcher.log_event(event, folder)
            self.assertEqual(today.read_bytes(), before)


class RecoveryContracts(unittest.TestCase):
    def fixture(self, root):
        folder = root / 'backups'
        folder.mkdir()
        barrier = root / 'private-generation'
        barrier.write_text(str(uuid.uuid4()) + '\n')
        db = root / 'preview.sqlite'
        with sqlite3.connect(db) as conn:
            conn.execute('CREATE TABLE private_records (value TEXT)')
            conn.execute('INSERT INTO private_records VALUES (?)', ('private fixture',))
        return db, folder, barrier

    def make_backup(self, db, folder, barrier, now=1000):
        info = recovery.backup(db, folder, barrier, 'a' * 40, 'b' * 64, now=now)
        return folder / info['backup']

    def test_backup_uses_consistent_sqlite_and_refuses_predeletion_restore(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            db, folder, barrier = self.fixture(root)
            snapshot = self.make_backup(db, folder, barrier)
            recovery.validate_restore(snapshot, barrier, now=1001)
            with sqlite3.connect(snapshot) as conn:
                self.assertEqual(conn.execute('SELECT value FROM private_records').fetchone(), ('private fixture',))
            barrier.write_text(str(uuid.uuid4()) + '\n')
            with self.assertRaisesRegex(ValueError, 'private deletion'):
                recovery.validate_restore(snapshot, barrier, now=1001)

    def test_backup_refuses_rotated_generation_until_sql_deletion_commits(self):
        # Reproduce the real SQLite WAL timing: the barrier rotates before SQL
        # commit, so readers can still see the deleted record under the NEW UUID.
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            db, folder, barrier = self.fixture(root)
            writer = sqlite3.connect(db)
            writer.execute('PRAGMA journal_mode=WAL')
            writer.execute('BEGIN IMMEDIATE')
            pending = barrier.with_name(barrier.name + '.pending')
            pending.write_text(str(uuid.uuid4()) + '\n')
            barrier.write_text(str(uuid.uuid4()) + '\n')
            writer.execute('DELETE FROM private_records')
            with sqlite3.connect(db) as reader:
                self.assertEqual(reader.execute('SELECT count(*) FROM private_records').fetchone()[0], 1)
            with self.assertRaisesRegex(ValueError, 'transaction is pending'):
                self.make_backup(db, folder, barrier)
            self.assertEqual(list(folder.iterdir()), [])
            writer.commit()
            writer.close()
            # Only the transaction owner removes/fsyncs this after COMMIT.
            pending.unlink()
            snapshot = self.make_backup(db, folder, barrier)
            with sqlite3.connect(snapshot) as reader:
                self.assertEqual(reader.execute('SELECT count(*) FROM private_records').fetchone()[0], 0)

    def test_retained_pending_marker_blocks_backup_and_restore_after_crash(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            db, folder, barrier = self.fixture(root)
            snapshot = self.make_backup(db, folder, barrier)
            pending = barrier.with_name(barrier.name + '.pending')
            pending.write_text(str(uuid.uuid4()) + '\n')
            with self.assertRaisesRegex(ValueError, 'crash recovery'):
                recovery.validate_restore(snapshot, barrier, now=1001)
            with self.assertRaisesRegex(ValueError, 'crash recovery'):
                self.make_backup(db, folder, barrier)

    def test_generation_rotation_around_pending_absence_check_is_rejected(self):
        with tempfile.TemporaryDirectory() as temp:
            barrier = Path(temp) / 'private-generation'
            with patch.object(recovery, 'generation', side_effect=[str(uuid.uuid4()), str(uuid.uuid4())]):
                with self.assertRaisesRegex(ValueError, 'checking transaction state'):
                    recovery.stable_generation(barrier)

    def test_generation_race_discards_snapshot_and_metadata(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            db, folder, barrier = self.fixture(root)
            with patch.object(recovery, 'stable_generation', side_effect=[str(uuid.uuid4()), str(uuid.uuid4())]):
                with self.assertRaisesRegex(ValueError, 'changed during backup'):
                    self.make_backup(db, folder, barrier)
            self.assertEqual(list(folder.iterdir()), [])

    def test_missing_barrier_and_corrupt_snapshot_fail_closed(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            db, folder, barrier = self.fixture(root)
            snapshot = self.make_backup(db, folder, barrier)
            snapshot.write_bytes(b'corrupt')
            with self.assertRaises(ValueError):
                recovery.validate_restore(snapshot, barrier, now=1001)
            barrier.unlink()
            with self.assertRaisesRegex(ValueError, 'barrier'):
                recovery.validate_restore(snapshot, barrier, now=1001)

    def test_restore_requires_auth_receipt_and_never_overwrites_live_generation(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            ledger = root / 'queue/budget/jev.jsonl'
            ledger.parent.mkdir(parents=True)
            ledger.write_bytes(b'{"kind":"approval"}\n{"kind":"reserve","reservedNanodollars":2688000}\n')
            crash_lock = ledger.with_name(ledger.name + '.lock')
            crash_lock.write_bytes(b'')
            cumulative_before = ledger.read_bytes()
            db, folder, barrier = self.fixture(root)
            snapshot = self.make_backup(db, folder, barrier)
            before = barrier.read_bytes()
            destination = root / 'restored.sqlite'
            good = "import json; print(json.dumps({'schemaVersion':1,'sessionsInvalidated':True,'remainingSessions':0,'sessionsDeleted':2}))"
            result = recovery.restore(snapshot, barrier, destination, [sys.executable, '-c', good], now=1001)
            self.assertTrue(result['sessionsInvalidated'])
            self.assertFalse(result['activated'])
            self.assertEqual(barrier.read_bytes(), before)
            self.assertEqual(ledger.read_bytes(), cumulative_before)
            self.assertTrue(crash_lock.exists())
            self.assertFalse(any('jev' in p.name for p in folder.iterdir()))
            destination.unlink()
            with self.assertRaises(ValueError):
                recovery.restore(snapshot, barrier, destination, [sys.executable, '-c', 'print(\"{}\")'], now=1001)
            self.assertFalse(destination.exists())

    def test_generation_changed_by_preparation_discards_restore(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            db, folder, barrier = self.fixture(root)
            snapshot = self.make_backup(db, folder, barrier)
            destination = root / 'restored.sqlite'
            command = "from pathlib import Path; import uuid,json; Path(" + repr(str(barrier)) + ").write_text(str(uuid.uuid4())+'\\n'); print(json.dumps({'schemaVersion':1,'sessionsInvalidated':True,'remainingSessions':0,'sessionsDeleted':0}))"
            with self.assertRaisesRegex(ValueError, 'changed during restore'):
                recovery.restore(snapshot, barrier, destination, [sys.executable, '-c', command], now=1001)
            self.assertFalse(destination.exists())

    def test_flat_directory_age_and_two_snapshot_retention(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            db, folder, barrier = self.fixture(root)
            old = self.make_backup(db, folder, barrier, now=1000)
            os.utime(old, (1000, 1000))
            recovery.prune(folder, now=1000 + 8 * 86400)
            self.assertEqual(list(folder.iterdir()), [])
            (folder / 'nested').mkdir()
            with self.assertRaisesRegex(ValueError, 'flat'):
                self.make_backup(db, folder, barrier)


class HTTPVerificationContracts(unittest.TestCase):
    def test_https_redirect_cannot_downgrade_or_leave_the_fixed_origin(self):
        handler = http.FixedOriginRedirect()
        request = Request('https://preview.example/api/v1/health')
        for target in ('http://preview.example/api/v1/health', 'https://other.example/api/v1/health'):
            with self.subTest(target=target), self.assertRaisesRegex(ValueError, 'origin'):
                handler.redirect_request(request, None, 302, 'Found', {}, target)

    def responses(self):
        manifest, _ = payload()
        values = {'/api/v1/health': {'ready': True},
                  '/api/v1/version': {'sourceCommit': manifest['sourceCommit'], 'buildIdentity': manifest['buildIdentity'], 'schemaVersion': 1,
                                      'runner': {'ready': False, 'identity': None}, 'importGeneration': None},
                  '/api/v1/session': {'user': None, 'access': {'kind': 'guest', 'fullAccess': False, 'billingEnabled': False},
                                      'capabilities': {name: False for name in ('sse', 'follows', 'viewed', 'preferences', 'hiddenMatchCounts')}}}
        def fetch(url, as_json=True):
            return deepcopy(values[url.removeprefix('http://127.0.0.1:8787')]), {'cache-control': 'private, no-store', 'x-robots-tag': 'noindex, nofollow'}
        return manifest, values, fetch

    def test_process_evidence_is_not_shareable_and_mismatched_build_fails(self):
        manifest, values, fetch = self.responses()
        report = http.verify('http://127.0.0.1:8787', manifest, 'process', fetch=fetch)
        self.assertTrue(report['passed'])
        self.assertFalse(report['shareable'])
        self.assertFalse(report['completeReleaseGate'])
        values['/api/v1/version']['buildIdentity'] = 'different'
        with self.assertRaisesRegex(ValueError, 'identity differs'):
            http.verify('http://127.0.0.1:8787', manifest, 'process', fetch=fetch)

    def test_missing_real_runner_blocks_preview_even_when_process_passes(self):
        manifest, values, fetch = self.responses()
        def secure_fetch(url, as_json=True):
            return fetch(url.replace('https://preview.example', 'http://127.0.0.1:8787'), as_json)
        with self.assertRaisesRegex(ValueError, 'runner readiness'):
            http.verify('https://preview.example', manifest, 'preview', runner_identity='runner', fetch=secure_fetch)

    def test_full_http_evidence_requires_fresh_projection_policies_and_noindex(self):
        manifest, values, _ = self.responses()
        values['/api/v1/version'].update({'runner': {'ready': True, 'identity': 'runner-build'}, 'importGeneration': 'import-generation'})
        values['/api/v1/session'].update({'serverTime': '2026-10-31T18:00:00Z', 'coverage': {'stale': False},
            'policies': {'reviewed': True, 'version': 'approved-v1', 'privacyUrl': 'https://preview.example/privacy', 'usageUrl': 'https://preview.example/usage'}})
        values['/api/v1/session']['capabilities'].update({name: True for name in http.FIRST_RELEASE_CAPABILITIES})
        values['/api/v1/jobs?limit=12'] = {'items': [{'firstObserved': '2026-10-28T18:00:00Z', 'sourceUrl': 'https://employer.example/role'}]}
        def fetch(url, as_json=True):
            path = url.removeprefix('https://preview.example')
            if not as_json:
                return '<html>candidate</html>', {'x-robots-tag': 'noindex, nofollow'}
            return deepcopy(values[path]), {'cache-control': 'private, no-store', 'x-robots-tag': 'noindex, nofollow'}
        frontend = {'sourceSha': manifest['sourceCommit'], 'treeSha': manifest['sourceTree'],
                    'assetsSha256': 'c' * 64, 'workerSha256': 'd' * 64, 'artifactSha256': 'e' * 64}
        runtime = {'publicOrigin': 'https://preview.example', 'apiOrigin': 'https://api.example',
                   'apiPrefix': '/api/v1', 'deploymentMode': 'preview'}
        runtime_sha = hashlib.sha256(json.dumps(runtime, separators=(',', ':')).encode()).hexdigest()
        configuration = {'vars': {'PUBLIC_ORIGIN': runtime['publicOrigin'], 'API_ORIGIN': runtime['apiOrigin'],
                                  'DEPLOYMENT_MODE': 'preview', 'RUNTIME_CONFIG_SHA256': runtime_sha,
                                  'RELEASE_JSON': json.dumps(frontend)}}
        deployed = {**frontend, 'runtimeConfigSha256': runtime_sha, 'apiPrefix': '/api/v1', 'deploymentMode': 'preview'}
        options = {'runner_identity': 'runner-build', 'import_generation': 'import-generation', 'policy_version': 'approved-v1',
                   'fetch': fetch, 'frontend_release': frontend, 'frontend_config': configuration}
        values['/__release/version'] = dict(deployed)
        for change in ({'DEPLOYMENT_MODE': 'production'}, {'DEPLOYMENT_MODE': ''}, {'PUBLIC_ORIGIN': 'https://other.example'},
                       {'API_ORIGIN': 'https://api2.example'}, {'RUNTIME_CONFIG_SHA256': 'f' * 64},
                       {'API_ORIGIN': 'https://api.example/'}, {'API_ORIGIN': runtime['publicOrigin']},
                       {'RELEASE_JSON': json.dumps({**frontend, 'artifactSha256': 'f' * 64})}):
            wrong_config = {'vars': {**configuration['vars'], **change}}
            with self.subTest(change=change), self.assertRaises(ValueError):
                http.verify('https://preview.example', manifest, 'preview', **{**options, 'frontend_config': wrong_config})
        for field, value in (('deploymentMode', 'production'), ('runtimeConfigSha256', 'f' * 64), ('apiPrefix', '/other')):
            values['/__release/version'][field] = value
            with self.subTest(field=field), self.assertRaisesRegex(ValueError, 'frontend identity differs'):
                http.verify('https://preview.example', manifest, 'preview', **options)
            values['/__release/version'] = dict(deployed)
        with self.assertRaisesRegex(ValueError, 'runtime configuration'):
            http.verify('https://preview.example', manifest, 'preview', **{**options, 'frontend_config': None})
        report = http.verify('https://preview.example', manifest, 'preview', **options)
        self.assertIn('fresh_guest_public_projection', report['checks'])
        self.assertFalse(report['completeReleaseGate'])
        self.assertFalse(report['shareable'])
        self.assertEqual(report['frontend'], deployed)
        with self.assertRaisesRegex(ValueError, 'built frontend'):
            http.verify('https://preview.example', manifest, 'preview', **{**options, 'frontend_release': None})
        values['/__release/version']['artifactSha256'] = 'f' * 64
        with self.assertRaisesRegex(ValueError, 'frontend identity differs'):
            http.verify('https://preview.example', manifest, 'preview', **options)
        values['/__release/version'] = dict(deployed)
        for change in ({'firstObserved': '2026-10-31T17:00:00Z'}, {'description': 'must stay internal'}):
            with self.subTest(change=change):
                original = deepcopy(values['/api/v1/jobs?limit=12']['items'][0])
                values['/api/v1/jobs?limit=12']['items'][0].update(change)
                with self.assertRaises(ValueError):
                    http.verify('https://preview.example', manifest, 'preview', **options)
                values['/api/v1/jobs?limit=12']['items'][0] = original
        for name in http.FIRST_RELEASE_CAPABILITIES:
            values['/api/v1/session']['capabilities'][name] = False
            with self.subTest(capability=name), self.assertRaisesRegex(ValueError, 'unavailable'):
                http.verify('https://preview.example', manifest, 'preview', **options)
            values['/api/v1/session']['capabilities'][name] = True

    def test_cacheable_or_indexable_api_fails_in_both_deployment_states(self):
        manifest, values, fetch = self.responses()
        def cached(url, as_json=True):
            value, headers = fetch(url, as_json)
            return value, {'cache-control': 'public, max-age=60'}
        with self.assertRaisesRegex(ValueError, 'cached'):
            http.verify('http://127.0.0.1:8787', manifest, 'process', fetch=cached)
        def indexable(url, as_json=True):
            value, headers = fetch(url, as_json)
            return value, {'cache-control': 'private, no-store'}
        with self.assertRaisesRegex(ValueError, 'indexing'):
            http.verify('http://127.0.0.1:8787', manifest, 'process', fetch=indexable)
        values['/api/v1/session']['capabilities']['sse'] = True
        self.assertTrue(http.verify('http://127.0.0.1:8787', manifest, 'process', fetch=fetch)['passed'])


if __name__ == '__main__':
    unittest.main(verbosity=2)
