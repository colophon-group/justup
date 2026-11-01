#!/usr/bin/env python3
"""Offline contracts for reviewed preview crash and safety-stop drill evidence."""
from __future__ import annotations

from copy import deepcopy
from contextlib import redirect_stderr
import importlib.util
import io
import json
import os
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('preview_failure_drill', Path(__file__).with_name('preview-failure-drill.py'))
drill = importlib.util.module_from_spec(spec)
spec.loader.exec_module(drill)


def snapshot():
    return {'formatVersion': 1, 'observedAtMs': 1000, 'kind': 'api',
            'unit': 'justup-preview-api.service', 'planSha256': 'a' * 64,
            'hostMachineSha256': 'b' * 64, 'releaseLink': 'releases/' + 'c' * 64,
            'manifestSha256': 'd' * 64, 'generationSha256': 'e' * 64,
            'service': {'ActiveState': 'active', 'SubState': 'running', 'MainPID': '101',
                        'NRestarts': '0', 'InvocationID': 'f' * 32, 'Result': 'success'},
            'guard': {'ActiveState': 'inactive', 'Result': 'success'},
            'guardTimer': {'ActiveState': 'active'}}


class DrillEvidence(unittest.TestCase):
    def test_one_restart_requires_a_new_process_and_invocation(self):
        before, after = snapshot(), snapshot()
        after['observedAtMs'] = 2000
        after['service'].update(MainPID='102', NRestarts='1', InvocationID='1' * 32)
        self.assertTrue(drill.assess('crash', before, after)['passed'])
        for changed in ({'MainPID': '101'}, {'NRestarts': '0'}, {'NRestarts': '2'},
                        {'InvocationID': 'f' * 32}, {'ActiveState': 'failed'}):
            failed = deepcopy(after)
            failed['service'].update(changed)
            self.assertFalse(drill.assess('crash', before, failed)['passed'], changed)

    def test_explicit_and_guard_stops_remain_stopped(self):
        before, after = snapshot(), snapshot()
        after['observedAtMs'] = 2000
        after['service'].update(ActiveState='inactive', SubState='dead', MainPID='0')
        self.assertTrue(drill.assess('deliberate-stop', before, after)['passed'])
        self.assertFalse(drill.assess('guard-stop', before, after)['passed'])
        after['guard'].update(ActiveState='failed', Result='exit-code')
        self.assertTrue(drill.assess('guard-stop', before, after)['passed'])
        self.assertFalse(drill.assess('deliberate-stop', before, after)['passed'])
        after['service']['ActiveState'] = 'active'
        self.assertFalse(drill.assess('guard-stop', before, after)['passed'])

    def test_release_generation_and_host_changes_invalidate_evidence(self):
        before, after = snapshot(), snapshot()
        after['observedAtMs'] = 2000
        after['service'].update(MainPID='102', NRestarts='1', InvocationID='1' * 32)
        for key, value in (('planSha256', '0' * 64), ('manifestSha256', '0' * 64),
                           ('generationSha256', '0' * 64), ('hostMachineSha256', '0' * 64),
                           ('releaseLink', 'releases/' + '0' * 64), ('unit', 'other.service')):
            changed = deepcopy(after)
            changed[key] = value
            with self.assertRaises(ValueError, msg=key):
                drill.assess('crash', before, changed)
        after['observedAtMs'] = 1000
        with self.assertRaises(ValueError):
            drill.assess('crash', before, after)

    def test_capture_refuses_unreviewed_unit_receipt_and_upgrade(self):
        with self.assertRaises(ValueError):
            drill.capture('jobseek-lightpanda-renderer', 'a' * 64, 'b' * 64)
        with tempfile.TemporaryDirectory() as folder:
            base = Path(folder).resolve()
            marker = base / '.preview-install.json'
            marker.write_text(json.dumps({'formatVersion': 1, 'planSha256': '0' * 64}))
            with (patch.object(drill, 'BASE', base), patch.object(drill, 'MARKER', marker),
                  patch.object(drill, 'UPGRADE_LOCK', base / 'upgrade.lock'),
                  patch.object(drill, 'SCHEMA_LOCK', base / 'schema.lock'),
                  patch.object(drill, 'PENDING', base / 'pending'),
                  patch.object(drill, 'inside_slice', return_value=True),
                  patch.object(drill.os, 'geteuid', return_value=0),
                  patch.object(drill.platform, 'system', return_value='Linux'),
                  patch.object(drill.platform, 'machine', return_value='aarch64'),
                  patch.object(drill.platform, 'node', return_value='murmur-server'),
                  patch.object(drill, 'sha', return_value='b' * 64),
                  patch.object(drill, 'owned_regular', return_value=marker)):
                with self.assertRaisesRegex(ValueError, 'receipt'):
                    drill.capture('api', 'a' * 64, 'b' * 64)
                marker.write_text(json.dumps({'formatVersion': 1, 'planSha256': 'a' * 64}))
                (base / 'upgrade.lock').write_text('retained lock')
                with self.assertRaisesRegex(ValueError, 'pending'):
                    drill.capture('api', 'a' * 64, 'b' * 64)

    def test_capture_records_only_reviewed_unit_and_release_identity(self):
        with tempfile.TemporaryDirectory() as folder:
            base = Path(folder).resolve()
            build = 'c' * 64
            release = base / 'releases' / build
            release.mkdir(parents=True)
            (base / 'current').symlink_to('releases/' + build)
            (release / 'manifest.json').write_text(json.dumps({'buildIdentity': build}))
            marker = base / '.preview-install.json'
            marker.write_text(json.dumps({'formatVersion': 1, 'planSha256': 'a' * 64}))
            generation = base / 'generation'
            generation.write_text('generation-one')
            service = {'LoadState': 'loaded', 'ActiveState': 'active', 'SubState': 'running',
                       'MainPID': '101', 'NRestarts': '0', 'InvocationID': 'f' * 32,
                       'Result': 'success', 'FragmentPath': '/etc/systemd/system/justup-preview-api.service',
                       'ControlGroup': '/justup.slice/justup-preview.slice/justup-preview-api.service'}
            def fake_show(unit, properties=drill.PROPERTIES):
                if unit == 'justup-preview-guard.service':
                    return {'ActiveState': 'inactive', 'Result': 'success'}
                if unit == 'justup-preview-guard.timer':
                    return {'ActiveState': 'active'}
                return service
            actual_sha = drill.sha
            with (patch.object(drill, 'BASE', base), patch.object(drill, 'MARKER', marker),
                  patch.object(drill, 'GENERATION', generation),
                  patch.object(drill, 'UPGRADE_LOCK', base / 'upgrade.lock'),
                  patch.object(drill, 'SCHEMA_LOCK', base / 'schema.lock'),
                  patch.object(drill, 'PENDING', base / 'pending'),
                  patch.object(drill.os, 'geteuid', return_value=0),
                  patch.object(drill.platform, 'system', return_value='Linux'),
                  patch.object(drill.platform, 'machine', return_value='aarch64'),
                  patch.object(drill.platform, 'node', return_value='murmur-server'),
                  patch.object(drill, 'inside_slice', return_value=True),
                  patch.object(drill, 'owned_regular', side_effect=lambda path, maximum: path),
                  patch.object(drill, 'private_regular', side_effect=lambda path, maximum: path),
                  patch.object(drill, 'show', side_effect=fake_show),
                  patch.object(drill, 'sha', side_effect=lambda path: 'b' * 64
                               if path == Path('/etc/machine-id') else actual_sha(path))):
                evidence = drill.capture('api', 'a' * 64, 'b' * 64)
            self.assertEqual(evidence['releaseLink'], 'releases/' + build)
            self.assertEqual(evidence['service']['MainPID'], '101')
            self.assertEqual(evidence['generationSha256'], actual_sha(generation))
            self.assertNotIn('ControlGroup', evidence['service'])

    def test_receipt_symlink_is_not_trusted(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'receipt'
            target = Path(folder) / 'other'
            target.write_text('{}')
            path.symlink_to(target)
            with self.assertRaises(ValueError):
                drill.owned_regular(path, 4096)

    def test_evidence_input_refuses_symlinks_and_oversized_private_files(self):
        with tempfile.TemporaryDirectory() as folder:
            base = Path(folder).resolve()
            evidence = base / 'before.json'
            evidence.write_bytes(b'x' * (drill.MAX_EVIDENCE_BYTES + 1))
            evidence.chmod(0o600)
            original_lstat = Path.lstat
            def root_lstat(path, *args, **kwargs):
                result = original_lstat(path, *args, **kwargs)
                if path != evidence:
                    return result
                return SimpleNamespace(st_mode=result.st_mode, st_uid=0, st_nlink=result.st_nlink,
                                       st_size=result.st_size, st_dev=result.st_dev, st_ino=result.st_ino)
            with patch.object(Path, 'lstat', autospec=True, side_effect=root_lstat):
                with self.assertRaisesRegex(ValueError, 'bounded'):
                    drill.read_evidence(evidence)
            alias = base / 'alias.json'
            alias.symlink_to(evidence)
            with self.assertRaises(ValueError):
                drill.read_evidence(alias)

    def test_small_private_evidence_loads_and_bad_utf8_fails_cleanly(self):
        with tempfile.TemporaryDirectory() as folder:
            evidence = Path(folder).resolve() / 'before.json'
            evidence.write_text('{"case":"crash"}')
            evidence.chmod(0o600)
            actual_lstat, actual_fstat = Path.lstat, os.fstat
            def root_meta(result):
                return SimpleNamespace(st_mode=result.st_mode, st_uid=0, st_nlink=result.st_nlink,
                                       st_size=result.st_size, st_dev=result.st_dev, st_ino=result.st_ino)
            with (patch.object(Path, 'lstat', autospec=True,
                               side_effect=lambda path, *args, **kwargs: root_meta(actual_lstat(path, *args, **kwargs))
                               if path == evidence else actual_lstat(path, *args, **kwargs)),
                  patch.object(drill.os, 'fstat', side_effect=lambda fd: root_meta(actual_fstat(fd)))):
                self.assertEqual(drill.read_evidence(evidence), {'case': 'crash'})
                evidence.write_bytes(b'\xff')
                error = io.StringIO()
                with (patch.object(sys, 'argv', ['preview-failure-drill.py', 'assess', '--case', 'crash',
                                                '--before', str(evidence), '--after', str(evidence)]),
                      redirect_stderr(error)):
                    self.assertEqual(drill.main(), 1)
                self.assertIn('evidence is unavailable', error.getvalue())
                self.assertNotIn('\\xff', error.getvalue())


if __name__ == '__main__':
    unittest.main()
