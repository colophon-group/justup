#!/usr/bin/env python3
"""Stage a bounded private job feed through the isolated preview socket.

The SSH identity may only relay bytes. The socket-activated receiver stages
verified bytes. The root operator imports and retires accepted batches.
"""
from __future__ import annotations

import argparse
from contextlib import ExitStack, contextmanager
import fcntl
import hashlib
import hmac
import json
import os
from pathlib import Path
import pwd
import re
import resource
import selectors
import shutil
import signal
import socket
import sqlite3
import stat
import struct
import subprocess
import sys
import tempfile
import time

BASE = Path('/srv/justup_preview')
INBOX = BASE / 'state/feed-inbox'
RECEIPTS = BASE / 'config/feed-receipts'
SOCKET = Path('/run/justup-preview-feed.sock')
MAGIC = b'JUF1\n'
MAX_MANIFEST = 1024 * 1024
MAX_ORIGIN_REVIEW = 5 * 1024 * 1024
MAX_PART = 64 * 1024 * 1024
MAX_BATCH = 128 * 1024 * 1024
MIN_FREE_AFTER = 64 * 1024 * 1024
MAX_PARTS = 1001
MANIFEST_NAME = re.compile(r'^batch-([0-9a-f]{32})/manifest\.json$')
SHA = re.compile(r'^[0-9a-f]{64}$')


class FeedStageError(Exception):
    """Safe error without job text, paths from source data or provider details."""


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise FeedStageError('Duplicate feed metadata field.')
        result[key] = value
    return result


def manifest_metadata(name, data):
    match = MANIFEST_NAME.fullmatch(name)
    if not match or len(data) > MAX_MANIFEST:
        raise FeedStageError('Invalid feed manifest name or size.')
    try:
        value = json.loads(data.decode('utf-8'), object_pairs_hook=unique_object)
    except (UnicodeError, ValueError, RecursionError) as exc:
        raise FeedStageError('Invalid feed manifest JSON.') from exc
    if (not isinstance(value, dict) or value.get('schemaVersion') != 1
            or value.get('kind') not in {'snapshot', 'changes'}
            or type(value.get('complete')) is not bool
            or not isinstance(value.get('parts'), list) or len(value['parts']) > MAX_PARTS
            or type(value.get('rows')) is not int or value['rows'] < 0):
        raise FeedStageError('Invalid feed manifest metadata.')
    seen = set()
    count = 0
    for index, part in enumerate(value['parts'], 1):
        expected = f'part-{index:04d}.json'
        if (not isinstance(part, dict) or set(part) != {'file', 'sha256', 'rows'}
                or part.get('file') != expected or not isinstance(part.get('sha256'), str)
                or not SHA.fullmatch(part['sha256']) or type(part.get('rows')) is not int
                or not 1 <= part['rows'] <= 100 or part['file'] in seen):
            raise FeedStageError('Invalid feed part metadata.')
        seen.add(part['file'])
        count += part['rows']
    if count != value['rows'] or bool(value['rows']) != bool(value['parts']):
        raise FeedStageError('Inconsistent feed part count.')
    return value, match[1]


def read_exact(stream, size):
    chunks = bytearray()
    while len(chunks) < size:
        part = stream.read(min(65536, size - len(chunks)))
        if not part:
            raise FeedStageError('Truncated feed transfer.')
        chunks.extend(part)
    return bytes(chunks)


def read_header(stream):
    if read_exact(stream, len(MAGIC)) != MAGIC:
        raise FeedStageError('Invalid feed transfer version.')
    name_size = struct.unpack('!H', read_exact(stream, 2))[0]
    if not 1 <= name_size <= 80:
        raise FeedStageError('Invalid feed manifest name.')
    try:
        name = read_exact(stream, name_size).decode('ascii')
    except UnicodeError as exc:
        raise FeedStageError('Invalid feed manifest name.') from exc
    size = struct.unpack('!I', read_exact(stream, 4))[0]
    if size > MAX_MANIFEST:
        raise FeedStageError('Feed manifest exceeds its limit.')
    data = read_exact(stream, size)
    metadata, batch_id = manifest_metadata(name, data)
    return name, data, metadata, batch_id


def checked_file(path, owner):
    meta = path.lstat()
    if (not stat.S_ISREG(meta.st_mode) or meta.st_nlink != 1
            or meta.st_uid != owner or stat.S_IMODE(meta.st_mode) != 0o600):
        raise FeedStageError('Feed file is not a private regular file.')
    return meta.st_size


def send(manifest_path, output):
    manifest_path = Path(manifest_path).expanduser().absolute()
    source_dir = manifest_path.parent
    if (manifest_path.name != 'manifest.json' or not re.fullmatch(r'batch-[0-9a-f]{32}', source_dir.name)
            or source_dir.resolve() != source_dir or source_dir.parent.resolve() != source_dir.parent):
        raise FeedStageError('Feed manifest path is invalid.')
    for directory in (source_dir.parent, source_dir):
        meta = directory.lstat()
        if (not stat.S_ISDIR(meta.st_mode) or meta.st_uid != os.geteuid()
                or stat.S_IMODE(meta.st_mode) != 0o700):
            raise FeedStageError('Feed source directory is not private.')
    if checked_file(manifest_path, os.geteuid()) > MAX_MANIFEST:
        raise FeedStageError('Feed manifest exceeds its limit.')
    data = manifest_path.read_bytes()
    name_text = source_dir.name + '/manifest.json'
    metadata, _ = manifest_metadata(name_text, data)
    output.write(MAGIC)
    name = name_text.encode('ascii')
    output.write(struct.pack('!H', len(name)) + name + struct.pack('!I', len(data)) + data)
    total = len(data)
    for part in metadata['parts']:
        path = manifest_path.parent / part['file']
        size = checked_file(path, os.geteuid())
        if size > MAX_PART or total + size > MAX_BATCH:
            raise FeedStageError('Feed batch exceeds the host stage limit.')
        total += size
        output.write(struct.pack('!I', size))
        digest = hashlib.sha256()
        with path.open('rb') as handle:
            for block in iter(lambda: handle.read(65536), b''):
                digest.update(block)
                output.write(block)
        if digest.hexdigest() != part['sha256']:
            raise FeedStageError('Feed part digest does not match manifest.')
    output.flush()


def private_inbox(path=INBOX, owner=None):
    owner = pwd.getpwnam('justup-preview-api').pw_uid if owner is None else owner
    path = Path(path)
    meta = path.lstat()
    if (not stat.S_ISDIR(meta.st_mode) or meta.st_uid != owner
            or stat.S_IMODE(meta.st_mode) != 0o700 or path.resolve() != path):
        raise FeedStageError('Feed inbox is not private.')
    return path


def write_private(path, data):
    fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(fd, 'wb', closefd=False) as output:
            output.write(data)
            output.flush()
            os.fsync(output.fileno())
    finally:
        os.close(fd)


def fsync_dir(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def host_module():
    import importlib.util
    path = Path(__file__).with_name('preview-host.py')
    spec = importlib.util.spec_from_file_location('preview_host', path)
    host = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(host)
    return host


@contextmanager
def receiver_lock(inbox):
    path = inbox / '.receive.lock'
    fd = os.open(path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        info = os.fstat(fd)
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid()
                or info.st_nlink != 1 or stat.S_IMODE(info.st_mode) != 0o600):
            raise FeedStageError('Feed receive lock is unsafe.')
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            raise FeedStageError('Another feed transfer is active.') from exc
        yield
    finally:
        fcntl.flock(fd, fcntl.LOCK_UN)
        os.close(fd)


def clean_incomplete(inbox):
    for path in inbox.iterdir():
        if not re.fullmatch(r'\.receiving-[A-Za-z0-9_]{8}', path.name):
            continue
        info = path.lstat()
        if (not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid()
                or stat.S_IMODE(info.st_mode) != 0o700 or info.st_dev != inbox.stat().st_dev):
            raise FeedStageError('Interrupted feed stage needs operator review.')
        for child in path.iterdir():
            if child.name != 'manifest.json' and not re.fullmatch(r'part-[0-9]{4}\.json', child.name):
                raise FeedStageError('Interrupted feed stage needs operator review.')
            checked_file(child, os.geteuid())
        shutil.rmtree(path)
    fsync_dir(inbox)


def receive(stream, inbox=INBOX, owner=None):
    inbox = private_inbox(inbox, owner)
    with receiver_lock(inbox):
        clean_incomplete(inbox)
        return receive_locked(stream, inbox)


def receive_locked(stream, inbox):
    _name, data, manifest, batch_id = read_header(stream)
    target = inbox / f'batch-{batch_id}'
    manifest_sha = hashlib.sha256(data).hexdigest()
    already_staged = target.exists() or target.is_symlink()
    if already_staged:
        target_meta = target.lstat()
        if (not stat.S_ISDIR(target_meta.st_mode) or target_meta.st_uid != os.geteuid()
                or stat.S_IMODE(target_meta.st_mode) != 0o700):
            raise FeedStageError('Feed batch identity is unsafe.')
        current = target / 'manifest.json'
        if checked_file(current, os.geteuid()) != len(data) or current.read_bytes() != data:
            raise FeedStageError('Feed batch identity already exists.')
    if not already_staged and shutil.disk_usage(inbox).free < MAX_BATCH + MIN_FREE_AFTER:
        raise FeedStageError('Feed stage has insufficient free space.')
    temporary = None if already_staged else Path(tempfile.mkdtemp(prefix='.receiving-', dir=inbox))
    if temporary is not None:
        os.chmod(temporary, 0o700)
    total = len(data)
    try:
        if temporary is not None:
            write_private(temporary / 'manifest.json', data)
        for part in manifest['parts']:
            size = struct.unpack('!I', read_exact(stream, 4))[0]
            if size > MAX_PART or total + size > MAX_BATCH:
                raise FeedStageError('Feed batch exceeds the host stage limit.')
            total += size
            path = (temporary or target) / part['file']
            digest = hashlib.sha256()
            fd = None if already_staged else os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
            try:
                output = os.fdopen(fd, 'wb', closefd=False) if fd is not None else None
                try:
                    remaining = size
                    while remaining:
                        block = read_exact(stream, min(65536, remaining))
                        if output is not None:
                            output.write(block)
                        digest.update(block)
                        remaining -= len(block)
                    if output is not None:
                        output.flush()
                        os.fsync(output.fileno())
                finally:
                    if output is not None:
                        output.close()
            finally:
                if fd is not None:
                    os.close(fd)
            if digest.hexdigest() != part['sha256']:
                raise FeedStageError('Feed part digest does not match manifest.')
            if already_staged:
                if checked_file(path, os.geteuid()) != size:
                    raise FeedStageError('Staged feed part differs from replay.')
                with path.open('rb') as existing:
                    if hashlib.file_digest(existing, 'sha256').hexdigest() != part['sha256']:
                        raise FeedStageError('Staged feed part differs from replay.')
        if stream.read(1):
            raise FeedStageError('Feed transfer has trailing bytes.')
        if already_staged:
            return {'status': 'already_staged', 'manifestSha256': manifest_sha,
                    'acknowledgeable': False}
        fsync_dir(temporary)
        os.rename(temporary, target)
        fsync_dir(inbox)
        return {'status': 'staged', 'manifestSha256': manifest_sha, 'acknowledgeable': False}
    except BaseException:
        if temporary is not None and temporary.exists():
            shutil.rmtree(temporary)
        raise


def relay(socket_path=SOCKET, source=None, output=None):
    if os.environ.get('SSH_ORIGINAL_COMMAND') != 'feed-v1':
        raise FeedStageError('Restricted feed command refused.')
    source = source or sys.stdin.buffer
    output = output or sys.stdout.buffer
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
        client.settimeout(300)
        client.connect(str(socket_path))
        total = 0
        while block := source.read(65536):
            total += len(block)
            if total > MAX_BATCH + MAX_MANIFEST + 8192:
                raise FeedStageError('Feed relay exceeds its transfer limit.')
            client.sendall(block)
        client.shutdown(socket.SHUT_WR)
        reply = bytearray()
        while not reply.endswith(b'\n') and len(reply) <= 1024:
            block = client.recv(min(1025 - len(reply), 1025))
            if not block:
                break
            reply.extend(block)
        if len(reply) > 1024 or not reply.endswith(b'\n'):
            raise FeedStageError('Feed receiver did not return a bounded receipt.')
        output.write(bytes(reply))
        output.flush()


def limit_relay():
    # SSH runs this byte copier outside the application slice. It parses no
    # source content and has its own strict short-lived process ceiling.
    resource.setrlimit(resource.RLIMIT_CPU, (30, 30))
    resource.setrlimit(resource.RLIMIT_AS, (128 * 1024 * 1024, 128 * 1024 * 1024))
    signal.alarm(330)


def prepare(inbox=INBOX):
    if os.geteuid() != 0:
        raise FeedStageError('Feed inbox preparation requires the operator.')
    host = host_module()
    host.verify_caps()
    host.verify_storage()
    owner = pwd.getpwnam('justup-preview-api')
    deploy = pwd.getpwnam('justup-deploy')
    if deploy.pw_uid == owner.pw_uid:
        raise FeedStageError('Deployment and API identities must differ.')
    path = Path(inbox)
    if path.exists() or path.is_symlink():
        private_inbox(path, owner.pw_uid)
        created = False
    else:
        if path.parent.resolve() != path.parent or not path.parent.is_dir():
            raise FeedStageError('Feed inbox parent is invalid.')
        path.mkdir(mode=0o700)
        fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            os.fchown(fd, owner.pw_uid, owner.pw_gid)
            # mkdir inherits the parent's set-group-ID bit on Linux.
            os.fchmod(fd, 0o700)
            os.fsync(fd)
            meta = os.fstat(fd)
            named = path.lstat()
            if (not stat.S_ISDIR(named.st_mode)
                    or (meta.st_dev, meta.st_ino) != (named.st_dev, named.st_ino)
                    or meta.st_uid != owner.pw_uid or meta.st_gid != owner.pw_gid
                    or stat.S_IMODE(meta.st_mode) != 0o700):
                raise FeedStageError('Feed inbox is not private.')
        finally:
            os.close(fd)
        private_inbox(path, owner.pw_uid)
        fsync_dir(path.parent)
        created = True
    if RECEIPTS.exists() or RECEIPTS.is_symlink():
        meta = RECEIPTS.lstat()
        if (not stat.S_ISDIR(meta.st_mode) or meta.st_uid != 0
                or stat.S_IMODE(meta.st_mode) != 0o700):
            raise FeedStageError('Feed receipt directory is unsafe.')
    else:
        RECEIPTS.mkdir(mode=0o700)
        fsync_dir(RECEIPTS.parent)
    return {'prepared': True, 'created': created}


def validate_batch_id(batch_id):
    if not isinstance(batch_id, str) or not re.fullmatch(r'[0-9a-f]{32}', batch_id):
        raise FeedStageError('Invalid feed batch identity.')


def batch_files(batch_id, inbox=INBOX):
    validate_batch_id(batch_id)
    directory = private_inbox(inbox) / f'batch-{batch_id}'
    return read_batch(directory, batch_id)


def read_batch(directory, batch_id, *, directory_owner=None):
    owner = pwd.getpwnam('justup-preview-api').pw_uid
    private_inbox(directory, owner if directory_owner is None else directory_owner)
    name = f'batch-{batch_id}/manifest.json'
    manifest_file = directory / 'manifest.json'
    if checked_file(manifest_file, owner) > MAX_MANIFEST:
        raise FeedStageError('Feed manifest exceeds its limit.')
    data = manifest_file.read_bytes()
    manifest, received_id = manifest_metadata(name, data)
    if received_id != batch_id:
        raise FeedStageError('Feed batch identity changed.')
    total = len(data)
    for part in manifest['parts']:
        path = directory / part['file']
        size = checked_file(path, owner)
        total += size
        if size > MAX_PART or total > MAX_BATCH:
            raise FeedStageError('Staged feed exceeds its limit.')
        with path.open('rb') as handle:
            if hashlib.file_digest(handle, 'sha256').hexdigest() != part['sha256']:
                raise FeedStageError('Staged feed part changed.')
    return directory, manifest_file, manifest, hashlib.sha256(data).hexdigest()


def receipt_path(batch_id):
    return RECEIPTS / f'batch-{batch_id}.json'


def root_receipt(batch_id, digest):
    path = receipt_path(batch_id)
    if not path.exists() and not path.is_symlink():
        return None
    if checked_file(path, 0) > 512:
        raise FeedStageError('Feed receipt is invalid.')
    try:
        receipt = json.loads(path.read_text(), object_pairs_hook=unique_object)
    except (OSError, ValueError) as exc:
        raise FeedStageError('Feed receipt is invalid.') from exc
    if receipt != {'schemaVersion': 1, 'manifestSha256': digest}:
        raise FeedStageError('Feed receipt differs from staged batch.')
    # A prior publisher may have written complete bytes and then failed to
    # sync the file or directory. Presence alone is not accepted publication.
    # Re-establish durability on every historical ACK path before returning it.
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)
    fsync_dir(RECEIPTS)
    return receipt


def candidate_marker_path(batch_id):
    return RECEIPTS / f'batch-{batch_id}-candidate.json'


def candidate_digest(candidate):
    owner = pwd.getpwnam('justup-preview-api').pw_uid
    if checked_file(candidate, owner) > 64 * 1024 * 1024:
        raise FeedStageError('Feed candidate exceeds its limit.')
    with candidate.open('rb') as handle:
        return hashlib.file_digest(handle, 'sha256').hexdigest()


def candidate_marker(batch_id):
    path = candidate_marker_path(batch_id)
    if not path.exists() and not path.is_symlink():
        return None
    if checked_file(path, 0) > 1024:
        raise FeedStageError('Feed candidate build marker is unsafe.')
    try:
        value = json.loads(path.read_text(), object_pairs_hook=unique_object)
    except (OSError, ValueError) as exc:
        raise FeedStageError('Feed candidate build marker is invalid.') from exc
    if (not isinstance(value, dict)
            or set(value) != {'schemaVersion', 'manifestSha256', 'candidateSha256', 'buildIdentity'}
            or value['schemaVersion'] != 1
            or any(not isinstance(value[key], str) or not SHA.fullmatch(value[key])
                   for key in ('manifestSha256', 'candidateSha256', 'buildIdentity'))):
        raise FeedStageError('Feed candidate build marker is invalid.')
    return value


def bind_candidate_build(batch_id, candidate, source_digest, build_identity):
    actual = candidate_digest(candidate)
    expected = {'schemaVersion': 1, 'manifestSha256': source_digest,
                'candidateSha256': actual, 'buildIdentity': build_identity}
    marker = candidate_marker(batch_id)
    if marker is None:
        write_private(candidate_marker_path(batch_id), json.dumps(expected, separators=(',', ':')).encode())
        fsync_dir(RECEIPTS)
    elif marker != expected:
        raise FeedStageError('Feed candidate was prepared by another release or changed after preparation.')
    return expected


def accepted_origin_review(batch_id):
    path = RECEIPTS / f'batch-{batch_id}-accepted-origin.sha256'
    if not path.exists() and not path.is_symlink():
        return None
    if checked_file(path, 0) != 64:
        raise FeedStageError('Accepted posting origin review marker is invalid.')
    digest = path.read_text(encoding='ascii')
    if not SHA.fullmatch(digest):
        raise FeedStageError('Accepted posting origin review marker is invalid.')
    return digest


def bind_accepted_origin_review(batch_id, digest):
    accepted = accepted_origin_review(batch_id)
    if accepted is not None and accepted != digest:
        raise FeedStageError('The batch already has a different accepted posting origin review.')
    if accepted is None:
        path = RECEIPTS / f'batch-{batch_id}-accepted-origin.sha256'
        temporary = RECEIPTS / f'.{path.name}.tmp'
        if temporary.exists() or temporary.is_symlink():
            checked_file(temporary, 0)
            temporary.unlink()
        write_private(temporary, digest.encode('ascii'))
        os.replace(temporary, path)
    fsync_dir(RECEIPTS)


@contextmanager
def open_origin_review(batch_id, digest):
    path = RECEIPTS / f'batch-{batch_id}-origin-review.json'
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, 'rb') as stream:
        info = os.fstat(stream.fileno())
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_nlink != 1
                or stat.S_IMODE(info.st_mode) != 0o600 or not 1 <= info.st_size <= MAX_ORIGIN_REVIEW):
            raise FeedStageError('Posting origin review is not a bounded private root-owned regular file.')
        raw = stream.read(MAX_ORIGIN_REVIEW + 1)
        if len(raw) != info.st_size or not hmac.compare_digest(hashlib.sha256(raw).hexdigest(), digest):
            raise FeedStageError('Posting origin review differs from the approved digest.')
        stream.seek(0)
        yield stream


def require_source_digest(actual, expected):
    if not isinstance(expected, str) or not SHA.fullmatch(expected) or not hmac.compare_digest(actual, expected):
        raise FeedStageError('Staged feed differs from the independently reviewed source digest.')


def validate_batch_reference(batch_id, digest):
    validate_batch_id(batch_id)
    if not isinstance(digest, str) or not SHA.fullmatch(digest):
        raise FeedStageError('Invalid source manifest digest.')


def authorized_batch(batch_id, expected_manifest_sha256):
    batch = batch_files(batch_id)
    require_source_digest(batch[3], expected_manifest_sha256)
    return batch


def store_receipt(batch_id, digest):
    existing = root_receipt(batch_id, digest)
    if existing is not None:
        return existing
    receipt = {'schemaVersion': 1, 'manifestSha256': digest}
    payload = json.dumps(receipt, separators=(',', ':')).encode()
    write_private(receipt_path(batch_id), payload)
    fsync_dir(RECEIPTS)
    return receipt


def read_candidate(path, digest, expected_complete, limit):
    owner = pwd.getpwnam('justup-preview-api').pw_uid
    if checked_file(path, owner) > 64 * 1024 * 1024:
        raise FeedStageError('Feed candidate exceeds the app import limit.')
    try:
        value = json.loads(path.read_text(encoding='utf-8'), object_pairs_hook=unique_object)
    except (OSError, UnicodeError, ValueError, RecursionError) as exc:
        raise FeedStageError('Feed candidate is invalid.') from exc
    staged = isinstance(value, dict) and value.get('stageVersion') == 1
    candidate = value.get('candidate') if staged else value
    feed = candidate.get('selection', {}).get('feed') if isinstance(candidate, dict) else None
    if (staged == expected_complete or not isinstance(feed, dict)
            or feed.get('manifestSha256') != digest or feed.get('limit') != limit
            or feed.get('complete') != expected_complete):
        raise FeedStageError('Feed candidate does not match the staged batch.')
    return value


def active_release(expected_plan=None):
    import importlib.util
    artifact_path = Path(__file__).with_name('preview-artifact.py')
    spec = importlib.util.spec_from_file_location('preview_artifact', artifact_path)
    artifact = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(artifact)
    release = (BASE / 'current').resolve(strict=True)
    if release.parent != BASE / 'releases':
        raise FeedStageError('Current release path is invalid.')
    installed_plan = artifact.read_host_plan(BASE)
    if expected_plan is not None and installed_plan != expected_plan:
        raise FeedStageError('The approved feed request names a different installed host plan.')
    manifest = artifact.verify_directory(release)
    artifact.check_database_schema(BASE / 'state/preview.sqlite', manifest, allow_missing=True)
    return release, manifest


def run_as_api(argv, environment, cwd, timeout, demote=None, *, pass_fds=(), stdin=subprocess.DEVNULL):
    if demote is None:
        user = pwd.getpwnam('justup-preview-api')
        groups = os.getgrouplist(user.pw_name, user.pw_gid)

        def demote():
            os.setgroups(groups)
            os.setgid(user.pw_gid)
            os.setuid(user.pw_uid)

    child = subprocess.Popen(argv, cwd=cwd, env=environment, stdin=stdin,
                             stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                             preexec_fn=demote, start_new_session=True, pass_fds=pass_fds)
    output = bytearray()
    selector = selectors.DefaultSelector()
    deadline = time.monotonic() + timeout
    try:
        selector.register(child.stdout, selectors.EVENT_READ)
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise FeedStageError('Feed import timed out; the batch remains staged.')
            events = selector.select(remaining)
            if not events:
                raise FeedStageError('Feed import timed out; the batch remains staged.')
            block = os.read(child.stdout.fileno(), min(4096, 8193 - len(output)))
            if not block:
                break
            output.extend(block)
            if len(output) > 8192:
                raise FeedStageError('Feed import output exceeded its receipt limit.')
        try:
            code = child.wait(timeout=max(0.001, deadline - time.monotonic()))
        except subprocess.TimeoutExpired as exc:
            raise FeedStageError('Feed import timed out; the batch remains staged.') from exc
    except BaseException:
        if child.poll() is None:
            try:
                os.killpg(child.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            child.wait(timeout=5)
        raise
    finally:
        selector.close()
        child.stdout.close()
    if code != 0:
        raise FeedStageError('Feed import did not complete; the batch remains staged.')
    try:
        return json.loads(bytes(output).decode('utf-8'), object_pairs_hook=unique_object)
    except (UnicodeError, ValueError, RecursionError) as exc:
        raise FeedStageError('Feed import returned an invalid receipt.') from exc


def latest_import_selection(*, fail_closed=False):
    path = BASE / 'state/preview.sqlite'
    if not path.is_file() or path.is_symlink():
        if fail_closed and (path.exists() or path.is_symlink()):
            raise FeedStageError('Could not verify the current committed feed import.')
        return None
    database = None
    try:
        database = sqlite3.connect(f'file:{path}?mode=ro', uri=True, timeout=5)
        row = database.execute('SELECT selection_json FROM justup_imports ORDER BY rowid DESC LIMIT 1').fetchone()
        if row is None:
            return None
        selection = json.loads(row[0])
        if fail_closed and not isinstance(selection, dict):
            raise FeedStageError('Could not verify the current committed feed import.')
        return selection if isinstance(selection, dict) else None
    except (sqlite3.Error, ValueError, TypeError, RecursionError):
        if fail_closed:
            raise FeedStageError('Could not verify the current committed feed import.') from None
        return None
    finally:
        if database is not None:
            database.close()


def latest_import_matches(digest, *, approval=None):
    selection = latest_import_selection() or {}
    feed = selection.get('feed')
    if not isinstance(feed, dict) or feed.get('manifestSha256') != digest:
        return False
    origin = selection.get('postingOriginReview')
    if approval is None:
        return 'postingOriginReview' not in selection
    return isinstance(origin, dict) and origin.get('policyVersion') == 'direct-employer-v1' \
        and origin.get('manifestSha256') == digest and origin.get('snapshotSha256') == approval['candidateSha256'] \
        and origin.get('reviewSha256') == approval['originReviewSha256']


def promote_candidate(candidate, latest, *, expected_digest=None):
    owner = pwd.getpwnam('justup-preview-api')
    checked_file(candidate, owner.pw_uid)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=latest.parent, prefix='.latest-', delete=False) as output:
            temporary = Path(output.name)
            os.fchmod(output.fileno(), 0o600)
            os.fchown(output.fileno(), owner.pw_uid, owner.pw_gid)
            with candidate.open('rb') as source:
                if expected_digest is None:
                    shutil.copyfileobj(source, output, 65536)
                else:
                    digest = hashlib.sha256()
                    total = 0
                    for block in iter(lambda: source.read(65536), b''):
                        total += len(block)
                        if total > 64 * 1024 * 1024:
                            raise FeedStageError('The reviewed candidate changed before promotion.')
                        digest.update(block)
                        output.write(block)
                    if digest.hexdigest() != expected_digest:
                        raise FeedStageError('The reviewed candidate changed before promotion.')
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, latest)
        fsync_dir(latest.parent)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def node_import_environment(release_manifest):
    import importlib.util
    script = Path(__file__).with_name('preview-run.py')
    spec = importlib.util.spec_from_file_location('preview_run', script)
    runner = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(runner)
    config = runner.read_configuration(BASE / 'config/api.json')
    return runner.child_environment(config, release_manifest)


def prepare_candidate(directory, manifest_path, manifest, digest, release, release_manifest,
                      inbox, max_jobs, *, writer_fd=None):
    candidate = directory / 'candidate.json'
    inherit_writer = {'pass_fds': (writer_fd,)} if writer_fd is not None else {}
    batch_id = directory.name.removeprefix('batch-')
    marker = candidate_marker(batch_id)
    if marker is not None and not (candidate.exists() or candidate.is_symlink()):
        raise FeedStageError('Bound feed candidate is missing; review the staged batch.')
    if marker is None and (candidate.exists() or candidate.is_symlink()):
        # The adapter may have completed just before a crash. No app import or
        # acknowledgement can happen before this root-owned marker exists.
        checked_file(candidate, pwd.getpwnam('justup-preview-api').pw_uid)
        candidate.unlink()
        fsync_dir(directory)
    if candidate.exists() or candidate.is_symlink():
        read_candidate(candidate, digest, manifest['complete'], max_jobs)
        return bind_candidate_build(batch_id, candidate, digest, release_manifest['buildIdentity'])
    else:
        argv = ['/usr/bin/python3', str(release / 'app/scripts/import-jobs.py'),
                '--feed-manifest', str(manifest_path), '--max-jobs', str(max_jobs),
                '--output', str(candidate)]
        previous = inbox / 'latest.json'
        if previous.exists() or previous.is_symlink():
            checked_file(previous, pwd.getpwnam('justup-preview-api').pw_uid)
            argv += ['--previous', str(previous)]
        minimal_env = {'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8', 'TZ': 'UTC',
                       'HOME': str(BASE / 'state'), 'TMPDIR': str(BASE / 'state/work'),
                       'PYTHONDONTWRITEBYTECODE': '1'}
        result = run_as_api(argv, minimal_env, release / 'app', 300, **inherit_writer)
        if (not isinstance(result, dict) or result.get('manifestSha256') != digest
                or result.get('importable') != manifest['complete']):
            raise FeedStageError('Feed adapter receipt differs from source batch.')
        read_candidate(candidate, digest, manifest['complete'], max_jobs)
        return bind_candidate_build(batch_id, candidate, digest, release_manifest['buildIdentity'])


def consume_batch(directory, manifest_path, manifest, digest, release, release_manifest,
                  inbox, max_jobs, *, writer_fd=None, approval=None):
    batch_id = directory.name.removeprefix('batch-')
    if approval is not None and not manifest['complete']:
        raise FeedStageError('A partial source page cannot carry a posting origin review.')
    marker = prepare_candidate(directory, manifest_path, manifest, digest, release, release_manifest,
                               inbox, max_jobs, writer_fd=writer_fd)
    candidate = directory / 'candidate.json'
    match = {'approval': approval} if approval is not None else {}
    if approval is not None and marker['candidateSha256'] != approval['candidateSha256']:
        raise FeedStageError('Prepared feed candidate differs from the approved review input.')
    if manifest['complete'] and not latest_import_matches(digest, **match):
        current = (latest_import_selection(fail_closed=approval is not None) or {}).get('feed')
        if isinstance(current, dict) and current.get('manifestSha256') == digest:
            raise FeedStageError('Committed feed import differs from the approved posting origin review.')
        environment = node_import_environment(release_manifest)
        argv = [str(release / 'runtime/bin/node'), str(release / release_manifest['entrypoint']),
                '--import', str(candidate)]
        inherit = {'pass_fds': (writer_fd,)} if writer_fd is not None else {}
        with ExitStack() as review:
            if approval is not None:
                digest_review = approval['originReviewSha256']
                inherit['stdin'] = review.enter_context(open_origin_review(batch_id, digest_review))
                argv += ['--origin-review-stdin', digest_review, approval['candidateSha256']]
            result = run_as_api(argv, environment, release / 'app', 300, **inherit)
        if not isinstance(result, dict) or result.get('imported') is None or not latest_import_matches(digest, **match):
            raise FeedStageError('Application did not confirm the exact feed import.')
    if approval is not None:
        bind_accepted_origin_review(batch_id, approval['originReviewSha256'])
    promotion = {'expected_digest': approval['candidateSha256']} if approval is not None else {}
    promote_candidate(candidate, inbox / 'latest.json', **promotion)
    store_receipt(batch_id, digest)
    return {'status': 'imported' if manifest['complete'] else 'staged_for_catchup',
            'manifestSha256': digest, 'releaseBuildIdentity': release_manifest['buildIdentity']}


@contextmanager
def import_lock():
    host = host_module()
    host.verify_caps()
    host.verify_storage()
    private_inbox(RECEIPTS, owner=0)
    lock_fd = os.open(RECEIPTS / '.import.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        lock_meta = os.fstat(lock_fd)
        if (not stat.S_ISREG(lock_meta.st_mode) or lock_meta.st_uid != 0
                or lock_meta.st_nlink != 1 or stat.S_IMODE(lock_meta.st_mode) != 0o600):
            raise FeedStageError('Feed import lock is unsafe.')
        try:
            fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            raise FeedStageError('A feed import or retirement is already active.') from exc
        yield
    finally:
        fcntl.flock(lock_fd, fcntl.LOCK_UN)
        os.close(lock_fd)


def validate_import_limit(max_jobs):
    if type(max_jobs) is not int or not 1 <= max_jobs <= 1000:
        raise FeedStageError('Feed import limit must be 1..1000.')


def process_batch_locked(batch_id, expected_digest, max_jobs, *, release=None, writer_fd=None, approval=None):
    accepted_review = accepted_origin_review(batch_id)
    if accepted_review is not None and (approval is None or accepted_review != approval['originReviewSha256']):
        raise FeedStageError('The batch already has a different accepted posting origin review.')
    if root_receipt(batch_id, expected_digest) is not None:
        result = {'status': 'already_accepted', 'manifestSha256': expected_digest}
        if release is not None:
            marker = candidate_marker(batch_id)
            if (marker is None or marker['manifestSha256'] != expected_digest
                    or marker['buildIdentity'] != release[1]['buildIdentity']):
                raise FeedStageError('The accepted batch belongs to a different build.')
            result['releaseBuildIdentity'] = marker['buildIdentity']
        if approval is not None and (accepted_review is None or marker['candidateSha256'] != approval['candidateSha256']):
            raise FeedStageError('The accepted batch does not match the approved posting origin review.')
        return result
    inbox = private_inbox(INBOX)
    staged = authorized_batch(batch_id, expected_digest)
    release = active_release() if release is None else release
    writer = {'writer_fd': writer_fd} if writer_fd is not None else {}
    if approval is not None:
        writer['approval'] = approval
    return consume_batch(*staged, *release, inbox, max_jobs, **writer)


def process_batch(batch_id, expected_manifest_sha256, max_jobs=500, *, writer_fd=None):
    if os.geteuid() != 0:
        raise FeedStageError('Feed import requires the operator.')
    validate_batch_reference(batch_id, expected_manifest_sha256)
    validate_import_limit(max_jobs)
    with import_lock():
        return process_batch_locked(batch_id, expected_manifest_sha256, max_jobs, writer_fd=writer_fd)


def approved_import_request():
    path = RECEIPTS / 'next-import.json'
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except FileNotFoundError:
        return None
    with os.fdopen(fd, 'rb') as stream:
        meta = os.fstat(stream.fileno())
        if (not stat.S_ISREG(meta.st_mode) or meta.st_uid != 0 or meta.st_nlink != 1
                or stat.S_IMODE(meta.st_mode) != 0o600 or not 1 <= meta.st_size <= 2048):
            raise FeedStageError('The approved feed request is not a private root-owned regular file.')
        raw = stream.read(2049)
    try:
        request = json.loads(raw.decode('utf-8'), object_pairs_hook=unique_object)
    except (ValueError, UnicodeError, RecursionError) as exc:
        raise FeedStageError('The approved feed request is invalid.') from exc
    keys = {'schemaVersion', 'batchId', 'manifestSha256', 'buildIdentity', 'planSha256', 'maxJobs'}
    review_keys = {'candidateSha256', 'originReviewSha256'}
    version = request.get('schemaVersion') if isinstance(request, dict) else None
    if (len(raw) != meta.st_size or type(version) is not int or version not in (1, 2)
            or set(request) != (keys | review_keys if version == 2 else keys)
            or any(not isinstance(request[key], str) or not SHA.fullmatch(request[key])
                   for key in ('buildIdentity', 'planSha256'))):
        raise FeedStageError('The approved feed request is invalid.')
    if version == 2 and not (all(request[key] is None for key in review_keys)
                            or all(isinstance(request[key], str) and SHA.fullmatch(request[key]) for key in review_keys)):
        raise FeedStageError('The approved feed request is invalid.')
    validate_batch_reference(request['batchId'], request['manifestSha256'])
    validate_import_limit(request['maxJobs'])
    return request


def approved_release(request):
    release = active_release(request['planSha256'])
    if release[1]['buildIdentity'] != request['buildIdentity']:
        raise FeedStageError('The approved feed request names a different active build.')
    return release


def prepare_approved_batch(*, writer_fd):
    if os.geteuid() != 0:
        raise FeedStageError('Approved feed preparation requires the operator.')
    with import_lock():
        request = approved_import_request()
        if request is None:
            return {'status': 'waiting_for_approval'}
        if request['schemaVersion'] != 2 or request['originReviewSha256'] is not None:
            raise FeedStageError('Use a preparation-only approval to prepare a feed candidate.')
        release = approved_release(request)
        batch_id, digest = request['batchId'], request['manifestSha256']
        if root_receipt(batch_id, digest) is not None:
            raise FeedStageError('This feed batch already has an acknowledgement.')
        inbox = private_inbox(INBOX)
        batch = authorized_batch(batch_id, digest)
        marker = prepare_candidate(*batch, *release, inbox, request['maxJobs'], writer_fd=writer_fd)
        return {'status': 'prepared', 'complete': batch[2]['complete'], 'batchId': batch_id,
                **{key: marker[key] for key in ('candidateSha256', 'manifestSha256', 'buildIdentity')}}


def process_approved_batch(*, writer_fd):
    if os.geteuid() != 0:
        raise FeedStageError('Approved feed import requires the operator.')
    with import_lock():
        request = approved_import_request()
        if request is None:
            return {'status': 'waiting_for_approval'}
        if request['schemaVersion'] == 2 and request['originReviewSha256'] is None:
            return {'status': 'waiting_for_review'}
        release = approved_release(request)
        review = {'approval': request} if request['schemaVersion'] == 2 else {}
        result = process_batch_locked(request['batchId'], request['manifestSha256'], request['maxJobs'],
                                      release=release, writer_fd=writer_fd, **review)
        receipt = root_receipt(request['batchId'], request['manifestSha256'])
        if receipt is None:
            raise FeedStageError('The approved import has no durable acknowledgement.')
        return {**result, 'receipt': receipt}


def show_receipt(batch_id, expected_manifest_sha256):
    if os.geteuid() != 0:
        raise FeedStageError('Feed receipt requires the operator.')
    validate_batch_reference(batch_id, expected_manifest_sha256)
    private_inbox(RECEIPTS, owner=0)
    receipt = root_receipt(batch_id, expected_manifest_sha256)
    if receipt is None:
        raise FeedStageError('Feed batch has no accepted receipt.')
    return receipt


def seal_retiring_directory(directory):
    owner = pwd.getpwnam('justup-preview-api').pw_uid
    fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        meta = os.fstat(fd)
        if (meta.st_uid not in {0, owner} or stat.S_IMODE(meta.st_mode) != 0o700
                or not directory.name.endswith(f'-{meta.st_dev}-{meta.st_ino}')):
            raise FeedStageError('Feed retirement directory is unsafe.')
        # A process may still hold an open descriptor from the inbox. Root
        # ownership prevents it from changing the directory entries.
        os.fchown(fd, 0, -1)
        os.fsync(fd)
    finally:
        os.close(fd)


@contextmanager
def open_feed_directory(path, owner):
    named = private_inbox(path, owner).lstat()
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        meta = os.fstat(fd)
        if (meta.st_uid != owner or stat.S_IMODE(meta.st_mode) != 0o700
                or (meta.st_dev, meta.st_ino) != (named.st_dev, named.st_ino)):
            raise FeedStageError('Feed retirement parent is unsafe.')
        yield fd
    finally:
        os.close(fd)


def file_at(name, directory_fd):
    try:
        return os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
    except FileNotFoundError:
        return None


def retirement_files(directory, expected_names=None):
    owner = pwd.getpwnam('justup-preview-api').pw_uid
    private_inbox(directory, owner=0)
    files = []
    for path in directory.iterdir():
        name = path.name
        allowed = name in {'manifest.json', 'candidate.json'} or (
            re.fullmatch(r'part-[0-9]{4}\.json', name) and 1 <= int(name[5:9]) <= MAX_PARTS)
        if not allowed or (expected_names is not None and name not in expected_names):
            raise FeedStageError('Feed retirement found an unexpected file.')
        checked_file(path, owner)
        files.append(path)
    return files


def move_retiring_batch(batch_name, verifying_prefix, inbox_fd, receipts_fd, owner):
    try:
        fd = os.open(batch_name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=inbox_fd)
    except FileNotFoundError:
        return None
    try:
        staged = os.fstat(fd)
        if staged.st_uid != owner or stat.S_IMODE(staged.st_mode) != 0o700:
            raise FeedStageError('Feed retirement batch is unsafe.')
        # The quarantine name records the expected inode across interruption.
        # Keep it open through rename so it cannot be freed and reused.
        verifying = RECEIPTS / f'{verifying_prefix}{staged.st_dev}-{staged.st_ino}'
        os.rename(batch_name, verifying.name, src_dir_fd=inbox_fd, dst_dir_fd=receipts_fd)
        return verifying
    finally:
        os.close(fd)


def retire_accepted(batch_id, expected_manifest_sha256):
    if os.geteuid() != 0:
        raise FeedStageError('Feed retirement requires the operator.')
    validate_batch_reference(batch_id, expected_manifest_sha256)
    with import_lock(), ExitStack() as directories:
        if root_receipt(batch_id, expected_manifest_sha256) is None:
            raise FeedStageError('Feed batch has no accepted receipt.')
        owner = pwd.getpwnam('justup-preview-api').pw_uid
        inbox_fd = directories.enter_context(open_feed_directory(INBOX, owner))
        receipts_fd = directories.enter_context(open_feed_directory(RECEIPTS, 0))
        batch_name = f'batch-{batch_id}'
        verifying_prefix = f'.retiring-{batch_id}-'
        verifying_paths = [RECEIPTS / name for name in os.listdir(receipts_fd) if name.startswith(verifying_prefix)]
        purging = RECEIPTS / f'.purging-{batch_id}'
        has_purging = file_at(purging.name, receipts_fd) is not None
        if len(verifying_paths) > 1 or (verifying_paths and has_purging):
            raise FeedStageError('Feed retirement has competing recovery state.')
        verifying = next(iter(verifying_paths), None)
        if verifying is None and not has_purging:
            verifying = move_retiring_batch(batch_name, verifying_prefix, inbox_fd, receipts_fd, owner)
            if verifying is None:
                os.fsync(receipts_fd)
                return {'status': 'already_retired', 'manifestSha256': expected_manifest_sha256}
        # Establish both sides of the move before validating or deleting bytes.
        os.fsync(inbox_fd)
        os.fsync(receipts_fd)
        if verifying is not None:
            seal_retiring_directory(verifying)
            _, _, manifest, digest = read_batch(verifying, batch_id, directory_owner=0)
            require_source_digest(digest, expected_manifest_sha256)
            names = {'manifest.json', 'candidate.json', *(part['file'] for part in manifest['parts'])}
            files = retirement_files(verifying, names)
            candidate = verifying / 'candidate.json'
            if candidate in files:
                marker = candidate_marker(batch_id)
                if (marker is None or marker['manifestSha256'] != digest
                        or marker['candidateSha256'] != candidate_digest(candidate)):
                    raise FeedStageError('Feed retirement candidate differs from its receipt.')
            os.rename(verifying.name, purging.name, src_dir_fd=receipts_fd, dst_dir_fd=receipts_fd)
            os.fsync(receipts_fd)
        # The root-private purge name survives partial cleanup. Accept only
        # flat staged files here, then resume without needing the removed manifest.
        for path in retirement_files(purging):
            path.unlink()
        fsync_dir(purging)
        os.rmdir(purging.name, dir_fd=receipts_fd)
        os.fsync(receipts_fd)
        return {'status': 'retired', 'manifestSha256': expected_manifest_sha256,
                'stagedReplayPresent': file_at(batch_name, inbox_fd) is not None}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    command = parser.add_subparsers(dest='command', required=True)
    send_parser = command.add_parser('send')
    send_parser.add_argument('--manifest', type=Path, required=True)
    command.add_parser('receive')
    command.add_parser('relay')
    command.add_parser('prepare')
    import_parser = command.add_parser('import')
    import_parser.add_argument('--batch-id', required=True)
    import_parser.add_argument('--manifest-sha256', required=True)
    import_parser.add_argument('--max-jobs', type=int, default=500)
    command.add_parser('import-approved')
    command.add_parser('prepare-approved')
    for name in ('receipt', 'retire-accepted'):
        batch_parser = command.add_parser(name)
        batch_parser.add_argument('--batch-id', required=True)
        batch_parser.add_argument('--manifest-sha256', required=True)
    args = parser.parse_args(argv)
    try:
        if args.command == 'send':
            if sys.stdout.isatty():
                raise FeedStageError('Pipe the private feed to the restricted receiver.')
            send(args.manifest, sys.stdout.buffer)
        elif args.command == 'receive':
            if os.geteuid() != pwd.getpwnam('justup-preview-api').pw_uid:
                raise FeedStageError('Feed receiver identity is invalid.')
            host = host_module()
            host.verify_caps()
            host.verify_storage()
            result = receive(sys.stdin.buffer)
            print(json.dumps(result, separators=(',', ':')))
        elif args.command == 'relay':
            limit_relay()
            relay()
        elif args.command == 'prepare':
            result = prepare()
            print(json.dumps(result, separators=(',', ':')))
        elif args.command == 'import':
            with host_module().data_writer_lock() as writer_fd:
                result = process_batch(args.batch_id, args.manifest_sha256, args.max_jobs, writer_fd=writer_fd)
            print(json.dumps(result, separators=(',', ':')))
        elif args.command in ('import-approved', 'prepare-approved'):
            action = process_approved_batch if args.command == 'import-approved' else prepare_approved_batch
            with host_module().data_writer_lock() as writer_fd:
                result = action(writer_fd=writer_fd)
            print(json.dumps(result, separators=(',', ':')))
        elif args.command == 'receipt':
            print(json.dumps(show_receipt(args.batch_id, args.manifest_sha256), separators=(',', ':')))
        else:
            with host_module().data_writer_lock():
                result = retire_accepted(args.batch_id, args.manifest_sha256)
            print(json.dumps(result, separators=(',', ':')))
        return 0
    except (FeedStageError, OSError, ValueError) as exc:
        # Never echo a source body, source path or exception chain to SSH.
        print(str(exc) if isinstance(exc, FeedStageError) else 'Feed operation failed.', file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
