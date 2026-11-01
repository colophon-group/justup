"""Bounded local transport, replay and exact-import acknowledgement contracts."""
from __future__ import annotations

import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

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


if __name__ == '__main__':
    unittest.main()
