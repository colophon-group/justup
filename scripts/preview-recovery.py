#!/usr/bin/env python3
"""Bounded SQLite backups with a live deletion barrier; never restore sessions.

Keep the generation file outside snapshots. A private deletion rotates it and
purges backups synchronously before its database transaction can commit.
"""
from __future__ import annotations

import argparse
from contextlib import contextmanager, closing
import hashlib
import importlib.util
import json
import math
import os
from pathlib import Path
import re
import sqlite3
import subprocess
import sys
import time
from urllib.parse import quote
import uuid
import pwd
import grp

MAX_BACKUP = 256 * 1024 ** 2
MAX_AGE = 7 * 86400
APPLICATION_SCHEMA = 2
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


@contextmanager
def readonly(path):
    if Path(path).is_symlink() or not Path(path).is_file():
        raise ValueError('Database must be an existing regular file.')
    with closing(sqlite3.connect('file:' + quote(str(Path(path).resolve()), safe='/') + '?mode=ro', uri=True)) as connection:
        yield connection


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


def backup(database, folder, barrier, source_commit, build_identity, now=None, schema_version=APPLICATION_SCHEMA):
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
            actual_schema = source.execute('PRAGMA user_version').fetchone()[0]
            if actual_schema != schema_version or schema_version not in {1, APPLICATION_SCHEMA}:
                raise ValueError('Backup database epoch differs from the verified active artifact.')
            pages, page_size = source.execute('PRAGMA page_count').fetchone()[0], source.execute('PRAGMA page_size').fetchone()[0]
            if pages * page_size > MAX_BACKUP:
                raise ValueError('Database exceeds the 256 MiB backup budget.')
            fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            os.close(fd)
            with closing(sqlite3.connect(target)) as destination:
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
                  'sessionsRequireInvalidation': True, 'schemaVersion': actual_schema}
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
    created_at = info.get('createdAtUnix')
    if type(created_at) not in (int, float) or not math.isfinite(created_at):
        raise ValueError('Snapshot creation time is invalid.')
    age = now - created_at
    if age < 0 or age > MAX_AGE:
        raise ValueError('Snapshot is expired or from the future.')
    if snapshot.stat().st_size > MAX_BACKUP or file_digest(snapshot) != info.get('databaseSha256'):
        raise ValueError('Snapshot is oversized or its digest differs.')
    with readonly(snapshot) as db:
        actual_schema = db.execute('PRAGMA user_version').fetchone()[0]
        if actual_schema not in {1, APPLICATION_SCHEMA} or info.get('schemaVersion', 1) != actual_schema:
            raise ValueError('Snapshot schema epoch is unsupported or differs from its metadata.')
        info['schemaVersion'] = actual_schema
        if db.execute('PRAGMA integrity_check').fetchone() != ('ok',):
            raise ValueError('Snapshot integrity check failed.')
    return info


def backup_status(folder, barrier, source_commit, build_identity, max_age_seconds, now=None):
    """Read-only health proof for the retained, deletion-safe backup set."""
    folder = check_folder(folder)
    if type(max_age_seconds) is not int or not 0 < max_age_seconds <= MAX_AGE:
        raise ValueError('Backup freshness limit must be within the retention period.')
    now = time.time() if now is None else now
    snapshots = []
    for entry in folder.iterdir():
        if entry.suffix == '.sqlite' and BACKUP_NAME.fullmatch(entry.name):
            snapshots.append(entry)
        elif entry.suffix == '.json' and BACKUP_NAME.fullmatch(entry.with_suffix('.sqlite').name):
            if not entry.with_suffix('.sqlite').exists():
                raise ValueError('Backup metadata has no snapshot.')
        else:
            raise ValueError('Backup directory contains an unreviewed file.')
    if not 1 <= len(snapshots) <= 2:
        raise ValueError('Backup count is outside the reviewed retention limit.')
    initial_generation = stable_generation(barrier)
    latest = None
    for snapshot in snapshots:
        info = validate_restore(snapshot, barrier, now)
        if info.get('sourceCommit') != source_commit or info.get('buildIdentity') != build_identity:
            raise ValueError('Backup identity differs from the active immutable artifact.')
        if latest is None or info['createdAtUnix'] > latest[1]['createdAtUnix']:
            latest = snapshot, info
    if now - latest[1]['createdAtUnix'] > max_age_seconds:
        raise ValueError('Latest usable backup exceeds the freshness limit.')
    if stable_generation(barrier) != initial_generation:
        raise ValueError('Deletion generation changed while checking backup health.')
    free = os.statvfs(folder)
    return {'healthy': True, 'latestBackup': latest[0].name,
            'latestAgeSeconds': int(now - latest[1]['createdAtUnix']),
            'snapshotCount': len(snapshots), 'availableBytes': free.f_bavail * free.f_frsize}


def restore(snapshot, barrier, destination, prepare_command, now=None, migrate_v1=False):
    snapshot, destination = Path(snapshot), Path(destination)
    info = validate_restore(snapshot, barrier, now)
    if destination.exists() or destination.is_symlink() or not prepare_command:
        raise ValueError('Restore requires a new destination and an explicit auth-owned preparation command.')
    if info['schemaVersion'] != APPLICATION_SCHEMA and not (info['schemaVersion'] == 1 and migrate_v1):
        raise ValueError('Epoch-1 recovery requires the explicit forward migration option.')
    initial = stable_generation(barrier)
    published = False
    try:
        fd = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        os.close(fd)
        with readonly(snapshot) as source, closing(sqlite3.connect(destination)) as target:
            source.backup(target, pages=128)
        # The installed auth-owned command must remove ALL restored sessions and
        # check schema compatibility. Its fixed argv is reviewed with that build;
        # this module never guesses application table names or executes shell text.
        result = subprocess.run([*prepare_command, str(destination), *(['--migrate-v1'] if info['schemaVersion'] == 1 else [])], check=True, capture_output=True,
                                env={'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8',
                                     'JUSTUP_DB_PATH': str(destination.parent / 'preview.sqlite')}, timeout=30)
        if len(result.stdout) > 4096:
            raise ValueError('Auth-owned restore receipt exceeds its bound.')
        receipt = json.loads(result.stdout)
        if receipt.get('schemaVersion') != APPLICATION_SCHEMA or receipt.get('sessionsInvalidated') is not True or receipt.get('remainingSessions') != 0 or type(receipt.get('sessionsDeleted')) is not int or receipt['sessionsDeleted'] < 0:
            raise ValueError('Auth-owned restore session invalidation was not confirmed.')
        if stable_generation(barrier) != initial:
            raise ValueError('Deletion generation changed during restore.')
        with readonly(destination) as target:
            if target.execute('PRAGMA user_version').fetchone()[0] != APPLICATION_SCHEMA:
                raise ValueError('Prepared restore has the wrong schema epoch.')
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


def operational_context(paths, build_identity=None, *, cleanup_logs=True):
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
    load('preview-host').guard(cleanup_logs=cleanup_logs)
    if build_identity is not None and not re.fullmatch('[a-f0-9]{64}', build_identity):
        raise ValueError('Migration requires an exact retained target build identity.')
    release = (base / 'releases' / build_identity).resolve(strict=True) if build_identity else (base / 'current').resolve(strict=True)
    if release.parent != base / 'releases':
        raise ValueError('Current recovery executable is outside the retained release inventory.')
    artifact = load('preview-artifact')
    artifact.read_host_plan(base)
    manifest = artifact.verify_directory(release)
    return manifest, [str(release / 'runtime/bin/node'), str(release / manifest['entrypoint']), '--prepare-restored-db']


def migrate_live(database, folder, barrier, target_manifest, migration_command, active_manifest, *, base=Path('/srv/justup_preview'), host=None):
    """Explicit protected upgrade: close launches, prove idle UIDs, back up, rename.

    A retained lock after any incomplete operation needs reviewed reconciliation.
    It is never treated as stale or removed by startup/recovery automatically.
    """
    if os.geteuid() != 0 or target_manifest['schemaVersion'] != APPLICATION_SCHEMA or active_manifest['schemaVersion'] != 1 or host is None:
        raise ValueError('Migration requires root, current operator tools and exact epoch-1/2 artifacts.')
    host.require_operator()
    initial = stable_generation(barrier)
    lock = Path(base) / '.preview-schema-migration.lock'
    fd = os.open(lock, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    lock_bytes = (json.dumps({'targetBuild': target_manifest['buildIdentity'], 'privateGeneration': initial}) + '\n').encode()
    try:
        os.write(fd, lock_bytes)
        lock_meta = os.fstat(fd)
        os.fsync(fd)
    finally:
        os.close(fd)
    fsync_directory(base)
    host.require_idle_preview()
    # Online-backup API remains the only supported snapshot path. All dedicated
    # service identities are stopped before this snapshot and the schema commit.
    saved = backup(database, folder, barrier, active_manifest['sourceCommit'], active_manifest['buildIdentity'], schema_version=1)
    if stable_generation(barrier) != initial:
        raise ValueError('Deletion generation changed before schema migration.')
    api = pwd.getpwnam(host.USER)
    group = grp.getgrnam(host.STATE_GROUP)
    result = subprocess.run(migration_command, check=True, capture_output=True, timeout=30,
                            env={'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8', 'JUSTUP_DB_PATH': str(database), 'JUSTUP_SHARED_STATE': 'true'},
                            user=api.pw_uid, group=group.gr_gid, extra_groups=[], umask=0o007)
    if len(result.stdout) > 4096:
        raise ValueError('Schema migration receipt exceeds its bound.')
    receipt = json.loads(result.stdout)
    if (receipt.get('schemaVersion') != APPLICATION_SCHEMA or receipt.get('previousSchemaVersion') != 1
            or type(receipt.get('migratedTables')) is not int or not 2 <= receipt['migratedTables'] <= 19
            or stable_generation(barrier) != initial):
        raise ValueError('Schema migration was not confirmed; retain the maintenance lock.')
    with readonly(database) as db:
        if db.execute('PRAGMA user_version').fetchone()[0] != APPLICATION_SCHEMA or db.execute('PRAGMA integrity_check').fetchone() != ('ok',):
            raise ValueError('Migrated database did not pass independent epoch/integrity verification.')
    current_lock = lock.lstat()
    if (current_lock.st_dev, current_lock.st_ino) != (lock_meta.st_dev, lock_meta.st_ino) or lock.read_bytes() != lock_bytes:
        raise ValueError('Migration lock ownership changed; preserve it for review.')
    lock.unlink()
    fsync_directory(base)
    return {**receipt, 'backup': saved['backup'], 'activated': False, 'writersStopped': True}


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
    status = sub.add_parser('backup-status')
    status.add_argument('--backup-dir', type=Path, required=True)
    status.add_argument('--generation', type=Path, required=True)
    status.add_argument('--max-age-seconds', type=int, required=True)
    use = sub.add_parser('restore')
    use.add_argument('--snapshot', type=Path, required=True)
    use.add_argument('--generation', type=Path, required=True)
    use.add_argument('--destination', type=Path, required=True)
    use.add_argument('--migrate-v1', action='store_true')
    use.add_argument('--build-identity')
    migration = sub.add_parser('migrate')
    migration.add_argument('--database', type=Path, required=True)
    migration.add_argument('--backup-dir', type=Path, required=True)
    migration.add_argument('--generation', type=Path, required=True)
    migration.add_argument('--build-identity', required=True)
    clean = sub.add_parser('prune')
    clean.add_argument('--backup-dir', type=Path, required=True)
    args = parser.parse_args()
    try:
        paths = [getattr(args, key) for key in ('database', 'backup_dir', 'generation', 'snapshot', 'destination') if hasattr(args, key)]
        manifest, prepare_command = operational_context(
            paths, getattr(args, 'build_identity', None) if args.command in {'migrate', 'restore'} else None,
            cleanup_logs=args.command != 'backup-status')
        if args.command == 'backup':
            if args.source_commit != manifest['sourceCommit'] or args.build_identity != manifest['buildIdentity']:
                raise ValueError('Backup identity differs from the active immutable artifact.')
            result = backup(args.database, args.backup_dir, args.generation, args.source_commit, args.build_identity, schema_version=manifest['schemaVersion'])
        elif args.command == 'migrate':
            current, _ = operational_context(paths)
            spec = importlib.util.spec_from_file_location('migration_host', Path(__file__).with_name('preview-host.py'))
            host = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(host)
            result = migrate_live(args.database, args.backup_dir, args.generation, manifest, [*prepare_command[:-1], '--migrate-db'], current, host=host)
        elif args.command == 'restore':
            if os.geteuid() != 0:
                raise ValueError('Restoration is an explicit root operator step.')
            spec = importlib.util.spec_from_file_location('restore_host', Path(__file__).with_name('preview-host.py'))
            host = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(host)
            host.require_idle_preview()
            if manifest['schemaVersion'] != APPLICATION_SCHEMA:
                raise ValueError('Restore requires the current epoch-2 runtime.')
            result = restore(args.snapshot, args.generation, args.destination, prepare_command, migrate_v1=args.migrate_v1)
        elif args.command == 'check-restore':
            validate_restore(args.snapshot, args.generation)
            result = {'eligible': True, 'activated': False, 'sessionsStillRequireInvalidation': True}
        elif args.command == 'backup-status':
            result = backup_status(args.backup_dir, args.generation, manifest['sourceCommit'],
                                   manifest['buildIdentity'], args.max_age_seconds)
        else:
            result = prune(args.backup_dir)
        print(json.dumps(result, sort_keys=True))
        return 0
    except (ValueError, OSError, sqlite3.Error, subprocess.SubprocessError, KeyError):
        print('Preview recovery failed closed; no database was activated.', file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
