#!/usr/bin/env python3
"""Bounded SQLite backups with a live deletion barrier; never restore sessions.

Keep the generation file outside snapshots. A private deletion rotates it and
purges backups synchronously before its database transaction can commit.
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import sqlite3
import subprocess
import sys
import time
from urllib.parse import quote
import uuid

MAX_BACKUP = 256 * 1024 ** 2
MAX_AGE = 7 * 86400
BACKUP_NAME = re.compile(r'^backup-[0-9]{8}T[0-9]{6}Z-[a-f0-9-]{36}\.sqlite$')


def generation(path):
    path = Path(path)
    if path.is_symlink() or not path.is_file():
        raise ValueError('A current, independent deletion barrier is required.')
    value = path.read_text().strip()
    if str(uuid.UUID(value)) != value:
        raise ValueError('Deletion generation must be a canonical UUID.')
    return value


def stable_generation(path):
    path = Path(path)
    first = generation(path)
    pending = path.with_name(path.name + '.pending')
    # lstat distinguishes a missing marker from an unreadable/malformed one.
    # Any existing object is a fail-closed transaction/recovery condition.
    try:
        pending.lstat()
    except FileNotFoundError:
        pass
    else:
        raise ValueError('A private deletion transaction is pending or needs crash recovery.')
    second = generation(path)
    if first != second:
        raise ValueError('Deletion generation changed while checking transaction state.')
    return second


def fsync_directory(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def file_digest(path):
    result = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for block in iter(lambda: stream.read(1024 ** 2), b''):
            result.update(block)
    return result.hexdigest()


def check_folder(folder):
    folder = Path(folder)
    if folder.is_symlink() or not folder.is_dir():
        raise ValueError('Backups require a dedicated existing directory.')
    for entry in folder.iterdir():
        if entry.is_symlink() or not entry.is_file():
            raise ValueError('Backups must be flat regular files only.')
    return folder


def readonly(path):
    if Path(path).is_symlink() or not Path(path).is_file():
        raise ValueError('Database must be an existing regular file.')
    return sqlite3.connect('file:' + quote(str(Path(path).resolve()), safe='/') + '?mode=ro', uri=True)


def prune(folder, now=None):
    folder = check_folder(folder)
    now = time.time() if now is None else now
    snapshots = sorted(folder.glob('backup-*.sqlite'), key=lambda p: p.stat().st_mtime, reverse=True)
    for index, snapshot in enumerate(snapshots):
        if index >= 2 or snapshot.stat().st_mtime < now - MAX_AGE:
            snapshot.unlink()
            snapshot.with_suffix('.json').unlink(missing_ok=True)
    for metadata in folder.glob('backup-*.json'):
        if not metadata.with_suffix('.sqlite').exists():
            metadata.unlink()
    fsync_directory(folder)


def backup(database, folder, barrier, source_commit, build_identity, now=None):
    folder = check_folder(folder)
    if not re.fullmatch('[a-f0-9]{40}', source_commit) or not re.fullmatch('[a-f0-9]{64}', build_identity):
        raise ValueError('Backup needs the exact active source and build identity.')
    start_generation = stable_generation(barrier)
    now = time.time() if now is None else now
    name = 'backup-' + time.strftime('%Y%m%dT%H%M%SZ', time.gmtime(now)) + '-' + str(uuid.uuid4()) + '.sqlite'
    target = folder / name
    metadata = target.with_suffix('.json')
    completed = False
    try:
        # Refuse a large snapshot rather than using the hard filesystem boundary
        # as normal backup flow. The source is opened read-only and never copied
        # with raw filesystem cp while WAL may be active.
        with readonly(database) as source:
            pages, page_size = source.execute('PRAGMA page_count').fetchone()[0], source.execute('PRAGMA page_size').fetchone()[0]
            if pages * page_size > MAX_BACKUP:
                raise ValueError('Database exceeds the 256 MiB backup budget.')
            fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            os.close(fd)
            with sqlite3.connect(target) as destination:
                deadline = time.monotonic() + 30
                def progress(status, remaining, total):
                    if time.monotonic() > deadline or total * page_size > MAX_BACKUP:
                        raise ValueError('Backup exceeded its time or page budget.')
                source.backup(destination, pages=128, progress=progress)
                if destination.execute('PRAGMA integrity_check').fetchone() != ('ok',):
                    raise ValueError('Backup integrity check failed.')
        if target.stat().st_size > MAX_BACKUP or stable_generation(barrier) != start_generation:
            raise ValueError('Deletion generation changed during backup; discard it.')
        fd = os.open(target, os.O_RDONLY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
        report = {'formatVersion': 1, 'createdAtUnix': now, 'privateGeneration': start_generation,
                  'sourceCommit': source_commit, 'buildIdentity': build_identity,
                  'databaseSha256': file_digest(target), 'bytes': target.stat().st_size,
                  'sessionsRequireInvalidation': True}
        with metadata.open('x') as stream:
            os.chmod(metadata, 0o600)
            json.dump(report, stream, sort_keys=True)
            stream.write('\n')
            stream.flush()
            os.fsync(stream.fileno())
        fsync_directory(folder)
        # A deletion after this check purges these files under the core callback.
        if stable_generation(barrier) != start_generation:
            raise ValueError('Deletion generation changed before backup publication.')
        completed = True
        prune(folder, now)
        return {'backup': name, 'databaseSha256': report['databaseSha256'], 'bytes': report['bytes']}
    finally:
        if not completed:
            target.unlink(missing_ok=True)
            metadata.unlink(missing_ok=True)
            fsync_directory(folder)


def validate_restore(snapshot, barrier, now=None):
    snapshot = Path(snapshot)
    check_folder(snapshot.parent)
    if not BACKUP_NAME.fullmatch(snapshot.name):
        raise ValueError('Restore only an owned preview backup name.')
    current = stable_generation(barrier)
    info = json.loads(snapshot.with_suffix('.json').read_text())
    now = time.time() if now is None else now
    if info.get('formatVersion') != 1 or info.get('privateGeneration') != current:
        raise ValueError('Snapshot predates a private deletion or lacks its current independent barrier.')
    age = now - info.get('createdAtUnix', 0)
    if age < 0 or age > MAX_AGE:
        raise ValueError('Snapshot is expired or from the future.')
    if snapshot.stat().st_size > MAX_BACKUP or file_digest(snapshot) != info.get('databaseSha256'):
        raise ValueError('Snapshot is oversized or its digest differs.')
    with readonly(snapshot) as db:
        if db.execute('PRAGMA integrity_check').fetchone() != ('ok',):
            raise ValueError('Snapshot integrity check failed.')
    return info


def restore(snapshot, barrier, destination, prepare_command, now=None):
    snapshot, destination = Path(snapshot), Path(destination)
    info = validate_restore(snapshot, barrier, now)
    if destination.exists() or destination.is_symlink() or not prepare_command:
        raise ValueError('Restore requires a new destination and an explicit auth-owned preparation command.')
    initial = stable_generation(barrier)
    published = False
    try:
        fd = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        os.close(fd)
        with readonly(snapshot) as source, sqlite3.connect(destination) as target:
            source.backup(target, pages=128)
        # The installed auth-owned command must remove ALL restored sessions and
        # check schema compatibility. Its fixed argv is reviewed with that build;
        # this module never guesses application table names or executes shell text.
        result = subprocess.run([*prepare_command, str(destination)], check=True, capture_output=True,
                                env={'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8',
                                     'JUSTUP_DB_PATH': str(destination.parent / 'preview.sqlite')}, timeout=30)
        if len(result.stdout) > 4096:
            raise ValueError('Auth-owned restore receipt exceeds its bound.')
        receipt = json.loads(result.stdout)
        if receipt.get('schemaVersion') != 1 or receipt.get('sessionsInvalidated') is not True or receipt.get('remainingSessions') != 0 or type(receipt.get('sessionsDeleted')) is not int or receipt['sessionsDeleted'] < 0:
            raise ValueError('Auth-owned restore session invalidation was not confirmed.')
        if stable_generation(barrier) != initial:
            raise ValueError('Deletion generation changed during restore.')
        with readonly(destination) as target:
            if target.execute('PRAGMA integrity_check').fetchone() != ('ok',):
                raise ValueError('Prepared restore is not valid SQLite.')
        fd = os.open(destination, os.O_RDONLY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
        fsync_directory(destination.parent)
        published = True
        return {'restored': True, 'sourceCommit': info['sourceCommit'], 'activated': False,
                'sessionsInvalidated': True, 'remainingSessions': 0}
    finally:
        if not published:
            destination.unlink(missing_ok=True)
            for suffix in ('-wal', '-shm', '-journal'):
                Path(str(destination) + suffix).unlink(missing_ok=True)


def operational_context(paths):
    base = Path('/srv/justup_preview')
    state = base / 'state'
    expected = {state / 'preview.sqlite', state / 'private-generation', state / 'backups'}
    for path in paths:
        path = Path(path)
        if path.is_symlink() or not (path in expected or (path.parent == state and path.name.startswith('restored-')) or (path.parent == state / 'backups' and BACKUP_NAME.fullmatch(path.name))):
            raise ValueError('Operational recovery paths must stay inside the dedicated preview state.')
    def load(name):
        spec = importlib.util.spec_from_file_location(name.replace('-', '_'), Path(__file__).with_name(name + '.py'))
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module
    load('preview-host').guard()
    release = (base / 'current').resolve(strict=True)
    if release.parent != base / 'releases':
        raise ValueError('Current recovery executable is outside the retained release inventory.')
    manifest = load('preview-artifact').verify_directory(release)
    return manifest, [str(release / 'runtime/bin/node'), str(release / manifest['entrypoint']), '--prepare-restored-db']


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    make = sub.add_parser('backup')
    make.add_argument('--database', type=Path, required=True)
    make.add_argument('--backup-dir', type=Path, required=True)
    make.add_argument('--generation', type=Path, required=True)
    make.add_argument('--source-commit', required=True)
    make.add_argument('--build-identity', required=True)
    check = sub.add_parser('check-restore')
    check.add_argument('--snapshot', type=Path, required=True)
    check.add_argument('--generation', type=Path, required=True)
    use = sub.add_parser('restore')
    use.add_argument('--snapshot', type=Path, required=True)
    use.add_argument('--generation', type=Path, required=True)
    use.add_argument('--destination', type=Path, required=True)
    clean = sub.add_parser('prune')
    clean.add_argument('--backup-dir', type=Path, required=True)
    args = parser.parse_args()
    try:
        paths = [getattr(args, key) for key in ('database', 'backup_dir', 'generation', 'snapshot', 'destination') if hasattr(args, key)]
        manifest, prepare_command = operational_context(paths)
        if args.command == 'backup':
            if args.source_commit != manifest['sourceCommit'] or args.build_identity != manifest['buildIdentity']:
                raise ValueError('Backup identity differs from the active immutable artifact.')
            result = backup(args.database, args.backup_dir, args.generation, args.source_commit, args.build_identity)
        elif args.command == 'restore':
            if os.geteuid() != 0:
                raise ValueError('Restoration is an explicit root operator step.')
            for unit in ('justup-preview-api.service', 'justup-preview-runner.service'):
                if subprocess.run(['systemctl', 'is-active', '--quiet', unit], check=False).returncode == 0:
                    raise ValueError('Stop preview writers before preparing a restore.')
            result = restore(args.snapshot, args.generation, args.destination, prepare_command)
        elif args.command == 'check-restore':
            validate_restore(args.snapshot, args.generation)
            result = {'eligible': True, 'activated': False, 'sessionsStillRequireInvalidation': True}
        else:
            result = prune(args.backup_dir)
        print(json.dumps(result, sort_keys=True))
        return 0
    except (ValueError, OSError, sqlite3.Error, subprocess.SubprocessError, KeyError):
        print('Preview recovery failed closed; no database was activated.', file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
