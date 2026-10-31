#!/usr/bin/env python3
"""Observable artifact, boundary, privacy and recovery contracts; no remote writes."""
from __future__ import annotations

from copy import deepcopy
from datetime import datetime, timezone
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch
import uuid

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


def payload():
    files = {'runtime/bin/node': b'fixture runtime', 'runtime/LICENSE': b'fixture license',
             'app/server/main.mjs': b'export const ready = true;'}
    files.update({'app/server/' + name + '.mjs': b'export {};' for name in ('auth', 'http', 'store', 'feed', 'tasks')})
    manifest = {'formatVersion': 1, 'sourceCommit': 'a' * 40, 'sourceTree': 'b' * 40,
                'schemaVersion': 1, 'nodeVersion': '24.22.2', 'platform': 'linux-arm64',
                'nodeArchiveSha256': artifact.NODE_ARCHIVE_SHA256, 'entrypoint': 'app/server/main.mjs',
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
    def test_backend_inventory_excludes_browser_sources_build_tools_and_dependencies(self):
        for path in ('app/web/dist/index.html', 'app/web/src/app.tsx', 'app/prototype/app.mjs',
                     'app/package.json', 'app/node_modules/react/index.js', 'app/scripts/frontend-prepare.mjs'):
            with self.subTest(path=path):
                self.assertFalse(artifact.allowed(path))
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
        for key, value in [('sourceCommit', 'dev'), ('nodeVersion', '22'), ('platform', 'linux-x64'), ('buildIdentity', '0' * 64)]:
            with self.subTest(key=key):
                candidate = deepcopy(original)
                candidate[key] = value
                with self.assertRaises(ValueError):
                    artifact.validate_manifest(candidate)

    def test_deployed_inventory_is_readonly_complete_and_not_a_moving_link(self):
        manifest, files = payload()
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp) / 'release'
            root.mkdir()
            for name, value in {**files, 'manifest.json': json.dumps(manifest).encode()}.items():
                path = root / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(value)
                path.chmod(0o444)
            self.assertEqual(artifact.verify_directory(root)['buildIdentity'], manifest['buildIdentity'])
            (root / 'app/server/main.mjs').chmod(0o644)
            with self.assertRaisesRegex(ValueError, 'read-only'):
                artifact.verify_directory(root)
            link = Path(temp) / 'current'
            link.symlink_to(root)
            with self.assertRaisesRegex(ValueError, 'moving symlink'):
                artifact.verify_directory(link)


class BoundaryContracts(unittest.TestCase):
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

    def test_api_environment_excludes_operator_credentials_and_fixes_storage(self):
        manifest, _ = payload()
        config = {'JUSTUP_DEMO_ORIGIN': 'https://preview.example', 'JUSTUP_DEMO_CSRF_SECRET': 'a' * 32,
                  'JUSTUP_DEMO_CURSOR_SECRET': 'b' * 32}
        with patch.dict(os.environ, {'DOPPLER_TOKEN': 'private', 'OPENAI_API_KEY': 'private', 'DOCKER_HOST': 'private'}):
            env = launcher.child_environment(config, manifest)
        self.assertFalse({'DOPPLER_TOKEN', 'OPENAI_API_KEY', 'DOCKER_HOST'} & env.keys())
        self.assertEqual(env['JUSTUP_DEMO_PORT'], '8787')
        self.assertEqual(env['JUSTUP_DEMO_BUILD_ID'], manifest['buildIdentity'])
        self.assertEqual(env['JUSTUP_DEMO_POLICIES_REVIEWED'], 'false')
        self.assertEqual(env['JUSTUP_DEMO_SERVICES_ENABLED'], 'false')
        self.assertEqual(env['JUSTUP_DEMO_SHARED_STATE'], 'true')
        self.assertEqual(env['JUSTUP_DEMO_RUNNER_STATUS_PATH'], '/srv/justup_preview/state/runner-status.json')
        self.assertTrue(env['JUSTUP_DEMO_DB_PATH'].startswith('/srv/justup_preview/'))
        with self.assertRaises(ValueError):
            launcher.child_environment({**config, 'DOPPLER_TOKEN': 'private'}, manifest)

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
                  'sourceCommit': manifest['sourceCommit'], 'buildIdentity': manifest['buildIdentity'],
                  'jev': {'enabled': True, 'cumulativeBudget': {'path': str(queue.LEDGER_PATH),
                           'excludedDirectories': ['/srv/justup_preview/state', '/srv/justup_preview/state/backups']}}}
        self.assertIs(queue.validate_configuration(config, manifest), config)
        for change in ({'sourceCommit': 'c' * 40}, {'sharedState': False}, {'dbPath': '/private/production.sqlite'},
                       {'model': {'socketPath': '/tmp/other.sock'}}, {'command': 'arbitrary'},
                       {'jev': {'enabled': True, 'cumulativeBudget': {'path': '/srv/justup_preview/state/ledger'}}}):
            with self.subTest(change=change), self.assertRaises(ValueError):
                queue.validate_configuration({**config, **change}, manifest)
        with patch.dict(os.environ, {'TYPESAFE_AI_TOKEN': 'private', 'OPENAI_API_KEY': 'private', 'DOPPLER_TOKEN': 'private'}):
            env = queue.child_environment()
        self.assertFalse({'TYPESAFE_AI_TOKEN', 'OPENAI_API_KEY', 'DOPPLER_TOKEN'} & env.keys())
        self.assertEqual(env['JUSTUP_DEMO_RUNNER_CONFIG'], str(queue.CONFIG_PATH))

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

    def test_policy_gate_requires_reviewed_urls_and_version(self):
        manifest, _ = payload()
        config = {'JUSTUP_DEMO_ORIGIN': 'https://preview.example', 'JUSTUP_DEMO_CSRF_SECRET': 'a' * 32,
                  'JUSTUP_DEMO_CURSOR_SECRET': 'b' * 32, 'JUSTUP_DEMO_POLICIES_REVIEWED': 'true'}
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
    def responses(self):
        manifest, _ = payload()
        values = {'/api/v1/health': {'ready': True},
                  '/api/v1/version': {'sourceCommit': manifest['sourceCommit'], 'buildIdentity': manifest['buildIdentity'], 'schemaVersion': 1,
                                      'runner': {'ready': False, 'identity': None}, 'importGeneration': None},
                  '/api/v1/session': {'user': None, 'access': {'kind': 'guest', 'fullAccess': False, 'billingEnabled': False},
                                      'capabilities': {name: False for name in ('sse', 'follows', 'viewed', 'preferences', 'hiddenMatchCounts')}}}
        def fetch(url, as_json=True):
            return deepcopy(values[url.removeprefix('http://127.0.0.1:8787')]), {'cache-control': 'private, no-store'}
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
        values['/api/v1/session']['capabilities'].update({'search': True, 'companyRequests': True})
        values['/api/v1/jobs?limit=12'] = {'items': [{'firstObserved': '2026-10-28T18:00:00Z', 'sourceUrl': 'https://employer.example/role'}]}
        def fetch(url, as_json=True):
            path = url.removeprefix('https://preview.example')
            if not as_json:
                return '<html>candidate</html>', {'x-robots-tag': 'noindex, nofollow'}
            return deepcopy(values[path]), {'cache-control': 'private, no-store'}
        frontend = {'sourceSha': manifest['sourceCommit'], 'treeSha': manifest['sourceTree'],
                    'assetsSha256': 'c' * 64, 'workerSha256': 'd' * 64, 'artifactSha256': 'e' * 64}
        values['/__preview/version'] = dict(frontend)
        options = {'runner_identity': 'runner-build', 'import_generation': 'import-generation', 'policy_version': 'approved-v1',
                   'fetch': fetch, 'frontend_release': frontend}
        report = http.verify('https://preview.example', manifest, 'preview', **options)
        self.assertIn('fresh_guest_public_projection', report['checks'])
        self.assertFalse(report['completeReleaseGate'])
        self.assertFalse(report['shareable'])
        self.assertEqual(report['frontend'], frontend)
        with self.assertRaisesRegex(ValueError, 'built frontend'):
            http.verify('https://preview.example', manifest, 'preview', **{**options, 'frontend_release': None})
        values['/__preview/version']['artifactSha256'] = 'f' * 64
        with self.assertRaisesRegex(ValueError, 'frontend identity differs'):
            http.verify('https://preview.example', manifest, 'preview', **options)
        values['/__preview/version'] = dict(frontend)
        for change in ({'firstObserved': '2026-10-31T17:00:00Z'}, {'description': 'must stay internal'}):
            with self.subTest(change=change):
                original = deepcopy(values['/api/v1/jobs?limit=12']['items'][0])
                values['/api/v1/jobs?limit=12']['items'][0].update(change)
                with self.assertRaises(ValueError):
                    http.verify('https://preview.example', manifest, 'preview', **options)
                values['/api/v1/jobs?limit=12']['items'][0] = original
        values['/api/v1/session']['capabilities']['search'] = False
        with self.assertRaisesRegex(ValueError, 'unavailable'):
            http.verify('https://preview.example', manifest, 'preview', **options)

    def test_cached_session_and_overclaimed_disabled_feature_fail(self):
        manifest, values, fetch = self.responses()
        def cached(url, as_json=True):
            value, headers = fetch(url, as_json)
            return value, {'cache-control': 'public, max-age=60'}
        with self.assertRaisesRegex(ValueError, 'cached'):
            http.verify('http://127.0.0.1:8787', manifest, 'process', fetch=cached)
        values['/api/v1/session']['capabilities']['sse'] = True
        with self.assertRaisesRegex(ValueError, 'unavailable'):
            http.verify('http://127.0.0.1:8787', manifest, 'process', fetch=fetch)


if __name__ == '__main__':
    unittest.main(verbosity=2)
