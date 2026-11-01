"""Bounded local transport, replay and exact-import acknowledgement contracts."""
from __future__ import annotations

from contextlib import closing
from datetime import datetime, timedelta, timezone
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import test_import_jobs as IMPORT_FIXTURES

SPEC = importlib.util.spec_from_file_location('preview_feed', Path(__file__).with_name('preview-feed.py'))
FEED = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(FEED)
REAL_BIND_CANDIDATE = FEED.bind_candidate_build
BATCH_ID = '1' * 32
SHA = 'a' * 64


def source_files(directory, *, complete=False, body=b'{"schemaVersion":1,"rows":[{}]}'):
    directory = Path(directory)
    batch = directory / f'batch-{BATCH_ID}'
    batch.mkdir(mode=0o700)
    part_name = 'part-0001.json'
    manifest_name = 'manifest.json'
    part = batch / part_name
    part.write_bytes(body)
    part.chmod(0o600)
    manifest = {'schemaVersion': 1, 'kind': 'changes', 'complete': complete,
                'rows': 1, 'parts': [{'file': part_name,
                                      'sha256': hashlib.sha256(body).hexdigest(), 'rows': 1}]}
    path = batch / manifest_name
    path.write_text(json.dumps(manifest, separators=(',', ':')))
    path.chmod(0o600)
    return path, part, manifest


class TransportTests(unittest.TestCase):
    def test_socket_is_restricted_and_actual_receiver_is_confined_to_the_slice(self):
        root = Path(__file__).resolve().parents[1]
        socket_unit = (root / 'deploy/justup-preview/justup-preview-feed.socket').read_text()
        service_unit = (root / 'deploy/justup-preview/justup-preview-feed@.service').read_text()
        self.assertIn('SocketUser=justup-deploy', socket_unit)
        self.assertIn('SocketMode=0600', socket_unit)
        self.assertIn('Accept=yes', socket_unit)
        self.assertIn('MaxConnections=1', socket_unit)
        self.assertIn('User=justup-preview-api', service_unit)
        self.assertIn('Slice=justup-preview.slice', service_unit)
        self.assertIn('StandardInput=socket', service_unit)
        self.assertIn('ReadWritePaths=/srv/justup_preview/state/feed-inbox', service_unit)
        self.assertIn('RestrictAddressFamilies=AF_UNIX', service_unit)
        self.assertIn('ExecStart=/usr/bin/python3 /srv/justup_preview/ops/preview-feed.py receive', service_unit)

    def test_private_stage_round_trip_and_exact_replay_have_no_early_receipt(self):
        with tempfile.TemporaryDirectory() as root:
            source = Path(root).resolve() / 'source'
            inbox = Path(root).resolve() / 'inbox'
            source.mkdir(mode=0o700)
            inbox.mkdir(mode=0o700)
            manifest, part, _ = source_files(source)
            wire = io.BytesIO()
            FEED.send(manifest, wire)
            payload = wire.getvalue()
            result = FEED.receive(io.BytesIO(payload), inbox, os.geteuid())
            self.assertEqual(result['status'], 'staged')
            self.assertFalse(result['acknowledgeable'])
            staged = inbox / f'batch-{BATCH_ID}'
            self.assertEqual((staged / 'manifest.json').read_bytes(), manifest.read_bytes())
            self.assertEqual((staged / part.name).read_bytes(), part.read_bytes())
            self.assertEqual((staged / part.name).stat().st_mode & 0o777, 0o600)
            self.assertFalse((staged / 'stage-receipt.json').exists())
            self.assertEqual(FEED.receive(io.BytesIO(payload), inbox, os.geteuid())['status'], 'already_staged')
            self.assertEqual([item.name for item in inbox.iterdir() if item.name.startswith('batch-')],
                             [f'batch-{BATCH_ID}'])

    def test_bad_digest_or_trailing_bytes_never_publishes_batch(self):
        with tempfile.TemporaryDirectory() as root:
            source = Path(root).resolve() / 'source'
            inbox = Path(root).resolve() / 'inbox'
            source.mkdir(mode=0o700)
            inbox.mkdir(mode=0o700)
            manifest, part, _ = source_files(source)
            wire = io.BytesIO()
            FEED.send(manifest, wire)
            valid = wire.getvalue()
            for payload in (valid[:-1] + b'x', valid + b'!', valid[:-3]):
                with self.subTest(size=len(payload)), self.assertRaises(FEED.FeedStageError):
                    FEED.receive(io.BytesIO(payload), inbox, os.geteuid())
                self.assertFalse(any(item.name.startswith('batch-') or item.name.startswith('.receiving-')
                                     for item in inbox.iterdir()))

    def test_interrupted_private_stage_is_reaped_before_exact_replay(self):
        with tempfile.TemporaryDirectory() as root:
            source = Path(root).resolve() / 'source'
            inbox = Path(root).resolve() / 'inbox'
            source.mkdir(mode=0o700)
            inbox.mkdir(mode=0o700)
            orphan = inbox / '.receiving-abcdefgh'
            orphan.mkdir(mode=0o700)
            stale = orphan / 'part-0001.json'
            stale.write_bytes(b'incomplete private body')
            stale.chmod(0o600)
            manifest, _, _ = source_files(source)
            wire = io.BytesIO()
            FEED.send(manifest, wire)
            self.assertEqual(FEED.receive(io.BytesIO(wire.getvalue()), inbox, os.geteuid())['status'], 'staged')
            self.assertFalse(orphan.exists())
            self.assertTrue((inbox / f'batch-{BATCH_ID}' / 'manifest.json').is_file())

    def test_manifest_rejects_paths_duplicate_fields_and_inconsistent_counts(self):
        with tempfile.TemporaryDirectory() as root:
            manifest, _, value = source_files(root)
            bad = [
                {**value, 'parts': [{**value['parts'][0], 'file': '../private.json'}]},
                {**value, 'rows': 2},
                {**value, 'parts': [value['parts'][0], value['parts'][0]]},
            ]
            for item in bad:
                with self.subTest(item=item), self.assertRaises(FEED.FeedStageError):
                    FEED.manifest_metadata(f'batch-{BATCH_ID}/manifest.json', json.dumps(item).encode())
            with self.assertRaises(FEED.FeedStageError):
                FEED.manifest_metadata(f'batch-{BATCH_ID}/manifest.json', b'{"schemaVersion":1,"schemaVersion":1}')


class ImportSequenceTests(unittest.TestCase):
    def test_child_stdout_is_capped_while_running(self):
        with tempfile.TemporaryDirectory() as root:
            with self.assertRaises(FEED.FeedStageError):
                FEED.run_as_api([os.sys.executable, '-c', 'import sys; sys.stdout.write("x" * 1000000)'],
                                dict(os.environ), root, 10, demote=lambda: None)
            self.assertEqual(FEED.run_as_api([os.sys.executable, '-c', 'print("{\\\"ok\\\":true}")'],
                                             dict(os.environ), root, 10, demote=lambda: None), {'ok': True})

    def test_child_that_closes_stdout_still_has_a_safe_bounded_deadline(self):
        with tempfile.TemporaryDirectory() as root:
            with self.assertRaisesRegex(FEED.FeedStageError, '^Feed import timed out; the batch remains staged\\.$'):
                FEED.run_as_api([os.sys.executable, '-c', 'import os,time; os.close(1); time.sleep(30)'],
                                dict(os.environ), root, 0.1, demote=lambda: None)

    def test_only_the_latest_committed_database_digest_confirms_import(self):
        with tempfile.TemporaryDirectory() as root, patch.object(FEED, 'BASE', Path(root)):
            state = Path(root) / 'state'
            state.mkdir()
            path = state / 'preview.sqlite'
            self.assertFalse(FEED.latest_import_matches(SHA))
            with closing(sqlite3.connect(path)) as database, database:
                database.execute('CREATE TABLE justup_imports (selection_json TEXT)')
                database.execute('INSERT INTO justup_imports VALUES (?)', (json.dumps({'feed': {'manifestSha256': SHA}}),))
            self.assertTrue(FEED.latest_import_matches(SHA))
            with closing(sqlite3.connect(path)) as database, database:
                database.execute('INSERT INTO justup_imports VALUES (?)', (json.dumps({'feed': {'manifestSha256': 'b' * 64}}),))
                self.assertFalse(FEED.latest_import_matches('b' * 64))
            self.assertFalse(FEED.latest_import_matches(SHA))
            self.assertTrue(FEED.latest_import_matches('b' * 64))
            for malformed in ('[]', '{"feed":[]}', 'not-json'):
                with self.subTest(selection=malformed), closing(sqlite3.connect(path)) as database, database:
                    database.execute('INSERT INTO justup_imports VALUES (?)', (malformed,))
                self.assertFalse(FEED.latest_import_matches(SHA))
            with patch.object(FEED.sqlite3, 'connect', side_effect=sqlite3.OperationalError('Synthetic unavailable database.')):
                self.assertFalse(FEED.latest_import_matches(SHA))

    def test_partial_receipt_waits_for_durable_latest_and_replays_bound_candidate(self):
        with tempfile.TemporaryDirectory() as root:
            inbox = Path(root) / 'inbox'
            inbox.mkdir(mode=0o700)
            directory = inbox / f'batch-{BATCH_ID}'
            directory.mkdir(mode=0o700)
            manifest = directory / 'manifest.json'
            receipts = Path(root) / 'receipts'
            receipts.mkdir(mode=0o700)
            candidate = directory / 'candidate.json'
            payload = {'stageVersion': 1, 'candidate': {'selection': {'feed': {
                'manifestSha256': SHA, 'limit': 500, 'complete': False}}}}
            owner = SimpleNamespace(pw_uid=os.geteuid(), pw_gid=os.getegid())
            original_checked = FEED.checked_file
            original_sync = FEED.fsync_dir

            def adapter(*_args):
                candidate.write_text(json.dumps(payload))
                candidate.chmod(0o600)
                return {'manifestSha256': SHA, 'importable': False}

            def fail_inbox_sync(path):
                if path == inbox:
                    raise OSError('Synthetic directory sync failure.')
                return original_sync(path)

            args = (directory, manifest, {'complete': False}, SHA, Path(root) / 'release',
                    {'buildIdentity': SHA}, inbox, 500)
            with patch.object(FEED, 'RECEIPTS', receipts), \
                    patch.object(FEED.pwd, 'getpwnam', return_value=owner), \
                    patch.object(FEED, 'checked_file', side_effect=lambda path, _owner: original_checked(path, owner.pw_uid)), \
                    patch.object(FEED, 'run_as_api', side_effect=adapter) as child:
                with patch.object(FEED, 'fsync_dir', side_effect=fail_inbox_sync), self.assertRaises(OSError):
                    FEED.consume_batch(*args)
                self.assertIsNone(FEED.root_receipt(BATCH_ID, SHA))
                self.assertEqual(json.loads((inbox / 'latest.json').read_text()), payload)
                self.assertEqual(FEED.consume_batch(*args)['status'], 'staged_for_catchup')
                self.assertEqual(child.call_count, 1)
                self.assertEqual(FEED.root_receipt(BATCH_ID, SHA), {'schemaVersion': 1, 'manifestSha256': SHA})
                self.assertEqual((inbox / 'latest.json').stat().st_mode & 0o777, 0o600)

    def test_failed_receipt_publication_cannot_ack_until_file_and_directory_sync_recover(self):
        owner = os.geteuid()
        checked = FEED.checked_file
        for failure in ('file', 'directory'):
            with self.subTest(failure=failure), tempfile.TemporaryDirectory() as root:
                directory = Path(root).resolve()

                class LocalReceiptDirectory(type(directory)):
                    # Exercise the root-only command off-host under this test's
                    # identity; only the receipt directory ownership is mapped.
                    def stat(self, *args, **kwargs):
                        meta = super().stat(*args, **kwargs)
                        if self == directory:
                            fields = list(meta)
                            fields[4] = 0
                            return os.stat_result(fields)
                        return meta

                receipts = LocalReceiptDirectory(directory)
                host = SimpleNamespace(verify_caps=lambda: None, verify_storage=lambda: None)
                with patch.object(FEED, 'RECEIPTS', receipts), \
                        patch.object(FEED, 'checked_file', side_effect=lambda path, _owner: checked(path, owner)), \
                        patch.object(FEED.os, 'geteuid', return_value=0), \
                        patch.object(FEED.os, 'fstat', return_value=SimpleNamespace(
                            st_mode=FEED.stat.S_IFREG | 0o600, st_uid=0, st_nlink=1)), \
                        patch.object(FEED, 'authorized_batch', return_value=(None, None, None, SHA)), \
                        patch.object(FEED, 'host_module', return_value=host), \
                        patch.object(FEED, 'private_inbox', return_value=directory), \
                        patch.object(FEED, 'active_release') as active, \
                        patch.object(FEED, 'consume_batch') as consume:
                    target, name = (FEED.os, 'fsync') if failure == 'file' else (FEED, 'fsync_dir')
                    with patch.object(target, name, side_effect=OSError('Synthetic sync failure.')) as sync:
                        with self.assertRaises(OSError):
                            FEED.store_receipt(BATCH_ID, SHA)
                        self.assertTrue(FEED.receipt_path(BATCH_ID).is_file())
                        for read in (lambda: FEED.root_receipt(BATCH_ID, SHA),
                                     lambda: FEED.show_receipt(BATCH_ID, SHA),
                                     lambda: FEED.process_batch(BATCH_ID, SHA)):
                            with self.assertRaises(OSError):
                                read()
                        self.assertGreaterEqual(sync.call_count, 4)
                        with patch.object(FEED.sys, 'stdout', new_callable=io.StringIO) as output, \
                                patch.object(FEED.sys, 'stderr', new_callable=io.StringIO) as error:
                            self.assertEqual(FEED.main(['receipt', '--batch-id', BATCH_ID, '--manifest-sha256', SHA]), 1)
                            self.assertEqual(output.getvalue(), '')
                            self.assertEqual(error.getvalue(), 'Feed operation failed.\n')
                    expected = {'schemaVersion': 1, 'manifestSha256': SHA}
                    self.assertEqual(FEED.show_receipt(BATCH_ID, SHA), expected)
                    self.assertEqual(FEED.process_batch(BATCH_ID, SHA)['status'], 'already_accepted')
                    active.assert_not_called()
                    consume.assert_not_called()

    def test_wrong_independent_digest_blocks_import_authorization(self):
        with patch.object(FEED, 'batch_files', return_value=(Path('/safe'), Path('/safe/manifest.json'), {}, SHA)), \
                patch.object(FEED, 'active_release') as release, \
                patch.object(FEED, 'run_as_api') as app:
            with self.assertRaises(FEED.FeedStageError):
                FEED.authorized_batch(BATCH_ID, 'b' * 64)
            release.assert_not_called()
            app.assert_not_called()
        with self.assertRaises(FEED.FeedStageError):
            FEED.require_source_digest(SHA, 'not-a-digest')
        FEED.require_source_digest(SHA, SHA)

    def _case(self, complete, *, candidate_exists=False, adapter_failure=False, already_imported=False):
        stack = tempfile.TemporaryDirectory()
        root = Path(stack.name)
        directory = root / f'batch-{BATCH_ID}'
        directory.mkdir()
        manifest = directory / 'manifest.json'
        manifest.write_text('{}')
        inbox = root / 'inbox'
        inbox.mkdir()
        candidate = directory / 'candidate.json'
        if candidate_exists:
            candidate.write_text('{}')
        digest = SHA
        events = []

        def run(argv, *_args):
            if '--feed-manifest' in argv:
                events.append('adapter')
                candidate.write_text('{}')
                return {'manifestSha256': digest, 'importable': complete}
            events.append('node')
            if adapter_failure:
                raise FEED.FeedStageError('Synthetic import failure.')
            return {'imported': 1}

        import_states = [already_imported] if already_imported else [False, True]
        patches = [
            patch.object(FEED, 'run_as_api', side_effect=run),
            patch.object(FEED, 'read_candidate', side_effect=lambda *_: events.append('validated')),
            patch.object(FEED, 'candidate_marker', return_value={'bound': True} if candidate_exists else None),
            patch.object(FEED, 'bind_candidate_build', side_effect=lambda *_: events.append('bound')),
            patch.object(FEED, 'node_import_environment', return_value={}),
            patch.object(FEED, 'latest_import_matches', side_effect=lambda *_: import_states.pop(0)),
            patch.object(FEED, 'promote_candidate', side_effect=lambda *_: events.append('promoted')),
            patch.object(FEED, 'store_receipt', side_effect=lambda *_: events.append('receipt')),
        ]
        for item in patches:
            item.start()
        self.addCleanup(lambda: [item.stop() for item in reversed(patches)])
        self.addCleanup(stack.cleanup)
        return directory, manifest, {'complete': complete}, digest, root / 'release', {'buildIdentity': SHA, 'entrypoint': 'app/server/main.mjs'}, inbox, events

    def test_partial_page_is_durable_before_ack_but_never_imported_to_app(self):
        args = self._case(False)
        result = FEED.consume_batch(*args[:-1], max_jobs=500)
        self.assertEqual(result['status'], 'staged_for_catchup')
        self.assertEqual(args[-1], ['adapter', 'validated', 'bound', 'promoted', 'receipt'])

    def test_failed_app_import_retains_candidate_without_ack_then_retries(self):
        args = self._case(True, adapter_failure=True)
        with self.assertRaises(FEED.FeedStageError):
            FEED.consume_batch(*args[:-1], max_jobs=500)
        self.assertEqual(args[-1], ['adapter', 'validated', 'bound', 'node'])

    def test_crash_after_app_commit_reuses_candidate_and_checks_db_before_ack(self):
        args = self._case(True, candidate_exists=True, already_imported=True)
        result = FEED.consume_batch(*args[:-1], max_jobs=500)
        self.assertEqual(result['status'], 'imported')
        self.assertEqual(args[-1], ['validated', 'bound', 'promoted', 'receipt'])

    def test_release_switch_refuses_reuse_of_previous_build_candidate(self):
        args = self._case(True, candidate_exists=True)
        old = {'schemaVersion': 1, 'manifestSha256': SHA,
               'candidateSha256': SHA, 'buildIdentity': 'b' * 64}
        with patch.object(FEED, 'candidate_marker', return_value=old), \
                patch.object(FEED, 'candidate_digest', return_value=SHA), \
                patch.object(FEED, 'bind_candidate_build', wraps=REAL_BIND_CANDIDATE):
            with self.assertRaises(FEED.FeedStageError):
                FEED.consume_batch(*args[:-1], max_jobs=500)
        self.assertEqual(args[-1], ['validated'])


class ComposedImportTests(unittest.TestCase):
    def test_actual_adapter_and_database_import_recover_partial_and_committed_batches(self):
        root = Path(__file__).resolve().parents[1]
        node = shutil.which('node')
        self.assertIsNotNone(node, 'The composed import contract requires the pinned Node runtime.')
        self.assertEqual(subprocess.check_output([node, '--version'], text=True).strip(), 'v24.22.2')
        # The real CLIs use their wall clock. Freeze one synthetic source time
        # safely behind it; all later page times stay in the same short window.
        now = datetime.now(timezone.utc).replace(microsecond=0)
        iso = lambda value: value.strftime('%Y-%m-%dT%H:%M:%S.%fZ')
        snapshot_at = iso(now - timedelta(minutes=6))
        partial_at = iso(now - timedelta(minutes=4))
        complete_at = iso(now - timedelta(minutes=2))
        posting_times = {'firstSeenAt': iso(now - timedelta(days=2)),
                         'lastSeenAt': iso(now - timedelta(minutes=8)),
                         'updatedAt': iso(now - timedelta(minutes=8))}
        third_id = '33333333-3333-4333-8333-333333333333'
        scope = {'kind': 'company_ids', 'requestedCount': 1,
                 'requestedSetSha256': hashlib.sha256(IMPORT_FIXTURES.COMPANY_A.encode()).hexdigest()}
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary).resolve()
            inbox = base / 'state/feed-inbox'
            inbox.mkdir(parents=True, mode=0o700)
            receipts = base / 'receipts'
            receipts.mkdir(mode=0o700)
            release = base / 'release'
            app = release / 'app'
            (app / 'scripts').mkdir(parents=True)
            shutil.copy2(root / 'scripts/import-jobs.py', app / 'scripts/import-jobs.py')
            shutil.copytree(root / 'server', app / 'server')
            (release / 'runtime/bin').mkdir(parents=True)
            (release / 'runtime/bin/node').symlink_to(Path(node).resolve())
            runtime_bytes = hashlib.sha256()
            for path in sorted(app.rglob('*')):
                if path.is_file():
                    runtime_bytes.update(str(path.relative_to(app)).encode() + b'\0' + path.read_bytes())
            build = runtime_bytes.hexdigest()
            release_manifest = {'buildIdentity': build, 'entrypoint': 'app/server/main.mjs'}
            owner = SimpleNamespace(pw_uid=os.geteuid(), pw_gid=os.getegid())
            original_checked, original_run = FEED.checked_file, FEED.run_as_api
            events = []

            def run(argv, environment, cwd, timeout):
                events.append('adapter' if '--feed-manifest' in argv else 'node')
                if argv[0] == '/usr/bin/python3':
                    # Use the test runner's supported Python off-host; macOS's
                    # system Python predates the production Linux baseline.
                    argv = [os.sys.executable, *argv[1:]]
                return original_run(argv, environment, cwd, min(timeout, 10), demote=lambda: None)

            def stage(rows, **options):
                source, _ = IMPORT_FIXTURES.write_feed_bundle(base / 'source', rows, scope=scope, **options)
                wire = io.BytesIO()
                FEED.send(source, wire)
                staged = FEED.receive(io.BytesIO(wire.getvalue()), inbox, owner.pw_uid)
                self.assertFalse(staged['acknowledgeable'])
                directory = inbox / source.parent.name
                manifest = json.loads((directory / 'manifest.json').read_text())
                digest = hashlib.sha256(source.read_bytes()).hexdigest()
                self.assertEqual(staged['manifestSha256'], digest)
                FEED.require_source_digest(digest, digest)
                return directory, directory / 'manifest.json', manifest, digest

            def consume(batch, manifest=release_manifest):
                return FEED.consume_batch(*batch, release, manifest, inbox, 10)

            def imports():
                with closing(sqlite3.connect(base / 'state/preview.sqlite')) as database:
                    return database.execute('SELECT count(*) FROM justup_imports').fetchone()[0]

            with patch.object(FEED, 'BASE', base), patch.object(FEED, 'RECEIPTS', receipts), \
                    patch.object(FEED.pwd, 'getpwnam', return_value=owner), \
                    patch.object(FEED, 'checked_file', side_effect=lambda path, _owner: original_checked(path, owner.pw_uid)), \
                    patch.object(FEED, 'run_as_api', side_effect=run), \
                    patch.object(FEED, 'node_import_environment', return_value={
                        'PATH': str(Path(node).parent) + ':/usr/bin:/bin', 'TZ': 'UTC',
                        'JUSTUP_DB_PATH': str(base / 'state/preview.sqlite')}):
                initial = stage([IMPORT_FIXTURES.feed_posting(**posting_times),
                                 IMPORT_FIXTURES.feed_posting(IMPORT_FIXTURES.JOB_B, **posting_times)],
                                batch_id='a' * 32, cutoff=snapshot_at, source_count=3)
                self.assertEqual(consume(initial)['status'], 'imported')
                self.assertEqual(imports(), 1)
                self.assertEqual(FEED.root_receipt('a' * 32, initial[3]), {'schemaVersion': 1, 'manifestSha256': initial[3]})
                self.assertTrue(FEED.latest_import_matches(initial[3]))
                partial = stage([
                    IMPORT_FIXTURES.feed_posting(**{**posting_times, 'active': False,
                        'updatedAt': iso(now - timedelta(minutes=5))}),
                    IMPORT_FIXTURES.feed_posting(third_id, **{**posting_times,
                        'updatedAt': iso(now - timedelta(minutes=5)), 'body': None, 'bodyStatus': 'missing'})],
                    batch_id='b' * 32, kind='changes', from_cursor=initial[2]['toCursor'],
                    cutoff=partial_at, complete=False, source_count=3)
                with patch.object(FEED, 'promote_candidate', side_effect=OSError('Synthetic staging interruption.')), self.assertRaises(OSError):
                    consume(partial)
                self.assertEqual(imports(), 1)
                self.assertIsNone(FEED.root_receipt('b' * 32, partial[3]))
                with self.assertRaises(FEED.FeedStageError):
                    consume(partial, {**release_manifest, 'buildIdentity': 'b' * 64})
                self.assertEqual(consume(partial)['status'], 'staged_for_catchup')
                self.assertEqual(events, ['adapter', 'node', 'adapter'])
                self.assertEqual(FEED.candidate_marker('b' * 32)['buildIdentity'], build)
                self.assertEqual(FEED.candidate_marker('b' * 32)['manifestSha256'], partial[3])
                self.assertEqual(FEED.root_receipt('b' * 32, partial[3]), {'schemaVersion': 1, 'manifestSha256': partial[3]})
                complete = stage([], batch_id='c' * 32, kind='changes',
                                 from_cursor=partial[2]['toCursor'], cutoff=complete_at, source_count=3)
                with patch.object(FEED, 'promote_candidate', side_effect=OSError('Synthetic post-commit interruption.')), self.assertRaises(OSError):
                    consume(complete)
                self.assertEqual(imports(), 2)
                self.assertTrue(FEED.latest_import_matches(complete[3]))
                self.assertIsNone(FEED.root_receipt('c' * 32, complete[3]))
                with self.assertRaises(FEED.FeedStageError):
                    consume(complete, {**release_manifest, 'buildIdentity': 'b' * 64})
                original_sync = FEED.fsync_dir
                def fail_receipt_sync(path):
                    if path == receipts:
                        raise OSError('Synthetic receipt publication interruption.')
                    return original_sync(path)
                with patch.object(FEED, 'fsync_dir', side_effect=fail_receipt_sync):
                    with self.assertRaises(OSError):
                        consume(complete)
                    with self.assertRaises(OSError):
                        FEED.root_receipt('c' * 32, complete[3])
                    self.assertEqual(imports(), 2)
                self.assertEqual(consume(complete)['status'], 'imported')
                self.assertEqual(imports(), 2)
                self.assertEqual(events, ['adapter', 'node', 'adapter', 'adapter', 'node'])
                self.assertEqual(FEED.root_receipt('c' * 32, complete[3]), {'schemaVersion': 1, 'manifestSha256': complete[3]})
                with self.assertRaises(FEED.FeedStageError):
                    FEED.require_source_digest(complete[3], '0' * 64)
                with closing(sqlite3.connect(base / 'state/preview.sqlite')) as database:
                    states = dict(database.execute('SELECT id,active FROM justup_jobs'))
                    self.assertEqual(states, {IMPORT_FIXTURES.JOB_A: 0, IMPORT_FIXTURES.JOB_B: 1, third_id: 1})
                    kept = database.execute('SELECT body_text FROM justup_jobs WHERE id=?', (IMPORT_FIXTURES.JOB_B,)).fetchone()[0]
                    missing = database.execute('SELECT body_text FROM justup_jobs WHERE id=?', (third_id,)).fetchone()[0]
                    self.assertIn('Verifiable public role details.', kept)
                    self.assertIsNone(missing)
                latest = json.loads((inbox / 'latest.json').read_text())
                self.assertEqual(latest['selection']['feed']['manifestSha256'], complete[3])
                self.assertTrue(latest['selection']['limitedCoverage'])


if __name__ == '__main__':
    unittest.main()
