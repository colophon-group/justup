#!/usr/bin/env python3
"""Prepare and verify the fixed preview host boundary; read the operations guide first.

No command contacts a provider or accepts an arbitrary device, mount or unit name.
Installation remains an explicit root operation after review of its plan digest.
"""
from __future__ import annotations

import argparse
import base64
import errno
import fcntl
import hashlib
import json
import os
from pathlib import Path
import platform
import pwd
import grp
import shutil
import subprocess
import sys
import tempfile
import uuid
import importlib.util
import re
import select
import stat
import time
from datetime import date, datetime, timezone

GIB = 1024 ** 3
MIB = 1024 ** 2
BASE = Path('/srv/justup_preview')
IMAGE = Path('/var/lib/justup-preview.disk')
SLICE = 'justup-preview.slice'
UNITS = ('justup-preview.slice', 'srv-justup_preview.mount', 'justup-preview-api.service',
         'justup-preview-guard.service', 'justup-preview-guard.timer',
         'justup-preview-model.socket', 'justup-preview-model.service', 'justup-preview-runner.service',
         'justup-preview-feed.socket', 'justup-preview-feed@.service')
BACKUP_SERVICE = 'justup-preview-backup.service'
BACKUP_TIMER = 'justup-preview-backup.timer'
BACKUP_UNITS = (BACKUP_TIMER, BACKUP_SERVICE)
LUNA_UNIT = 'justup-preview-luna-qualification.service'
LUNA_MANIFEST = 'app/server/evals/luna-qualification-v1.json'
LUNA_REVIEW = 'app/server/evals/luna-qualification-review.mjs'
LUNA_RESULT_LIMIT = 512 * 1024
JEV_UNIT = 'justup-preview-jev-qualification.service'
JEV_FIXTURE = 'app/server/evals/matching-cases-v1.json'
APPLICATION_UNITS = ('justup-preview-api.service', 'justup-preview-runner.service', 'justup-preview-tunnel.service')
STOP_UNITS = (*APPLICATION_UNITS, LUNA_UNIT, JEV_UNIT,
              'justup-preview-model.socket', 'justup-preview-model.service', 'justup-preview-feed.socket')
ROOT_FLOOR = 8 * GIB
DISK_LIMIT = 2 * GIB
USER = 'justup-preview-api'
RUNNER_USER = 'justup-preview-runner'
MODEL_USER = 'justup-preview-model'
STATE_GROUP = 'justup-preview-state'
CLIENT_GROUP = 'justup-preview-model-client'
OPERATOR_UID = 0
EXT4_FORMAT_OPTIONS = 'nodiscard,lazy_itable_init=0,lazy_journal_init=0'
UNIT_ROOT = Path('/etc/systemd/system')
PROC_ROOT = Path('/proc')
UPGRADE_LOCK = '.preview-ops-upgrade.lock'
FEED_UNITS = ('justup-preview-feed.socket', 'justup-preview-feed@.service')
FEED_ADDITIONS = {'scripts/preview-feed.py', *(f'deploy/justup-preview/{name}' for name in FEED_UNITS)}
DRILL_ADDITIONS = {'scripts/preview-failure-drill.py'}
BACKUP_ADDITIONS = {f'deploy/justup-preview/{name}' for name in BACKUP_UNITS}
FEED_SOCKET = Path('/run/justup-preview-feed.sock')
COVERAGE_ARTIFACT_BYTES = 6 * MIB
COVERAGE_PERIODS_PER_VERSION = 4
COVERAGE_DIRS = {'jobseek-coverage-v1': 'source-coverage-v1', 'jobseek-coverage-v2': 'source-coverage-v2'}
COVERAGE_CHECKER = 'app/scripts/hiring-wire/check-snapshot.mjs'


def call(*args, capture=False):
    result = subprocess.run(args, check=True, text=True, capture_output=capture)
    return result.stdout.strip() if capture else None


def digest(path):
    h = hashlib.sha256()
    with Path(path).open('rb') as f:
        for block in iter(lambda: f.read(MIB), b''):
            h.update(block)
    return h.hexdigest()


def plan(root, host_fingerprint=None, *, include_backup=False):
    if not re.fullmatch(r'[a-f0-9]{64}', host_fingerprint or ''):
        raise ValueError('Supply the reviewed host machine-id SHA256; never infer a new allocation target.')
    root = Path(root)
    units = (*UNITS, *BACKUP_UNITS) if include_backup else UNITS
    files = {f'deploy/justup-preview/{name}': digest(root / 'deploy/justup-preview' / name) for name in units}
    for name in ('runtime.json', 'codex-LICENSE'):
        files[f'deploy/justup-preview/{name}'] = digest(root / 'deploy/justup-preview' / name)
    for path in sorted((root / 'scripts').glob('preview-*.py')):
        if not path.name.endswith('.test.py'):
            files[f'scripts/{path.name}'] = digest(path)
    body = {'formatVersion': 1, 'hostMachineSha256': host_fingerprint, 'files': files, 'mount': str(BASE), 'newImage': str(IMAGE),
            'imageBytes': DISK_LIMIT, 'minimumRootFreeBytesAfterAllocation': ROOT_FLOOR,
            'physicalPreallocationRequired': True, 'formatDiscardAllowed': False, 'automaticReallocation': False,
            'formatOptions': EXT4_FORMAT_OPTIONS, 'synchronousInitializationRequired': True,
            'slice': {'cpuQuota': '50%', 'cpuWeight': 10, 'memoryHigh': 768 * MIB,
                      'memoryMax': GIB, 'memorySwapMax': 0, 'tasksMax': 96},
            'uids': {'api': USER, 'queue': RUNNER_USER, 'model': MODEL_USER},
            'groups': {STATE_GROUP: [USER, RUNNER_USER], CLIENT_GROUP: [RUNNER_USER]},
            'modelSocket': 'root:' + CLIENT_GROUP + ' 0660; root-owned 0750 parent; inherited fd3',
            'cumulativeJevLedger': {'path': str(BASE / 'queue/budget/jev.jsonl'), 'parentMode': '0700',
                                    'fileMode': '0600', 'owner': RUNNER_USER,
                                    'initializedByInstaller': False, 'restoredWithDatabase': False,
                                    'maximumApprovedNanodollars': 500000000},
            'privateDeletionProtocol': 'pending marker held through SQL COMMIT/ROLLBACK; core integration required',
            'bind': '127.0.0.1:8787',
            'protected': ['jobseek-lightpanda-renderer', '/mnt/murmur', 'all existing services and volumes'],
            'startAutomatically': False,
            'blocked': ['runner tool/credential isolation review', 'approved policy URLs/version',
                        'scoped runtime credential provisioning', 'confirmed account pricing and prepared cumulative ledger',
                        'native Codex version/help and tool/retention proof', 'frontend/tunnel fixed candidate route']}
    body['planSha256'] = hashlib.sha256(json.dumps(body, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
    return body


def reviewed(root, expected, host_fingerprint, *, include_backup=False):
    actual = plan(root, host_fingerprint, include_backup=include_backup)['planSha256']
    if not expected or expected != actual:
        raise ValueError('Plan digest differs from the reviewed files; review the new plan before applying it.')
    if os.geteuid() != 0 or platform.system() != 'Linux' or platform.machine() not in {'aarch64', 'arm64'}:
        raise ValueError('Apply only as root on the reviewed Linux ARM64 host.')
    if hashlib.sha256(Path('/etc/machine-id').read_bytes()).hexdigest() != host_fingerprint or platform.node() != 'murmur-server':
        raise ValueError('Host identity differs from the one reviewed allocation target.')
    if not Path('/sys/fs/cgroup/cgroup.controllers').is_file():
        raise ValueError('The required cgroup v2 hierarchy is unavailable.')


def self_cgroup():
    lines = Path('/proc/self/cgroup').read_text().splitlines()
    relative = next((line[3:] for line in lines if line.startswith('0::')), '')
    components = Path(relative).parts
    if SLICE not in components or components[-1] == SLICE:
        raise ValueError('Run this operation in a transient unit inside justup-preview.slice.')
    # Dashes in slice names create parent slices (justup.slice here). Resolve
    # the actual hierarchy instead of assuming the slice is at the root.
    index = components.index(SLICE)
    return Path('/sys/fs/cgroup').joinpath(*components[1:index + 1])


def verify_caps(cgroup=None):
    path = cgroup or self_cgroup()
    values = {name: (path / name).read_text().strip() for name in
              ('cpu.max', 'cpu.weight', 'memory.high', 'memory.max', 'memory.swap.max', 'pids.max')}
    quota, period = values['cpu.max'].split()
    if quota == 'max' or int(quota) <= 0 or int(quota) / int(period) > 0.5:
        raise ValueError('Kernel CPU quota exceeds half a CPU.')
    for name, maximum in [('cpu.weight', 10), ('memory.high', 768 * MIB), ('memory.max', GIB),
                          ('memory.swap.max', 0), ('pids.max', 96)]:
        value = values[name]
        if value == 'max' or int(value) > maximum or (maximum and int(value) <= 0):
            raise ValueError(f'Kernel {name} exceeds the preview ceiling.')
    return values


def root_reserve(extra=0, available=None):
    free = shutil.disk_usage('/').free if available is None else available
    if free - extra < ROOT_FLOOR:
        raise ValueError('Root free space would fall below the 8 GiB reserve.')
    return free


def _image_stat(require_preallocation=True):
    if IMAGE.is_symlink() or not IMAGE.is_file() or IMAGE.stat().st_size != DISK_LIMIT:
        raise ValueError('The preview image must be the exact dedicated 2 GiB regular file.')
    image = IMAGE.stat()
    if image.st_uid != OPERATOR_UID or image.st_nlink != 1 or image.st_mode & 0o7777 != 0o600:
        raise ValueError('The preview image must remain private, single-link and root-owned.')
    if require_preallocation and image.st_blocks * 512 < DISK_LIMIT:
        raise ValueError('The preview image is not physically preallocated; stop and review external discard or hole-punching.')
    return image


def verify_image():
    return _image_stat()


def format_image():
    # Initialize inode tables/journal before mount, without discarding reserved
    # extents or deferring zeroing through the loop device.
    call('mkfs.ext4', '-q', '-m', '0', '-E', EXT4_FORMAT_OPTIONS, '-F', str(IMAGE))
    return verify_image()


def _mounted_image_size():
    if not os.path.ismount(BASE) or BASE.stat().st_dev == BASE.parent.stat().st_dev:
        raise ValueError('The preview filesystem is not a dedicated mounted boundary.')
    filesystem = call('findmnt', '-n', '-o', 'FSTYPE', '--mountpoint', str(BASE), capture=True)
    source = call('findmnt', '-n', '-o', 'SOURCE', '--mountpoint', str(BASE), capture=True)
    options = set(call('findmnt', '-n', '-o', 'OPTIONS', '--mountpoint', str(BASE), capture=True).split(','))
    if not re.fullmatch(r'/dev/loop[0-9]+', source):
        raise ValueError('Preview source is not a loop device.')
    backing = (Path('/sys/class/block') / Path(source).name / 'loop/backing_file').read_text().strip()
    if (filesystem != 'ext4' or '/' + backing.lstrip('/') != str(IMAGE) or not {'nodev', 'nosuid'} <= options
            or any(value == 'discard' or value.startswith('discard=') for value in options)):
        raise ValueError('Mounted source or filesystem safety options differ from the dedicated image.')
    size = os.statvfs(BASE).f_blocks * os.statvfs(BASE).f_frsize
    if size > DISK_LIMIT:
        raise ValueError('Mounted filesystem exceeds 2 GiB.')
    return size


def _verify_storage(check_reserve, require_preallocation):
    image = _image_stat(require_preallocation)
    size = _mounted_image_size()
    if check_reserve:
        root_reserve()
    return {'imageBytes': image.st_size, 'allocatedImageBytes': image.st_blocks * 512, 'filesystemBytes': size}


def verify_storage(check_reserve=True):
    return _verify_storage(check_reserve, require_preallocation=True)


def proof():
    result = {'kernel': verify_caps(), 'storage': verify_storage()}
    fd, path = tempfile.mkstemp(prefix='.disk-proof-', dir=BASE)
    try:
        try:
            os.posix_fallocate(fd, 0, DISK_LIMIT + 4096)
        except OSError as error:
            if error.errno != errno.ENOSPC:
                raise
        else:
            raise ValueError('Filesystem did not reject an allocation beyond the disk ceiling.')
    finally:
        os.close(fd)
        Path(path).unlink()
    result['overLimitAllocationRejected'] = True
    return result


def stop_preview():
    try:
        backup_units = backup_units_for_current_receipt()
        for unit in backup_units:
            verify_loaded_backup_unit(unit)
        stop_units(backup_units)
    finally:
        stop_units(STOP_UNITS)


def stop_units(units):
    for unit in units:
        # Never issue a broad wildcard stop or touch unrelated services. Missing
        # future runner/tunnel units are explicit, not a failed-stop exception.
        if call('systemctl', 'show', '--property=LoadState', '--value', unit, capture=True) == 'not-found':
            continue
        call('systemctl', 'stop', unit)
        state = call('systemctl', 'show', '--property=ActiveState', '--value', unit, capture=True)
        if state not in {'inactive', 'failed'}:
            raise ValueError('A preview writer did not stop; refuse the state change.')


def guard(stop_on_failure=False, *, cleanup_logs=True):
    try:
        result = {'kernel': verify_caps(), 'storage': verify_storage()}
        groups = [(('logs',), 128 * MIB),
                  (('state/work', 'queue/work', 'queue/qualification/results', 'model/invocations', 'model/credentials'), 512 * MIB)]
        for directories, maximum in groups:
            usage = sum(p.lstat().st_size for directory in directories for p in (BASE / directory).rglob('*')
                        if p.is_file() and not p.is_symlink())
            if usage > maximum:
                raise ValueError('Preview logs or aggregate workspace exceeded its sublimit.')
        if cleanup_logs:
            for old in (BASE / 'logs').glob('*.jsonl'):
                if not old.is_symlink() and old.is_file() and old.stat().st_mtime < __import__('time').time() - 7 * 86400:
                    old.unlink()
        if shutil.disk_usage(BASE).free < 64 * MIB:
            raise ValueError('Preview filesystem has less than 64 MiB headroom.')
        return result
    except (ValueError, OSError, subprocess.CalledProcessError):
        if stop_on_failure:
            stop_preview()
        raise


def install_slice(root, expected, host_fingerprint):
    reviewed(root, expected, host_fingerprint)
    target = Path('/etc/systemd/system') / SLICE
    if target.exists():
        raise ValueError('Preview slice already exists; inspect it instead of overwriting existing units.')
    shutil.copyfile(Path(root) / 'deploy/justup-preview' / SLICE, target)
    target.chmod(0o644)
    call('systemctl', 'daemon-reload')
    call('systemctl', 'start', SLICE)


def install(root, expected, host_fingerprint):
    reviewed(root, expected, host_fingerprint)
    verify_caps()
    root_reserve(DISK_LIMIT)
    if BASE.exists() or IMAGE.exists() or IMAGE.is_symlink():
        raise ValueError('A preview path already exists; never reuse or format it automatically.')
    for name in UNITS[1:]:
        if (Path('/etc/systemd/system') / name).exists():
            raise ValueError('A preview unit already exists; refuse to overwrite it.')
    for user in (USER, RUNNER_USER, MODEL_USER):
        try:
            pwd.getpwnam(user)
        except KeyError:
            pass
        else:
            raise ValueError('A preview UID already exists; inspect it before reusing it.')
    for group in (USER, RUNNER_USER, MODEL_USER, STATE_GROUP, CLIENT_GROUP):
        try:
            grp.getgrnam(group)
        except KeyError:
            pass
        else:
            raise ValueError('A preview group already exists; inspect it before reusing it.')
    # Exclusive creation is the only path to mkfs. No supplied device is accepted.
    fd = os.open(IMAGE, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
    try:
        os.posix_fallocate(fd, 0, DISK_LIMIT)
        os.fsync(fd)
    finally:
        os.close(fd)
    format_image()
    BASE.mkdir(mode=0o755)
    for name in UNITS[1:]:
        target = Path('/etc/systemd/system') / name
        shutil.copyfile(Path(root) / 'deploy/justup-preview' / name, target)
        target.chmod(0o644)
    call('systemctl', 'daemon-reload')
    call('systemctl', 'start', 'srv-justup_preview.mount')
    for group in (STATE_GROUP, CLIENT_GROUP):
        call('groupadd', '--system', group)
    for user, groups in ((USER, STATE_GROUP), (RUNNER_USER, STATE_GROUP + ',' + CLIENT_GROUP), (MODEL_USER, None)):
        argv = ['useradd', '--system', '--user-group', '--no-create-home', '--home-dir', '/nonexistent', '--shell', '/usr/sbin/nologin']
        if groups:
            argv += ['--groups', groups]
        call(*argv, user)
    uid = pwd.getpwnam(USER)
    queue_uid = pwd.getpwnam(RUNNER_USER)
    model_uid = pwd.getpwnam(MODEL_USER)
    for path in ('releases', 'ops', 'config'):
        (BASE / path).mkdir(mode=0o755)
    for path in ('state', 'state/work', 'state/backups', 'logs'):
        folder = BASE / path
        folder.mkdir(mode=0o700)
        os.chown(folder, uid.pw_uid, uid.pw_gid)
    state = BASE / 'state'
    state.chmod(0o2770)
    os.chown(state, uid.pw_uid, grp.getgrnam(STATE_GROUP).gr_gid)
    broker = BASE / 'broker'
    broker.mkdir(mode=0o750)
    os.chown(broker, 0, grp.getgrnam(CLIENT_GROUP).gr_gid)
    for path in ('model', 'model/config', 'model/task-cwd', 'model/invocations', 'model/credentials'):
        folder = BASE / path
        folder.mkdir(mode=0o750 if path in {'model', 'model/config'} else 0o700)
        os.chown(folder, 0, model_uid.pw_gid)
    (BASE / 'model/task-cwd').chmod(0o555)
    for path in ('model/invocations', 'model/credentials'):
        os.chown(BASE / path, model_uid.pw_uid, model_uid.pw_gid)
    for path in ('queue', 'queue/config', 'queue/work', 'queue/budget'):
        folder = BASE / path
        folder.mkdir(mode=0o750 if path in {'queue', 'queue/config'} else 0o700)
        os.chown(folder, 0 if path in {'queue', 'queue/config'} else queue_uid.pw_uid, queue_uid.pw_gid)
    generation = BASE / 'state/private-generation'
    generation.write_text(str(uuid.uuid4()) + '\n')
    generation.chmod(0o600)
    os.chown(generation, uid.pw_uid, uid.pw_gid)
    for path in (Path(root) / 'scripts').glob('preview-*.py'):
        if not path.name.endswith('.test.py'):
            target = BASE / 'ops' / path.name
            shutil.copyfile(path, target)
            target.chmod(0o555)
    (BASE / '.preview-install.json').write_text(json.dumps({'planSha256': expected, 'formatVersion': 1}) + '\n')
    # Nothing is enabled or started; prove the boundary before importing data.
    return proof()


def artifact_module():
    path = Path(__file__).with_name('preview-artifact.py')
    spec = importlib.util.spec_from_file_location('preview_artifact', path)
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


def require_operator(cleanup=False, *, cleanup_logs=True):
    if os.geteuid() != 0:
        raise ValueError('Deployment and teardown require the dedicated root operator step.')
    if any(os.path.lexists(BASE / name) for name in (UPGRADE_LOCK, '.preview-schema-migration.lock')):
        raise ValueError('An operator update is pending; reconcile it before another operation.')
    if cleanup:
        verify_caps()
        # Only teardown enters this branch after validating the operator-bound
        # owned marker. Lost reservation must not block safe normal unmount.
        _verify_storage(check_reserve=False, require_preallocation=False)
    else:
        guard(cleanup_logs=cleanup_logs)


def owned_path(path, *, directory=False):
    """Never replace aliased, linked or contributor-writable operator inputs."""
    path = Path(path)
    meta = path.lstat()
    if (path.resolve(strict=True) != path or meta.st_uid != OPERATOR_UID or meta.st_mode & 0o022
            or not (stat.S_ISDIR(meta.st_mode) if directory else stat.S_ISREG(meta.st_mode))
            or (not directory and (meta.st_nlink != 1 or meta.st_size > 2 * MIB))):
        raise ValueError('Operator update paths must be canonical, root-owned and protected.')
    return meta


def sync_directory(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def write_update_file(path, data, mode=0o444):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
    with os.fdopen(fd, 'wb') as stream:
        os.fchmod(stream.fileno(), mode)
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())
        return os.fstat(stream.fileno())


def publish_receipt(marker, temporary, data):
    # The exclusive link exposes complete bytes, and the single-link requirement
    # keeps launchers closed until the private staging name is unlinked.
    write_update_file(temporary, data)
    os.link(temporary, marker, follow_symlinks=False)
    temporary.unlink()
    sync_directory(temporary.parent)
    sync_directory(marker.parent)


def verify_operator_files(folder, scripts):
    owned_path(folder, directory=True)
    if {path.name for path in folder.iterdir()} != set(scripts):
        raise ValueError('Installed operator inventory differs from the reviewed plan.')
    for name, expected in scripts.items():
        path = folder / name
        owned_path(path)
        if path.stat().st_mode & 0o222 or digest(path) != expected:
            raise ValueError('Installed operator bytes or read-only modes differ from the reviewed plan.')


def verify_operator_units(files):
    for name in (*UNITS, *BACKUP_UNITS):
        if f'deploy/justup-preview/{name}' not in files:
            continue
        target = UNIT_ROOT / name
        owned_path(target)
        if digest(target) != files[f'deploy/justup-preview/{name}']:
            raise ValueError('Installed unit bytes differ from the previous reviewed plan.')


def load_reviewed_plan(path, expected):
    owned_path(path)
    value = json.loads(path.read_text())
    if (not isinstance(value, dict) or not re.fullmatch(r'[a-f0-9]{64}', expected or '')
            or type(value.get('formatVersion')) is not int or value['formatVersion'] != 1
            or not isinstance(value.get('files'), dict)
            or any(not isinstance(key, str) or not isinstance(digest, str) or not re.fullmatch(r'[a-f0-9]{64}', digest)
                   for key, digest in value['files'].items())
            or value.get('planSha256') != expected
            or hashlib.sha256(json.dumps({key: data for key, data in value.items() if key != 'planSha256'},
                                        sort_keys=True, separators=(',', ':')).encode()).hexdigest() != expected):
        raise ValueError('Previous plan does not match its exact reviewed digest.')
    return value


def require_idle_preview():
    stop_preview()
    for unit in ('justup-preview-guard.timer', 'justup-preview-guard.service'):
        call('systemctl', 'stop', unit)
        if call('systemctl', 'show', '--property=ActiveState', '--value', unit, capture=True) not in {'inactive', 'failed'}:
            raise ValueError('A preview guard did not stop.')
    uids = {pwd.getpwnam(name).pw_uid for name in (USER, RUNNER_USER, MODEL_USER)}
    for path in PROC_ROOT.iterdir():
        try:
            if not path.name.isdigit():
                continue
            # Nondumpable processes can have root-owned /proc directories.
            # The kernel status identities, not directory ownership, prove idle.
            identity = next((line.split()[1:] for line in (path / 'status').read_text().splitlines()
                             if line.startswith('Uid:')), [])
            if len(identity) != 4 or any(not value.isdigit() for value in identity):
                raise ValueError('Could not verify a running process identity.')
            if any(int(value) in uids for value in identity):
                raise ValueError('Dedicated preview identities must have no running processes.')
        except (FileNotFoundError, ProcessLookupError):
            continue


def _feed_key_identity():
    """Bind the probe to the still-restricted, root-owned deploy key."""
    deploy = pwd.getpwnam('justup-deploy')
    home = Path(deploy.pw_dir)
    owned_path(home, directory=True)
    owned_path(home / '.ssh', directory=True)
    key_path = home / '.ssh/authorized_keys'
    owned_path(key_path)
    data = key_path.read_bytes()
    lines = [line for line in data.splitlines() if line.strip()]
    if len(lines) != 1:
        raise ValueError('The deploy key must retain its exact identity-probe command.')
    options, separator, key = lines[0].partition(b' ssh-ed25519 ')
    if (not separator or not key or options.split(b',').count(b'command="/usr/bin/id"') != 1
            or any(b'command=' in option for option in options.split(b',')
                   if option != b'command="/usr/bin/id"')):
        raise ValueError('The deploy key must retain its exact identity-probe command.')
    return key_path, digest(key_path), deploy


def _probe_receiver_cgroup():
    api_uid = pwd.getpwnam(USER).pw_uid
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        for path in PROC_ROOT.iterdir():
            if not path.name.isdigit():
                continue
            try:
                status = (path / 'status').read_text()
                ids = next(line.split()[1:] for line in status.splitlines() if line.startswith('Uid:'))
                command = (path / 'cmdline').read_bytes().rstrip(b'\x00').split(b'\x00')
                group = (path / 'cgroup').read_text()
            except (FileNotFoundError, ProcessLookupError, StopIteration):
                continue
            if (len(ids) == 4 and all(value.isdigit() for value in ids)
                    and all(int(value) == api_uid for value in ids)
                    and command == [b'/usr/bin/python3', os.fsencode(BASE / 'ops/preview-feed.py'), b'receive']):
                if not any(SLICE in Path(line[3:]).parts
                           and re.fullmatch(r'justup-preview-feed@[^/]+\.service', Path(line[3:]).name)
                           for line in group.splitlines()
                           if line.startswith('0::')):
                    raise ValueError('The feed receiver is outside the preview slice.')
                return
        time.sleep(0.1)
    raise ValueError('The bounded feed receiver did not start inside the preview slice.')


def _verify_feed_probe_storage(inbox, receipt_dir, api_uid):
    """Invalid input may leave only the receiver's persistent, idle lock."""
    if any(receipt_dir.iterdir()) or {path.name for path in inbox.iterdir()} - {'.receive.lock'}:
        raise ValueError('Synthetic refusal left feed content or receipts.')
    lock = inbox / '.receive.lock'
    if not os.path.lexists(lock):
        return
    fd = os.open(lock, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        meta = os.fstat(fd)
        if (not stat.S_ISREG(meta.st_mode) or meta.st_uid != api_uid or meta.st_nlink != 1
                or stat.S_IMODE(meta.st_mode) != 0o600 or meta.st_size != 0):
            raise ValueError('The receiver lock has unsafe identity or content.')
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise ValueError('The feed receiver still holds its intake lock.') from None
    finally:
        os.close(fd)


def qualify_feed_units():
    """Temporarily prove the exact installed receiver; leave intake disabled."""
    socket_unit = FEED_UNITS[0]
    key_path, old_key_digest, deploy = _feed_key_identity()
    for name in FEED_UNITS:
        call('systemd-analyze', 'verify', str(UNIT_ROOT / name))
    if (call('systemctl', 'show', '--property=UnitFileState', '--value', socket_unit, capture=True) != 'disabled'
            or call('systemctl', 'show', '--property=ActiveState', '--value', socket_unit, capture=True) != 'inactive'
            or os.path.lexists(FEED_SOCKET)):
        raise ValueError('The new feed socket must begin disabled and inactive.')
    subprocess.run(['/usr/bin/python3', str(BASE / 'ops/preview-feed.py'), 'prepare'],
                   check=True, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                   stderr=subprocess.DEVNULL, timeout=30,
                   env={'PATH': '/usr/bin:/bin', 'LANG': 'C', 'PYTHONDONTWRITEBYTECODE': '1'})
    inbox = BASE / 'state/feed-inbox'
    receipt_dir = BASE / 'config/feed-receipts'
    api_uid = pwd.getpwnam(USER).pw_uid
    if (not stat.S_ISDIR(inbox.lstat().st_mode) or inbox.stat().st_uid != api_uid
            or stat.S_IMODE(inbox.stat().st_mode) != 0o700
            or not stat.S_ISDIR(receipt_dir.lstat().st_mode) or receipt_dir.stat().st_uid != 0
            or stat.S_IMODE(receipt_dir.stat().st_mode) != 0o700):
        raise ValueError('The private feed paths have unsafe ownership or modes.')
    _verify_feed_probe_storage(inbox, receipt_dir, api_uid)
    # Connect as the deploy UID, then hold the socket open so the actual
    # socket-activated service can be observed in /proc before refusing bytes.
    probe_code = ('import socket,sys; s=socket.socket(socket.AF_UNIX); s.connect(sys.argv[1]); '
                  'sys.stdout.write("ready\\n"); sys.stdout.flush(); sys.stdin.buffer.read(1); '
                  's.sendall(b"invalid\\n"); s.shutdown(socket.SHUT_WR); '
                  'response=s.recv(1024); s.close(); sys.exit(0 if response==b"" else 1)')
    def demote():
        os.setgroups([])
        os.setgid(deploy.pw_gid)
        os.setuid(deploy.pw_uid)
    process = None
    try:
        call('systemctl', 'start', socket_unit)
        meta = FEED_SOCKET.lstat()
        if (not stat.S_ISSOCK(meta.st_mode) or meta.st_uid != deploy.pw_uid
                or stat.S_IMODE(meta.st_mode) != 0o600):
            raise ValueError('The feed socket permits an unexpected identity.')
        process = subprocess.Popen(['/usr/bin/python3', '-c', probe_code, str(FEED_SOCKET)],
                                   stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                   stderr=subprocess.DEVNULL, preexec_fn=demote,
                                   env={'PATH': '/usr/bin:/bin', 'LANG': 'C'})
        ready, _, _ = select.select([process.stdout], [], [], 5)
        if not ready or process.stdout.readline() != b'ready\n':
            raise ValueError('The deploy UID could not reach the feed socket.')
        _probe_receiver_cgroup()
        process.stdin.write(b'x')
        process.stdin.flush()
        if process.wait(timeout=5) != 0:
            raise ValueError('The receiver did not refuse synthetic invalid input.')
        _verify_feed_probe_storage(inbox, receipt_dir, api_uid)
    finally:
        if process is not None and process.poll() is None:
            process.kill()
            process.wait(timeout=5)
        call('systemctl', 'stop', socket_unit)
    if (call('systemctl', 'show', '--property=ActiveState', '--value', socket_unit, capture=True) != 'inactive'
            or call('systemctl', 'show', '--property=UnitFileState', '--value', socket_unit, capture=True) != 'disabled'
            or os.path.lexists(FEED_SOCKET) or digest(key_path) != old_key_digest):
        raise ValueError('The feed intake did not return to its disabled identity.')


def upgrade_ops(root, previous_plan_path, previous_sha, expected, host_fingerprint):
    """Swap only a complete stopped operator directory; retain all private state."""
    return _upgrade_operator(root, previous_plan_path, previous_sha, expected, host_fingerprint)


def upgrade_feed(root, previous_plan_path, previous_sha, expected, host_fingerprint):
    """Install only the reviewed private feed script and disabled unit pair."""
    return _upgrade_operator(root, previous_plan_path, previous_sha, expected, host_fingerprint, addition='feed')


def upgrade_drill(root, previous_plan_path, previous_sha, expected, host_fingerprint):
    """Adopt only the prepared drill helper; never execute it or change units."""
    return _upgrade_operator(root, previous_plan_path, previous_sha, expected, host_fingerprint, addition='drill')


def upgrade_backup(root, previous_plan_path, previous_sha, expected, host_fingerprint):
    """Adopt the fixed backup unit pair with the schedule disabled."""
    return _upgrade_operator(root, previous_plan_path, previous_sha, expected, host_fingerprint, addition='backup')


def verify_loaded_backup_unit(unit):
    if (call('systemctl', 'show', '--property=FragmentPath', '--value', unit, capture=True) != str(UNIT_ROOT / unit)
            or call('systemctl', 'show', '--property=DropInPaths', '--value', unit, capture=True)
            or call('systemctl', 'show', '--property=NeedDaemonReload', '--value', unit, capture=True) != 'no'):
        raise ValueError('The loaded backup unit differs from its reviewed file.')


def verify_inactive_backup_units():
    for unit, expected in ((BACKUP_TIMER, 'disabled'), (BACKUP_SERVICE, 'static')):
        verify_loaded_backup_unit(unit)
        if (call('systemctl', 'show', '--property=UnitFileState', '--value', unit, capture=True) != expected
                or call('systemctl', 'show', '--property=ActiveState', '--value', unit, capture=True) != 'inactive'):
            raise ValueError('Backup units must load from their exact paths and remain inactive and unenabled.')


def qualify_backup_units():
    call('systemd-analyze', 'verify', *(str(UNIT_ROOT / name) for name in BACKUP_UNITS))
    verify_inactive_backup_units()


def remove_owned_backup_unit(target, expected_inode, checksum):
    # Quarantine on the systemd filesystem so the rename takes the actual
    # inode at the live path. A competing unit can never be unlinked here.
    quarantine = Path(tempfile.mkdtemp(prefix='.justup-backup-unit-', dir=UNIT_ROOT))
    moved = quarantine / target.name
    try:
        target.rename(moved)
    except OSError:
        quarantine.rmdir()
        raise
    sync_directory(quarantine)
    sync_directory(UNIT_ROOT)
    try:
        actual = owned_path(moved)
        if (actual.st_dev, actual.st_ino) != (expected_inode.st_dev, expected_inode.st_ino) or digest(moved) != checksum:
            raise ValueError('The quarantined unit is not the one the operator verified.')
    except (ValueError, OSError) as error:
        # Restore without overwriting a replacement installed after the rename.
        # If the path is now occupied, preserve the quarantined file for review.
        os.link(moved, target, follow_symlinks=False)
        moved.unlink()
        quarantine.rmdir()
        sync_directory(UNIT_ROOT)
        raise ValueError('A backup unit changed during removal; retain pending state.') from error
    moved.unlink()
    quarantine.rmdir()
    sync_directory(UNIT_ROOT)


def _upgrade_operator(root, previous_plan_path, previous_sha, expected, host_fingerprint, *, addition=None):
    previous_plan_path = Path(previous_plan_path).absolute()
    previous = load_reviewed_plan(previous_plan_path, previous_sha)
    old_backup = BACKUP_ADDITIONS & previous['files'].keys()
    if old_backup and old_backup != BACKUP_ADDITIONS:
        raise ValueError('The previous plan has an incomplete backup inventory.')
    add_feed, add_drill, add_backup = addition == 'feed', addition == 'drill', addition == 'backup'
    include_backup = add_backup or bool(old_backup)
    reviewed(root, expected, host_fingerprint, include_backup=include_backup)
    require_operator()
    root = Path(root).absolute()
    owned_path(root, directory=True)
    owned_path(root / 'scripts', directory=True)
    owned_path(UNIT_ROOT, directory=True)
    candidate = plan(root, host_fingerprint, include_backup=include_backup)
    if candidate['planSha256'] != expected:
        raise ValueError('The proposed plan changed during operator update preparation.')
    unchanged = lambda value: {key: item for key, item in value.items() if key not in {'files', 'planSha256'}}
    old_files, new_files = previous['files'], candidate['files']
    if previous_sha == expected or unchanged(previous) != unchanged(candidate):
        raise ValueError('Operator updates cannot change the host or resource boundary.')
    if add_feed:
        if (set(new_files) - set(old_files) != FEED_ADDITIONS or set(old_files) - set(new_files)
                or any(old_files[key] != new_files[key] for key in old_files if key != 'scripts/preview-host.py')):
            raise ValueError('Feed upgrade accepts only the exact reviewed script and unit additions.')
    elif add_drill:
        if set(new_files) - set(old_files) != DRILL_ADDITIONS or set(old_files) - set(new_files):
            raise ValueError('Drill upgrade accepts only the exact reviewed helper addition without removals.')
    elif add_backup:
        if set(new_files) - set(old_files) != BACKUP_ADDITIONS or set(old_files) - set(new_files):
            raise ValueError('Backup upgrade accepts only the exact reviewed timer and service additions.')
    elif old_files.keys() != new_files.keys():
        raise ValueError('Operator updates cannot change inventory paths.')
    scripts = {Path(name).name: checksum for name, checksum in previous['files'].items() if name.startswith('scripts/')}
    new_scripts = {Path(name).name: checksum for name, checksum in candidate['files'].items() if name.startswith('scripts/')}
    for name, checksum in previous['files'].items():
        if not name.startswith('scripts/') and candidate['files'][name] != checksum:
            raise ValueError('Operator updates cannot change units, native runtime pins or licenses.')
    verify_operator_units(previous['files'])
    added_units = FEED_UNITS if add_feed else BACKUP_UNITS if add_backup else ()
    for name in added_units:
        if (os.path.lexists(UNIT_ROOT / name) or (add_backup and
                call('systemctl', 'show', '--property=LoadState', '--value', name, capture=True) != 'not-found')):
            raise ValueError(f'A new {addition} unit path already exists; inspect it before installing.')
        owned_path(root / 'deploy/justup-preview' / name)
    for name in new_scripts:
        owned_path(root / 'scripts' / name)
    owned_path(BASE, directory=True)
    verify_operator_files(BASE / 'ops', scripts)
    marker = BASE / '.preview-install.json'
    marker_meta = owned_path(marker)
    marker_data = marker.read_bytes()
    marker_value = json.loads(marker_data)
    if (marker_meta.st_size > 4096 or not isinstance(marker_value, dict)
            or type(marker_value.get('formatVersion')) is not int
            or marker_value != {'formatVersion': 1, 'planSha256': previous_sha}):
        raise ValueError('Live receipt differs from the previous reviewed plan.')
    history_root = BASE / '.preview-ops-updates'
    if not history_root.exists():
        history_root.mkdir(mode=0o700)
    owned_path(history_root, directory=True)
    if stat.S_IMODE(history_root.stat().st_mode) != 0o700:
        raise ValueError('Operator history must remain private mode 0700.')
    if history_root.stat().st_dev != BASE.stat().st_dev or (BASE / 'ops').stat().st_dev != BASE.stat().st_dev:
        raise ValueError('Operator directories must remain inside the allocated filesystem.')
    history = history_root / (previous_sha + '-' + expected)
    lock = BASE / UPGRADE_LOCK
    fd = os.open(lock, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    lock_meta = os.fstat(fd)
    os.fsync(fd)
    os.close(fd)
    sync_directory(BASE)
    withdrawn = moved_old = moved_new = qualified = history_created = False
    installed_units = {}
    try:
        history.mkdir(mode=0o700)
        history_created = True
        sync_directory(history_root)
        new_ops = history / 'prepared-ops'
        new_ops.mkdir(mode=0o755)
        for name, checksum in new_scripts.items():
            write_update_file(new_ops / name, (root / 'scripts' / name).read_bytes(), 0o555)
        verify_operator_files(new_ops, new_scripts)
        new_ops.chmod(0o755)
        sync_directory(new_ops)
        write_update_file(history / 'previous-plan.json', previous_plan_path.read_bytes())
        write_update_file(history / 'new-plan.json', (json.dumps(candidate, sort_keys=True) + '\n').encode())
        sync_directory(history)
        require_idle_preview()
        guard()
        verify_operator_files(BASE / 'ops', scripts)
        actual = owned_path(marker)
        if (actual.st_dev, actual.st_ino) != (marker_meta.st_dev, marker_meta.st_ino) or marker.read_bytes() != marker_data:
            raise ValueError('The live receipt changed during update preparation.')
        marker.rename(history / 'previous-receipt.json')
        withdrawn = True
        sync_directory(history)
        sync_directory(BASE)
        (BASE / 'ops').rename(history / 'previous-ops')
        moved_old = True
        new_ops.rename(BASE / 'ops')
        moved_new = True
        sync_directory(history)
        sync_directory(BASE)
        verify_operator_files(BASE / 'ops', new_scripts)
        if added_units:
            for name in added_units:
                key = f'deploy/justup-preview/{name}'
                # An exclusive create may succeed before a later write/fsync
                # fails. Track the attempt so unknown partial bytes can never
                # escape rollback verification and restore the old receipt.
                installed_units[name] = None
                installed_units[name] = write_update_file(UNIT_ROOT / name, (root / key).read_bytes(), 0o644)
            sync_directory(UNIT_ROOT)
            call('systemctl', 'daemon-reload')
        verify_operator_units(candidate['files'])
        if add_feed:
            qualify_feed_units()
            require_idle_preview()
        if add_backup:
            qualify_backup_units()
        guard()
        publish_receipt(marker, history / 'new-receipt.tmp',
                        (json.dumps({'formatVersion': 1, 'planSha256': expected}) + '\n').encode())
        qualified = True
        return {'previousPlanSha256': previous_sha, 'planSha256': expected, 'operatorFiles': len(new_scripts),
                'feedUnitsInstalled': add_feed,
                'feedInboxPrepared': add_feed,
                'drillHelperInstalled': add_drill,
                'backupUnitsInstalled': add_backup,
                'privateStateTouched': False, 'activated': False}
    except Exception:
        if not withdrawn and history_created:
            # Preparation has not changed live files. Discard only this new
            # private history after re-proving the old receipt and inventory.
            current = owned_path(marker)
            if ((current.st_dev, current.st_ino) != (marker_meta.st_dev, marker_meta.st_ino)
                    or marker.read_bytes() != marker_data):
                raise ValueError('The old receipt changed; retain the pending lock for review.')
            verify_operator_files(BASE / 'ops', scripts)
            verify_operator_units(previous['files'])
            guard()
            owned_path(history, directory=True)
            shutil.rmtree(history)
            sync_directory(history_root)
            qualified = True
        if withdrawn:
            # A missing receipt is the fail-closed state for a crash or a failed
            # rollback. Never restore it over unknown or partly replaced bytes.
            if os.path.lexists(marker):
                raise ValueError('A receipt appeared during update publication; retain the pending lock for review.')
            if add_feed:
                # Qualification may have started a real receiver. Prove every
                # dedicated identity idle before restoring files or a receipt.
                require_idle_preview()
            if moved_new:
                (BASE / 'ops').rename(history / 'rejected-ops')
            if moved_old:
                (history / 'previous-ops').rename(BASE / 'ops')
            if installed_units:
                removable_units = []
                for name, written in installed_units.items():
                    target = UNIT_ROOT / name
                    if add_backup and not os.path.lexists(target):
                        continue
                    actual = owned_path(target)
                    same_written_inode = written is not None and (written.st_dev, written.st_ino) == (actual.st_dev, actual.st_ino)
                    if ((add_backup and not same_written_inode)
                            or digest(target) != candidate['files'][f'deploy/justup-preview/{name}']):
                        raise ValueError(f'A {addition} unit changed during rollback; retain pending state.')
                    if name == BACKUP_TIMER and call('systemctl', 'show', '--property=UnitFileState', '--value', name,
                                                     capture=True) != 'disabled':
                        raise ValueError('The backup timer enablement changed during rollback; retain pending state.')
                    if add_backup:
                        verify_loaded_backup_unit(name)
                        if call('systemctl', 'show', '--property=ActiveState', '--value', name, capture=True) != 'inactive':
                            raise ValueError('A backup unit became active during rollback; retain pending state.')
                    removable_units.append(target)
                for target in removable_units:
                    if add_backup:
                        written = installed_units[target.name]
                        checksum = candidate['files'][f'deploy/justup-preview/{target.name}']
                        remove_owned_backup_unit(target, written, checksum)
                    else:
                        target.unlink()
                sync_directory(UNIT_ROOT)
                call('systemctl', 'daemon-reload')
            if add_backup and any(os.path.lexists(UNIT_ROOT / name) for name in BACKUP_UNITS):
                raise ValueError('A backup unit still occupies the new inventory; retain pending state.')
            sync_directory(history)
            sync_directory(BASE)
            verify_operator_files(BASE / 'ops', scripts)
            verify_operator_units(previous['files'])
            guard()
            publish_receipt(marker, history / 'rollback-receipt.tmp', marker_data)
        qualified = True
        raise
    finally:
        if qualified and lock.exists() and (lock.lstat().st_dev, lock.lstat().st_ino) == (lock_meta.st_dev, lock_meta.st_ino):
            lock.unlink()
            sync_directory(BASE)


def stage(bundle, expected):
    require_operator()
    artifact = artifact_module()
    manifest, _ = artifact.read_bundle(bundle, expected, retain_files=False)
    release = BASE / 'releases' / manifest['buildIdentity']
    if release.exists() or release.is_symlink():
        raise ValueError('Build directory already exists; verify it instead of changing immutable bytes.')
    retained = list((BASE / 'releases').iterdir())
    if len(retained) >= 2 or any(path.is_symlink() or not path.is_dir() for path in retained):
        raise ValueError('Retain at most two reviewed release directories; review cleanup before staging another.')
    # The uncompressed tar is at least as large as its payload. Verification and
    # extraction stream one member at a time inside the aggregate memory limit.
    required = Path(bundle).stat().st_size + 64 * MIB
    if shutil.disk_usage(BASE).free < required:
        raise ValueError('Insufficient preview quota headroom for this candidate.')
    release.mkdir(mode=0o755)
    copied, _ = artifact.read_bundle(bundle, expected, retain_files=False, output_directory=release)
    if copied != manifest:
        raise ValueError('Bundle identity changed while staging.')
    manifest_path = release / 'manifest.json'
    with manifest_path.open('x') as stream:
        stream.write(json.dumps(manifest, sort_keys=True) + '\n')
        stream.flush()
        os.fsync(stream.fileno())
    manifest_path.chmod(0o444)
    for folder in sorted(release.rglob('*'), reverse=True):
        if folder.is_dir():
            folder.chmod(0o555)
    release.chmod(0o555)
    artifact.verify_directory(release)
    return {'staged': manifest['buildIdentity'], 'sourceCommit': manifest['sourceCommit'], 'activated': False}


def point_link(name, target):
    temporary = BASE / ('.' + name + '-' + str(uuid.uuid4()))
    temporary.symlink_to(target)
    os.replace(temporary, BASE / name)
    fd = os.open(BASE, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def switch(build):
    require_operator()
    if not re.fullmatch(r'[a-f0-9]{64}', build or ''):
        raise ValueError('An exact retained build identity is required.')
    artifact = artifact_module()
    release = BASE / 'releases' / build
    manifest = artifact.verify_directory(release)
    current = BASE / 'current'
    if current.exists():
        old = current.resolve(strict=True)
        if old.parent != BASE / 'releases':
            raise ValueError('Existing current link leaves the release directory.')
        artifact.verify_directory(old)
    else:
        old = None
    stop_preview()
    artifact.check_database_schema(BASE / 'state/preview.sqlite', manifest, allow_missing=True)
    if old is not None:
        point_link('previous', old.relative_to(BASE))
    point_link('current', release.relative_to(BASE))
    # Activation is separate. Never start a half-configured or policy-unreviewed
    # public preview just because a release was staged or rolled back.
    return {'current': build, 'apiStopped': True, 'activated': False}


def coverage_file(path, group):
    meta = path.lstat()
    if (not stat.S_ISREG(meta.st_mode) or meta.st_uid != OPERATOR_UID or meta.st_gid != group
            or stat.S_IMODE(meta.st_mode) != 0o640 or meta.st_nlink != 1
            or not 0 < meta.st_size <= COVERAGE_ARTIFACT_BYTES
            or not re.fullmatch(r'\d{4}-\d{2}-\d{2}\.json', path.name)
            or date.fromisoformat(path.stem).weekday() != 0):
        raise ValueError('Source coverage inventory contains an unsafe or unresolved entry.')


def luna_grant(prefix, checksum, manifest, expected_plan, queue_gid):
    path = prefix / 'grant.json'
    meta = owned_path(path)
    if meta.st_gid != queue_gid or stat.S_IMODE(meta.st_mode) != 0o640 or not 0 < meta.st_size <= 8192:
        raise ValueError('Luna qualification requires the root-owned queue group grant.')
    raw = path.read_bytes()
    if hashlib.sha256(raw).hexdigest() != checksum:
        raise ValueError('Luna qualification grant differs from the reviewed bytes.')
    value = json.loads(raw)
    identity = {'buildIdentity': manifest['buildIdentity'], 'sourceCommit': manifest['sourceCommit'],
                'hostPlanSha256': expected_plan, 'manifestSha256': manifest['files'][LUNA_MANIFEST]}
    if (not isinstance(value, dict)
            or set(value) != set(identity) | {'kind', 'schemaVersion', 'runId', 'notBefore', 'expiresAt', 'reviewPublicKey'}
            or type(value['schemaVersion']) is not int or value['schemaVersion'] != 2
            or value['kind'] != 'luna_qualification_once' or any(value[key] != item for key, item in identity.items())
            or not isinstance(value['runId'], str) or not re.fullmatch(r'[0-9a-f]{32}', value['runId'])):
        raise ValueError('Luna qualification grant does not bind this build, plan and case manifest.')
    times = [value[name] for name in ('notBefore', 'expiresAt')]
    if any(not isinstance(instant, str) or not re.fullmatch(r'\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z', instant)
           for instant in times):
        raise ValueError('Luna qualification grant requires UTC start and expiry timestamps.')
    start, end = (datetime.fromisoformat(instant).timestamp() for instant in times)
    if not start <= datetime.now(timezone.utc).timestamp() < end <= start + 300:
        raise ValueError('Luna qualification requires a current grant of at most five minutes.')
    encoded_key = value['reviewPublicKey']
    if not isinstance(encoded_key, str) or len(encoded_key) > 684:
        raise ValueError('Luna qualification requires a bounded reviewer public key.')
    key = base64.b64decode(encoded_key, validate=True)
    if not key or len(key) > 512 or base64.b64encode(key).decode('ascii') != encoded_key:
        raise ValueError('Luna qualification requires a canonical reviewer public key.')
    return {**identity, 'grantSha256': checksum, 'runId': value['runId'],
            'reviewKeySha256': hashlib.sha256(key).hexdigest()}


def luna_result_receipt(path, identity, queue_user):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, 'rb') as stream:
        before = os.fstat(stream.fileno())
        if (not stat.S_ISREG(before.st_mode) or before.st_uid != queue_user.pw_uid
                or before.st_gid != queue_user.pw_gid or stat.S_IMODE(before.st_mode) != 0o600
                or before.st_nlink != 1 or not 0 < before.st_size <= LUNA_RESULT_LIMIT):
            raise ValueError('Luna result must be a single private bounded file.')
        raw = stream.read(LUNA_RESULT_LIMIT + 1)
        after = os.fstat(stream.fileno())
        if (not raw.endswith(b'\n') or len(raw) != before.st_size or after.st_size != before.st_size
                or before.st_mtime_ns != after.st_mtime_ns or before.st_ctime_ns != after.st_ctime_ns):
            raise ValueError('Luna result changed during read or was incomplete.')
        os.fsync(stream.fileno())
    lines = raw[:-1].split(b'\n')
    if not 2 <= len(lines) <= 45 or any(not line or len(line) > 8192 for line in lines):
        raise ValueError('Luna result does not match its bounded record format.')
    header, summary = json.loads(lines[0]), json.loads(lines[-1])
    if (header != {'kind': 'luna_qualification_start', 'version': 2, **identity}
            or not isinstance(summary, dict) or summary.get('kind') != 'summary'
            or not isinstance(summary.get('reportSha256'), str) or not re.fullmatch(r'[a-f0-9]{64}', summary['reportSha256'])):
        raise ValueError('Luna result lacks the exact run identity and terminal summary.')
    return {**identity, 'resultSha256': hashlib.sha256(raw).hexdigest(), 'reportSha256': summary['reportSha256']}


def luna_command(checksum):
    readonly = ('current', 'broker', '.preview-install.json', 'queue/qualification/grant.json')
    masked = ('state', 'config', 'model', 'logs', 'queue/config', 'queue/budget', 'queue/work',
              'queue/source-coverage-v1', 'queue/source-coverage-v2', 'queue/qualification/receipts')
    restricted_paths = [f'-{BASE / path}' for path in masked]
    restricted_paths += ['-/run/docker.sock', '-/var/run/docker.sock', '-/mnt/murmur', '-/root', '-/home']
    return [
        '/usr/bin/systemd-run', f'--unit={LUNA_UNIT}', '--wait', '--collect', '--quiet', f'--slice={SLICE}',
        f'--uid={RUNNER_USER}', f'--gid={RUNNER_USER}',
        '--service-type=exec', '--property=RuntimeMaxSec=2700s', '--property=TimeoutStopSec=15s',
        '--property=KillMode=control-group', '--property=UMask=0077', '--property=NoNewPrivileges=yes',
        '--property=CapabilityBoundingSet=', '--property=AmbientCapabilities=',
        '--property=ProtectSystem=strict', '--property=ProtectHome=yes', '--property=PrivateDevices=yes',
        '--property=PrivateNetwork=yes', '--property=RestrictAddressFamilies=AF_UNIX',
        '--property=TemporaryFileSystem=/run:ro /tmp:ro /var/tmp:ro',
        '--property=ProtectKernelTunables=yes', '--property=ProtectKernelModules=yes',
        '--property=ProtectKernelLogs=yes', '--property=ProtectControlGroups=yes',
        '--property=ProtectClock=yes', '--property=ProtectHostname=yes', '--property=RestrictSUIDSGID=yes',
        '--property=RestrictRealtime=yes', '--property=LockPersonality=yes', '--property=SystemCallArchitectures=native',
        '--property=LimitCORE=0', '--property=LimitNOFILE=256', '--property=LimitNPROC=64',
        '--property=StandardInput=null', '--property=StandardOutput=null', '--property=StandardError=null',
        f'--property=WorkingDirectory={BASE / "current/app"}',
        f'--property=ReadWritePaths={BASE / "queue/qualification/results"}',
        '--property=ReadOnlyPaths=' + ' '.join(str(BASE / path) for path in readonly),
        '--property=InaccessiblePaths=' + ' '.join(restricted_paths),
        '/usr/bin/env', '-i', 'LANG=C.UTF-8', 'TZ=UTC', f'JUSTUP_LUNA_GRANT_SHA256={checksum}',
        '/usr/bin/python3', '-I', str(BASE / 'ops/preview-queue-run.py'), '--qualify-model',
    ]


def require_idle_luna_broker():
    if (call('systemctl', 'show', '--property=ActiveState', '--value',
             'justup-preview-model.socket', capture=True) != 'active'
            or call('systemctl', 'show', '--property=ActiveState', '--value',
                    'justup-preview-model.service', capture=True) != 'inactive'):
        raise ValueError('Luna qualification requires the active broker socket and a stopped broker.')
    path = BASE / 'model/invocations'
    meta = path.lstat()
    model_uid = pwd.getpwnam(MODEL_USER).pw_uid
    if (path.resolve(strict=True) != path or not stat.S_ISDIR(meta.st_mode) or meta.st_dev != BASE.stat().st_dev
            or model_uid == 0 or meta.st_uid != model_uid or stat.S_IMODE(meta.st_mode) != 0o700
            or next(path.iterdir(), None) is not None):
        raise ValueError('Retained or unsafe broker invocations require operator review.')


def run_luna_qualification(checksum, build, expected_plan):
    if any(not isinstance(value, str) or not re.fullmatch(r'[a-f0-9]{64}', value)
           for value in (checksum, build, expected_plan)):
        raise ValueError('Exact reviewed grant, build and host plan hashes are required.')
    require_operator(cleanup_logs=False)
    artifact = artifact_module()
    release = BASE / 'releases' / build
    if (BASE / 'current').resolve(strict=True) != release or artifact.read_host_plan(BASE) != expected_plan:
        raise ValueError('Luna qualification requires the exact active build and installed host plan.')
    owned_path(release, directory=True)
    manifest = artifact.verify_directory(release)
    if manifest['buildIdentity'] != build or not {LUNA_MANIFEST, LUNA_REVIEW} <= manifest['files'].keys():
        raise ValueError('The active preview release lacks the fixed Luna case inventory.')
    if call('systemctl', 'show', '--property=LoadState', '--value', LUNA_UNIT, capture=True) != 'not-found':
        raise ValueError('The fixed transient qualification name is already loaded.')
    for unit in APPLICATION_UNITS:
        if call('systemctl', 'show', '--property=ActiveState', '--value', unit, capture=True) not in {'inactive', 'failed'}:
            raise ValueError('Stop the ordinary preview application before qualification.')
    require_idle_luna_broker()

    folder = BASE / 'queue/qualification'
    queue_user = pwd.getpwnam(RUNNER_USER)
    meta = owned_path(folder, directory=True)
    if (queue_user.pw_uid == 0 or queue_user.pw_gid == 0 or meta.st_dev != BASE.stat().st_dev
            or meta.st_gid != queue_user.pw_gid or stat.S_IMODE(meta.st_mode) != 0o750):
        raise ValueError('Luna qualification requires protected queue-only storage on the preview mount.')
    proofs, results = folder / 'receipts', folder / 'results'
    proof_meta = owned_path(proofs, directory=True)
    result_meta = results.lstat()
    if (proof_meta.st_dev != meta.st_dev or stat.S_IMODE(proof_meta.st_mode) != 0o700
            or not stat.S_ISDIR(result_meta.st_mode) or result_meta.st_dev != meta.st_dev
            or result_meta.st_uid != queue_user.pw_uid or result_meta.st_gid != queue_user.pw_gid
            or stat.S_IMODE(result_meta.st_mode) != 0o700):
        raise ValueError('Luna qualification receipt and result storage must keep their dedicated owners and modes.')
    receipt = luna_grant(folder, checksum, manifest, expected_plan, queue_user.pw_gid)
    run_id = receipt['runId']
    fd = os.open(proofs, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if sum(1 for _ in proofs.iterdir()) > 30 or sum(1 for _ in results.iterdir()) >= 8:
            raise ValueError('Review retained qualification evidence before making another run.')
        if (BASE / 'current').resolve(strict=True) != release or artifact.read_host_plan(BASE) != expected_plan:
            raise ValueError('The build or host plan changed before Luna qualification.')
        require_idle_luna_broker()
        write_update_file(proofs / (run_id + '.json'), (json.dumps(receipt, sort_keys=True) + '\n').encode(), 0o400)
        os.fsync(fd)
        subprocess.run(luna_command(checksum), check=True,
                       env={'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8', 'TZ': 'UTC'})
        receipt = luna_result_receipt(results / ('luna-qualification-' + run_id + '.jsonl'), receipt, queue_user)
        sync_directory(results)
        write_update_file(proofs / (run_id + '.result.json'), (json.dumps(receipt, sort_keys=True) + '\n').encode(), 0o400)
        os.fsync(fd)
    finally:
        os.close(fd)
    return receipt


def jev_command(checksum, build, expected_plan):
    # Same queue identity and network restrictions as the regular runner. The
    # synthetic suite only needs state, its ledger, and the ordinary provider.
    masked = ('config', 'model', 'logs', 'broker/model.sock',
              'queue/source-coverage-v1', 'queue/source-coverage-v2', 'queue/qualification')
    restricted_paths = [f'-{BASE / path}' for path in masked]
    restricted_paths += ['-/run/docker.sock', '-/var/run/docker.sock', '-/mnt/murmur', '-/root', '-/home']
    return [
        '/usr/bin/systemd-run', f'--unit={JEV_UNIT}', '--wait', '--pipe', '--collect', '--quiet', f'--slice={SLICE}',
        f'--uid={RUNNER_USER}', f'--gid={RUNNER_USER}', '--service-type=exec',
        '--property=RuntimeMaxSec=150s', '--property=TimeoutStopSec=15s', '--property=KillMode=control-group',
        '--property=UMask=0007', '--property=NoNewPrivileges=yes', '--property=CapabilityBoundingSet=',
        '--property=AmbientCapabilities=', '--property=ProtectSystem=strict', '--property=ProtectHome=yes',
        '--property=PrivateDevices=yes', '--property=PrivateTmp=yes', '--property=TemporaryFileSystem=/tmp:ro /var/tmp:ro',
        '--property=RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6',
        '--property=IPAddressDeny=127.0.0.0/8 ::1/128 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 169.254.0.0/16 fc00::/7 fe80::/10',
        '--property=IPAddressAllow=127.0.0.53/32', '--property=ProtectKernelTunables=yes',
        '--property=ProtectKernelModules=yes', '--property=ProtectKernelLogs=yes', '--property=ProtectControlGroups=yes',
        '--property=ProtectClock=yes', '--property=ProtectHostname=yes', '--property=RestrictSUIDSGID=yes',
        '--property=RestrictRealtime=yes', '--property=LockPersonality=yes', '--property=SystemCallArchitectures=native',
        '--property=LimitCORE=0', '--property=LimitNOFILE=256', '--property=LimitNPROC=64',
        f'--property=WorkingDirectory={BASE / "current/app"}',
        '--property=ReadWritePaths=' + ' '.join(str(BASE / path) for path in ('state', 'queue/budget')),
        '--property=InaccessiblePaths=' + ' '.join(restricted_paths),
        '/usr/bin/env', '-i', 'LANG=C.UTF-8', 'TZ=UTC', f'JUSTUP_JEV_REVIEWED_FIXTURE={checksum}',
        f'JUSTUP_JEV_REVIEWED_BUILD={build}', f'JUSTUP_JEV_REVIEWED_PLAN={expected_plan}',
        '/usr/bin/python3', '-I', str(BASE / 'ops/preview-queue-run.py'), '--qualify-jev',
    ]


def run_jev_qualification(checksum, build, expected_plan):
    if any(not isinstance(value, str) or not re.fullmatch(r'[a-f0-9]{64}', value)
           for value in (checksum, build, expected_plan)):
        raise ValueError('Exact reviewed case, build and host plan hashes are required.')
    require_operator(cleanup_logs=False)
    artifact = artifact_module()
    release = BASE / 'releases' / build
    if (BASE / 'current').resolve(strict=True) != release or artifact.read_host_plan(BASE) != expected_plan:
        raise ValueError('JEV qualification requires the exact active build and installed host plan.')
    owned_path(release, directory=True)
    manifest = artifact.verify_directory(release)
    if (manifest['buildIdentity'] != build or manifest['files'].get(JEV_FIXTURE) != checksum
            or not artifact.JEV_QUALIFICATION_FILES <= manifest['files'].keys()):
        raise ValueError('The active release differs from the reviewed JEV cases.')
    if call('systemctl', 'show', '--property=LoadState', '--value', JEV_UNIT, capture=True) != 'not-found':
        raise ValueError('The JEV qualification name is already loaded.')
    for unit in (*APPLICATION_UNITS, LUNA_UNIT, 'justup-preview-model.service'):
        if call('systemctl', 'show', '--property=ActiveState', '--value', unit, capture=True) not in {'inactive', 'failed'}:
            raise ValueError('Stop the ordinary preview application before qualification.')
    completed = subprocess.run(jev_command(checksum, build, expected_plan), stdin=subprocess.DEVNULL,
                               capture_output=True, timeout=180,
                               env={'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8', 'TZ': 'UTC'})
    if len(completed.stdout) > 16 * 1024:
        raise ValueError('Unexpected JEV qualification report size.')
    result = json.loads(completed.stdout)
    if (not isinstance(result, dict) or result.get('sourceCommit') != manifest['sourceCommit']
            or result.get('buildIdentity') != build or result.get('hostPlanSha256') != expected_plan
            or result.get('fixtureSha256') != checksum or result.get('status') not in {'pass', 'fail', 'insufficient_evidence'}
            or (BASE / 'current').resolve(strict=True) != release or artifact.read_host_plan(BASE) != expected_plan
            or completed.returncode != (0 if result['status'] == 'pass' else 1)):
        raise ValueError('The protected JEV qualification receipt differs from the reviewed execution.')
    return result


def check_coverage_bytes(release, queue_uid, queue_gid, data, period_end, source_version):
    # Use the retained, hash-verified decoder and fact compiler with no inherited
    # provider environment or operator privileges.
    return json.loads(subprocess.run(
        [str(release / 'runtime/bin/node'), '--permission', '--allow-fs-read=' + str(release / 'app'),
         str(release / COVERAGE_CHECKER), '--artifact', '--source-version', source_version, '--period', period_end],
        input=data, cwd=release, env={'LANG': 'C.UTF-8', 'TZ': 'UTC'},
        user=queue_uid, group=queue_gid, extra_groups=[], umask=0o077,
        capture_output=True, check=True, timeout=30).stdout)


def install_coverage(stream, *, period, source_version, checksum, build, expected_plan):
    def is_sha(value):
        return isinstance(value, str) and re.fullmatch(r'[0-9a-f]{64}', value)

    if (not all(map(is_sha, (checksum, build, expected_plan))) or source_version not in COVERAGE_DIRS
            or not isinstance(period, str) or not re.fullmatch(r'\d{4}-\d{2}-\d{2}', period)
            or date.fromisoformat(period).weekday() != 0):
        raise ValueError('An exact UTC Monday, source version, transfer hash, build and host plan are required.')
    require_operator(cleanup_logs=False)
    artifact = artifact_module()
    current = BASE / 'current'
    release = BASE / 'releases' / build
    if current.resolve(strict=True) != release or artifact.read_host_plan(BASE) != expected_plan:
        raise ValueError('The active preview build or installed plan differs from the approved transfer.')
    owned_path(release, directory=True)
    manifest = artifact.verify_directory(release)
    if manifest['buildIdentity'] != build or COVERAGE_CHECKER not in manifest['files']:
        raise ValueError('The verified active release lacks the fixed coverage checker.')

    queue = BASE / 'queue'
    queue_user = pwd.getpwnam(RUNNER_USER)
    queue_uid, queue_gid = queue_user.pw_uid, queue_user.pw_gid
    if queue_uid == 0 or queue_gid == 0:
        raise ValueError('Coverage validation requires the dedicated queue identity.')
    meta = owned_path(queue, directory=True)
    if meta.st_gid != queue_gid or stat.S_IMODE(meta.st_mode) != 0o750 or meta.st_dev != BASE.stat().st_dev:
        raise ValueError('Queue storage differs from the guarded preview allocation.')

    data = stream.read(COVERAGE_ARTIFACT_BYTES + 1)
    if not 0 < len(data) <= COVERAGE_ARTIFACT_BYTES or hashlib.sha256(data).hexdigest() != checksum:
        raise ValueError('Transfer bytes differ from the reviewed wrapper digest or byte cap.')
    period_end = period + 'T00:00:00.000Z'
    proof = check_coverage_bytes(release, queue_uid, queue_gid, data, period_end, source_version)
    if (not isinstance(proof, dict) or set(proof) != {
            'periodEnd', 'snapshotSha256', 'comparableCompanies', 'suppressedScopes'}
            or proof['periodEnd'] != period_end or not is_sha(proof['snapshotSha256'])
            or any(type(proof[name]) is not int or not 0 <= proof[name] <= maximum
                   for name, maximum in (('comparableCompanies', 500), ('suppressedScopes', 2000)))):
        raise ValueError('The retained coverage checker returned an invalid receipt.')

    destination = queue / COVERAGE_DIRS[source_version]
    fd = os.open(queue, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if current.resolve(strict=True) != release or artifact.read_host_plan(BASE) != expected_plan:
            raise ValueError('The build or host plan changed during source verification.')
        if not os.path.lexists(destination):
            destination.mkdir(mode=0o700)
            os.chown(destination, OPERATOR_UID, queue_gid)
            destination.chmod(0o750)
            os.fsync(fd)
        meta = owned_path(destination, directory=True)
        if meta.st_gid != queue_gid or stat.S_IMODE(meta.st_mode) != 0o750 or meta.st_dev != BASE.stat().st_dev:
            raise ValueError('Source coverage storage differs from its protected directory contract.')
        entries = list(destination.iterdir())
        for entry in entries:
            coverage_file(entry, queue_gid)
        target = destination / (period + '.json')
        replayed = target in entries
        if replayed:
            if digest(target) != checksum:
                raise ValueError('An immutable artifact already exists for this version and period.')
        else:
            if len(entries) >= COVERAGE_PERIODS_PER_VERSION or shutil.disk_usage(BASE).free < 64 * MIB + len(data):
                raise ValueError('Source coverage storage has reached its period or headroom limit.')
            stage_fd, stage = tempfile.mkstemp(prefix='.coverage-', dir=destination)
            try:
                with os.fdopen(stage_fd, 'wb') as output:
                    output.write(data)
                    output.flush()
                    os.fchown(output.fileno(), OPERATOR_UID, queue_gid)
                    os.fchmod(output.fileno(), 0o640)
                    os.fsync(output.fileno())
                if current.resolve(strict=True) != release or artifact.read_host_plan(BASE) != expected_plan:
                    raise ValueError('The build or host plan changed before coverage publication.')
                # An exclusive link protects a period that appeared after the
                # inventory read. The runner rejects the temporary second link.
                os.link(stage, target, follow_symlinks=False)
            finally:
                Path(stage).unlink(missing_ok=True)
        sync_directory(destination)
    finally:
        os.close(fd)
    return {**proof, 'artifactSha256': checksum, 'buildIdentity': build, 'hostPlanSha256': expected_plan,
            'sourceVersion': source_version, 'replayed': replayed}


def installed_backup_units(expected_plan, *, skip_unowned=False):
    timer_link = UNIT_ROOT / 'timers.target.wants' / BACKUP_TIMER
    units_present = os.path.lexists(timer_link) or any(os.path.lexists(UNIT_ROOT / name) for name in BACKUP_UNITS)
    allow_no_plan = skip_unowned or not units_present
    history_root = BASE / '.preview-ops-updates'
    if allow_no_plan and not os.path.lexists(history_root):
        return {}
    owned_path(history_root, directory=True)
    histories = [path for path in history_root.glob(f'*-{expected_plan}')
                 if re.fullmatch(r'[a-f0-9]{64}-[a-f0-9]{64}', path.name)]
    if allow_no_plan and not histories:
        return {}
    if len(histories) != 1:
        raise ValueError('The installed backup units require one matching reviewed plan.')
    owned_path(histories[0], directory=True)
    reviewed_plan = load_reviewed_plan(histories[0] / 'new-plan.json', expected_plan)
    if allow_no_plan and not BACKUP_ADDITIONS & reviewed_plan['files'].keys():
        return {}
    if not BACKUP_ADDITIONS <= reviewed_plan['files'].keys():
        raise ValueError('The installed plan does not own both backup units.')
    verify_operator_units({name: reviewed_plan['files'][name] for name in BACKUP_ADDITIONS})
    return {name: reviewed_plan['files'][f'deploy/justup-preview/{name}'] for name in BACKUP_UNITS}


def backup_units_for_current_receipt():
    marker = BASE / '.preview-install.json'
    if not os.path.lexists(marker):
        return {}
    if owned_path(marker).st_size > 4096:
        raise ValueError('The installed plan receipt exceeds its bound.')
    receipt = json.loads(marker.read_text())
    sha = receipt.get('planSha256') if isinstance(receipt, dict) else None
    if (not isinstance(sha, str) or not re.fullmatch(r'[a-f0-9]{64}', sha)
            or type(receipt.get('formatVersion')) is not int or receipt != {'formatVersion': 1, 'planSha256': sha}):
        raise ValueError('The installed plan receipt is invalid.')
    return installed_backup_units(sha, skip_unowned=True)


def teardown(erase_data=False, expected_plan=None):
    if os.geteuid() != 0 or not re.fullmatch(r'[a-f0-9]{64}', expected_plan or ''):
        raise ValueError('Teardown requires root and the exact reviewed installed plan digest.')
    marker_path = BASE / '.preview-install.json'
    meta = marker_path.lstat()
    if marker_path.is_symlink() or not marker_path.is_file() or meta.st_uid != OPERATOR_UID or meta.st_nlink != 1 or meta.st_mode & 0o022 or meta.st_size > 4096:
        raise ValueError('The owned installation marker is unavailable or unsafe.')
    marker = json.loads(marker_path.read_text())
    if marker.get('formatVersion') != 1 or marker.get('planSha256') != expected_plan:
        raise ValueError('Missing owned installation marker; refuse teardown.')
    require_operator(cleanup=True)
    backup_units = installed_backup_units(expected_plan)
    backup_inodes = {name: owned_path(UNIT_ROOT / name) for name in backup_units} if erase_data else {}
    stop_preview()
    if backup_units:
        verify_loaded_backup_unit(BACKUP_TIMER)
        call('systemctl', 'disable', BACKUP_TIMER)
    call('systemctl', 'disable', '--now', 'justup-preview-guard.timer')
    call('systemctl', 'stop', 'justup-preview-guard.service')
    # Normal unmount must succeed. No forced/lazy unmount or unrelated cleanup.
    call('systemctl', 'stop', 'srv-justup_preview.mount')
    if os.path.ismount(BASE):
        raise ValueError('Preview filesystem remains mounted; preserve it and investigate.')
    if any(BASE.iterdir()):
        raise ValueError('Unmounted mountpoint is not empty; refuse cleanup.')
    if erase_data:
        for name, checksum in backup_units.items():
            remove_owned_backup_unit(UNIT_ROOT / name, backup_inodes[name], checksum)
        IMAGE.unlink()
        BASE.rmdir()
        for user in (USER, RUNNER_USER, MODEL_USER):
            call('userdel', user)
        for group in (STATE_GROUP, CLIENT_GROUP):
            call('groupdel', group)
        for name in UNITS[1:]:
            (UNIT_ROOT / name).unlink()
        call('systemctl', 'daemon-reload')
    return {'stopped': True, 'imageRetained': not erase_data,
            'sliceRetained': True, 'protectedWorkloadsTouched': False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['plan', 'install-slice', 'install', 'upgrade-ops', 'upgrade-feed', 'upgrade-drill', 'upgrade-backup', 'prove', 'guard', 'resource-guard', 'stop', 'stage', 'switch', 'install-coverage', 'qualify-luna', 'qualify-jev', 'teardown'])
    parser.add_argument('--source-root', type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument('--reviewed-plan-sha')
    parser.add_argument('--host-machine-sha')
    parser.add_argument('--previous-plan', type=Path)
    parser.add_argument('--previous-plan-sha')
    parser.add_argument('--include-backup', action='store_true')
    parser.add_argument('--stop-on-failure', action='store_true')
    parser.add_argument('--bundle', type=Path)
    parser.add_argument('--sha256')
    parser.add_argument('--build-identity')
    parser.add_argument('--period')
    parser.add_argument('--source-version', choices=COVERAGE_DIRS)
    parser.add_argument('--erase-data', action='store_true')
    args = parser.parse_args()
    try:
        if args.include_backup and args.command != 'plan':
            raise ValueError('Use --include-backup when rendering a plan.')
        if args.command == 'plan':
            result = plan(args.source_root, args.host_machine_sha, include_backup=args.include_backup)
        elif args.command == 'install-slice':
            result = install_slice(args.source_root, args.reviewed_plan_sha, args.host_machine_sha)
        elif args.command == 'install':
            result = install(args.source_root, args.reviewed_plan_sha, args.host_machine_sha)
        elif args.command == 'upgrade-ops':
            if args.previous_plan is None:
                raise ValueError('The exact previous reviewed plan file is required.')
            result = upgrade_ops(args.source_root, args.previous_plan, args.previous_plan_sha,
                                 args.reviewed_plan_sha, args.host_machine_sha)
        elif args.command == 'upgrade-feed':
            if args.previous_plan is None:
                raise ValueError('The exact previous reviewed plan file is required.')
            result = upgrade_feed(args.source_root, args.previous_plan, args.previous_plan_sha,
                                  args.reviewed_plan_sha, args.host_machine_sha)
        elif args.command == 'upgrade-drill':
            if args.previous_plan is None:
                raise ValueError('The exact previous reviewed plan file is required.')
            result = upgrade_drill(args.source_root, args.previous_plan, args.previous_plan_sha,
                                   args.reviewed_plan_sha, args.host_machine_sha)
        elif args.command == 'upgrade-backup':
            if args.previous_plan is None:
                raise ValueError('The exact previous reviewed plan file is required.')
            result = upgrade_backup(args.source_root, args.previous_plan, args.previous_plan_sha,
                                    args.reviewed_plan_sha, args.host_machine_sha)
        elif args.command == 'prove':
            result = proof()
        elif args.command == 'guard':
            result = guard(args.stop_on_failure)
        elif args.command == 'resource-guard':
            result = {'kernel': verify_caps(), 'storage': verify_storage()}
        elif args.command == 'stage':
            if args.bundle is None:
                raise ValueError('Bundle path is required.')
            result = stage(args.bundle, args.sha256)
        elif args.command == 'switch':
            result = switch(args.build_identity)
        elif args.command == 'install-coverage':
            result = install_coverage(sys.stdin.buffer, period=args.period, source_version=args.source_version,
                                      checksum=args.sha256, build=args.build_identity, expected_plan=args.reviewed_plan_sha)
        elif args.command == 'qualify-luna':
            result = run_luna_qualification(args.sha256, args.build_identity, args.reviewed_plan_sha)
        elif args.command == 'qualify-jev':
            result = run_jev_qualification(args.sha256, args.build_identity, args.reviewed_plan_sha)
        elif args.command == 'teardown':
            result = teardown(args.erase_data, args.reviewed_plan_sha)
        else:
            if os.geteuid() != 0:
                raise ValueError('Stopping preview units requires root.')
            result = stop_preview()
        ok = args.command != 'qualify-jev' or result['status'] == 'pass'
        print(json.dumps({'ok': ok, 'result': result}, sort_keys=True))
        return 0 if ok else 1
    except (ValueError, OSError, subprocess.CalledProcessError, subprocess.TimeoutExpired) as error:
        # Do not publish raw command output, environment or provider responses.
        print(json.dumps({'ok': False, 'error': type(error).__name__}), file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
