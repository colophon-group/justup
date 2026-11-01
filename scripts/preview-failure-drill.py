#!/usr/bin/env python3
"""Capture and assess one reviewed preview service failure drill; never inject a failure.

Run capture on the allocated preview host before and after one operator-controlled
unit action. The output contains only bounded unit and release identity fields.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import stat
import subprocess
import sys
import time

BASE = Path('/srv/justup_preview')
MARKER = BASE / '.preview-install.json'
GENERATION = BASE / 'state/private-generation'
PENDING = BASE / 'state/private-generation.pending'
UPGRADE_LOCK = BASE / '.preview-ops-upgrade.lock'
SCHEMA_LOCK = BASE / '.preview-schema-migration.lock'
UNITS = {
    'api': 'justup-preview-api.service',
    'runner': 'justup-preview-runner.service',
    'model': 'justup-preview-model.service',
}
PROPERTIES = ('LoadState', 'ActiveState', 'SubState', 'MainPID', 'NRestarts',
              'InvocationID', 'Result', 'FragmentPath', 'ControlGroup')
SHA256 = re.compile(r'[a-f0-9]{64}\Z')
BUILD_LINK = re.compile(r'releases/[a-f0-9]{64}\Z')
MAX_EVIDENCE_BYTES = 16 * 1024


def sha(path):
    result = hashlib.sha256()
    with path.open('rb') as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b''):
            result.update(block)
    return result.hexdigest()


def owned_regular(path, maximum):
    meta = path.lstat()
    if (not stat.S_ISREG(meta.st_mode) or meta.st_uid != 0 or meta.st_nlink != 1
            or meta.st_mode & 0o022 or meta.st_size > maximum):
        raise ValueError('A required root-owned preview file is unsafe.')
    return path


def private_regular(path, maximum):
    meta = path.lstat()
    if (not stat.S_ISREG(meta.st_mode) or meta.st_nlink != 1
            or meta.st_mode & 0o077 or meta.st_size > maximum):
        raise ValueError('The private deletion generation is unsafe.')
    return path


def show(unit, properties=PROPERTIES):
    output = subprocess.run(['systemctl', 'show', '--property=' + ','.join(properties), unit],
                            check=True, capture_output=True, text=True, timeout=10).stdout
    fields = {}
    for line in output.splitlines():
        key, separator, value = line.partition('=')
        if not separator or key not in properties or key in fields or len(value) > 256:
            raise ValueError('Unit state is malformed or unbounded.')
        fields[key] = value
    if set(fields) != set(properties):
        raise ValueError('Unit state is incomplete.')
    return fields


def inside_slice():
    cgroups = Path('/proc/self/cgroup').read_text().splitlines()
    return any('justup-preview.slice' in line.split('/') for line in cgroups if line.startswith('0::'))


def capture(kind, expected_plan, expected_machine):
    if kind not in UNITS or not SHA256.fullmatch(expected_plan or '') or not SHA256.fullmatch(expected_machine or ''):
        raise ValueError('Select one reviewed preview unit and exact plan/host hashes.')
    if (os.geteuid() != 0 or platform.system() != 'Linux'
            or platform.machine() not in {'aarch64', 'arm64'} or platform.node() != 'murmur-server'
            or sha(Path('/etc/machine-id')) != expected_machine):
        raise ValueError('Capture requires root on the reviewed preview host.')
    if not inside_slice():
        raise ValueError('Capture must run inside the preview slice.')
    if any(os.path.lexists(path) for path in (UPGRADE_LOCK, SCHEMA_LOCK, PENDING)):
        raise ValueError('An upgrade or private deletion is pending; refuse the drill.')
    receipt = json.loads(owned_regular(MARKER, 4096).read_text())
    if receipt != {'formatVersion': 1, 'planSha256': expected_plan}:
        raise ValueError('Installed receipt does not match the reviewed plan.')
    current = BASE / 'current'
    link = os.readlink(current)
    if not BUILD_LINK.fullmatch(link):
        raise ValueError('Current release is not an exact local build link.')
    manifest = owned_regular(BASE / link / 'manifest.json', 1024 * 1024)
    if json.loads(manifest.read_text()).get('buildIdentity') != link.removeprefix('releases/'):
        raise ValueError('Current manifest identity differs from the selected build.')
    generation = private_regular(GENERATION, 4096)
    unit = UNITS[kind]
    state = show(unit)
    if (state['LoadState'] != 'loaded' or state['FragmentPath'] != '/etc/systemd/system/' + unit
            or state['ActiveState'] not in {'active', 'inactive', 'failed'}
            or not state['MainPID'].isdigit() or not state['NRestarts'].isdigit()
            or (state['InvocationID'] and not re.fullmatch(r'[a-f0-9]{32}', state['InvocationID']))
            or (state['ActiveState'] == 'active' and
                ('justup-preview.slice' not in state['ControlGroup'].split('/')
                 or int(state['MainPID']) <= 1 or not state['InvocationID']))
            or (state['ActiveState'] != 'active' and state['MainPID'] != '0')):
        raise ValueError('Service is not the expected installed preview unit.')
    guard = show('justup-preview-guard.service', ('ActiveState', 'Result'))
    timer = show('justup-preview-guard.timer', ('ActiveState',))
    return {'formatVersion': 1, 'observedAtMs': time.time_ns() // 1_000_000,
            'kind': kind, 'unit': unit, 'planSha256': expected_plan,
            'hostMachineSha256': expected_machine, 'releaseLink': link,
            'manifestSha256': sha(manifest), 'generationSha256': sha(generation),
            'service': {key: state[key] for key in ('ActiveState', 'SubState', 'MainPID',
                                                   'NRestarts', 'InvocationID', 'Result')},
            'guard': guard, 'guardTimer': timer}


def assess(case, before, after):
    common = ('kind', 'unit', 'planSha256', 'hostMachineSha256', 'releaseLink',
              'manifestSha256', 'generationSha256')
    if (before.get('formatVersion') != 1 or after.get('formatVersion') != 1
            or before.get('kind') not in UNITS or before.get('unit') != UNITS[before['kind']]
            or any(before.get(key) != after.get(key) for key in common)
            or not isinstance(before.get('observedAtMs'), int)
            or not isinstance(after.get('observedAtMs'), int)
            or after['observedAtMs'] <= before['observedAtMs']):
        raise ValueError('Snapshots lack one stable reviewed host, release and deletion generation.')
    old, new = before['service'], after['service']
    if (old['ActiveState'] != 'active' or int(old['MainPID']) <= 1
            or before['guard']['ActiveState'] == 'failed'
            or before['guardTimer']['ActiveState'] != 'active'):
        raise ValueError('Before snapshot did not show a running preview service.')
    restarts = int(new['NRestarts']) - int(old['NRestarts'])
    if case == 'crash':
        passed = (new['ActiveState'] == 'active' and int(new['MainPID']) > 1
                  and new['MainPID'] != old['MainPID'] and new['InvocationID'] != old['InvocationID']
                  and restarts == 1 and after['guardTimer']['ActiveState'] == 'active'
                  and after['guard']['ActiveState'] != 'failed')
    elif case in {'deliberate-stop', 'guard-stop'}:
        passed = (new['ActiveState'] == 'inactive' and new['MainPID'] == '0' and restarts == 0
                  and after['guardTimer']['ActiveState'] == 'active'
                  and (after['guard']['ActiveState'] == 'failed') == (case == 'guard-stop'))
    else:
        raise ValueError('Choose crash, deliberate-stop or guard-stop.')
    return {'formatVersion': 1, 'case': case, 'passed': passed,
            'observationWindowMs': after['observedAtMs'] - before['observedAtMs'],
            'restartDelta': restarts, 'unit': before['unit']}


def read_evidence(path):
    if not path.is_absolute() or path.resolve(strict=True) != path:
        raise ValueError('Evidence must be a canonical absolute path.')
    initial = path.lstat()
    if (not stat.S_ISREG(initial.st_mode) or initial.st_uid != 0 or initial.st_nlink != 1
            or initial.st_mode & 0o077 or not 0 < initial.st_size <= MAX_EVIDENCE_BYTES):
        raise ValueError('Evidence must be a bounded root-private regular file.')
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC)
    try:
        opened = os.fstat(descriptor)
        if (not stat.S_ISREG(opened.st_mode) or opened.st_dev != initial.st_dev
                or opened.st_ino != initial.st_ino or opened.st_size != initial.st_size
                or opened.st_uid != 0 or opened.st_nlink != 1 or opened.st_mode & 0o077):
            raise ValueError('Evidence changed during review.')
        content = os.read(descriptor, MAX_EVIDENCE_BYTES + 1)
        if len(content) != initial.st_size:
            raise ValueError('Evidence changed during review.')
        return json.loads(content.decode('utf-8'))
    finally:
        os.close(descriptor)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    snapshot = commands.add_parser('capture')
    snapshot.add_argument('--unit', choices=UNITS, required=True)
    snapshot.add_argument('--reviewed-plan-sha', required=True)
    snapshot.add_argument('--host-machine-sha', required=True)
    review = commands.add_parser('assess')
    review.add_argument('--case', choices=('crash', 'deliberate-stop', 'guard-stop'), required=True)
    review.add_argument('--before', type=Path, required=True)
    review.add_argument('--after', type=Path, required=True)
    args = parser.parse_args()
    try:
        if args.command == 'capture':
            result = capture(args.unit, args.reviewed_plan_sha, args.host_machine_sha)
        else:
            result = assess(args.case, read_evidence(args.before), read_evidence(args.after))
        print(json.dumps(result, sort_keys=True))
        return 0 if result.get('passed', True) else 1
    except (ValueError, OSError, KeyError, TypeError, UnicodeError, subprocess.SubprocessError, json.JSONDecodeError):
        print(json.dumps({'error': 'Drill evidence is unavailable or does not match the reviewed preview.'}), file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
