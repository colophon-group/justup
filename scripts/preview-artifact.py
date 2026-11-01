#!/usr/bin/env python3
"""Build immutable ARM64 preview bytes off-host and validate their complete inventory."""
from __future__ import annotations

import argparse
from contextlib import closing
import base64
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import subprocess
import stat
import sqlite3
from urllib.parse import quote
import sys
import tarfile

NODE_VERSION = '24.22.2'
NODE_ARCHIVE_SHA256 = 'eb187837a2230d4047161ac0be008584e16b46f726e9c9490ee35dc6b17d9ba8'
CODEX_VERSION = '0.159.2'
CODEX_TARGET = 'aarch64-unknown-linux-musl'
CODEX_ARCHIVE_SHA256 = '1c4756c2f67f1310ffb03234d61d540ad85916cef5383e46e0e7851f1721c142'
CODEX_ARCHIVE_INTEGRITY = 'sha512-Pm0W2PnFeTEqPx+AOIwgOVB4dBtY24cuD0tx1hjCor60CbSAT7WBPZVNUINSrTCDrMndvQC67p71ZEz+gmPPkA=='
MAX_CODEX_ARCHIVE_BYTES = 192 * 1024 ** 2  # Off-host input only; bundle/host ceilings stay unchanged.
CODEX_ENTRYPOINT = 'runtime/codex/bin/codex'
MODEL_CATALOGUE = 'app/server/model-catalogue.json'
WIRE_CATALOGUE = 'app/server/hiring-wire-sol-catalogue.json'
WIRE_CATALOGUE_SHA256 = '5ed662f51bb5a9eda38e52fae474954574504286a851bfbad4a4aa6d32b4ed61'
WIRE_MODULES = {'app/server/' + name + '.mjs' for name in (
    'hiring-wire', 'hiring-wire-facts', 'hiring-wire-editorial', 'hiring-wire-codex',
    'hiring-wire-codex-policy', 'hiring-wire-codex-broker', 'hiring-wire-integration', 'source-coverage')}
CODEX_FILES = {
    CODEX_ENTRYPOINT: '113aa5d5952a6fd3950a88323219747d0c91978ebee948509a540c8a460e59a3',
    'runtime/codex/codex-resources/bwrap': 'c547cbdc762a70ed216789ffaa4c6c0e7d2beabe32245a498f8e365a9fc8dab4',
    'runtime/codex/codex-package.json': 'd408845280e8ffe021b53343eb51aeda5ce641b851682be2362c2ecf5e306da0',
    'runtime/codex/package.json': 'dd308d68cf5659e804b7409cb4851150ac58d4498f03a979446c22c1d22023f6',
    'runtime/codex/LICENSE': 'd17f227e4df5da1600391338865ce0f3055211760a36688f816941d58232d8dc',
}
EXECUTABLES = {'runtime/bin/node', CODEX_ENTRYPOINT, 'runtime/codex/codex-resources/bwrap'}
MAX_BYTES = 384 * 1024 ** 2
SHA = re.compile(r'^[a-f0-9]{64}$')
OID = re.compile(r'^[a-f0-9]{40}$')


def sha(data):
    return hashlib.sha256(data).hexdigest()


def file_sha(path):
    value = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for block in iter(lambda: stream.read(1024 ** 2), b''):
            value.update(block)
    return value.hexdigest()


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':')).encode()


def read_host_plan(base):
    """Read non-secret root-owned installation identity; never take it from caller JSON."""
    if any(os.path.lexists(Path(base) / name) for name in ('.preview-ops-upgrade.lock', '.preview-schema-migration.lock')):
        raise ValueError('Operator scripts are being updated; runtime adoption is blocked.')
    path = Path(base) / '.preview-install.json'
    meta = path.lstat()
    if (path.resolve(strict=True) != path or not stat.S_ISREG(meta.st_mode) or meta.st_uid != 0
            or meta.st_nlink != 1 or meta.st_mode & 0o022 or meta.st_size > 4096):
        raise ValueError('Installed host plan identity is unavailable or unsafe.')
    value = json.loads(path.read_text())
    if (not isinstance(value, dict) or set(value) != {'formatVersion', 'planSha256'}
            or type(value['formatVersion']) is not int or value['formatVersion'] != 1
            or not isinstance(value['planSha256'], str) or not SHA.fullmatch(value['planSha256'])):
        raise ValueError('Installed host plan identity differs from its receipt schema.')
    return value['planSha256']


def allowed(path):
    parts = PurePosixPath(path).parts
    if path.startswith('/') or '..' in parts or '\\' in path or PurePosixPath(path).as_posix() != path:
        return False
    return (path in {'runtime/bin/node', 'runtime/LICENSE', MODEL_CATALOGUE, WIRE_CATALOGUE, 'app/scripts/import-jobs.py',
                     'app/scripts/hiring-wire/enqueue.mjs', 'app/scripts/hiring-wire/check-snapshot.mjs',
                     'app/server/model-schemas/intent.schema.json', 'app/server/model-schemas/company.schema.json',
                     'app/server/model-schemas/company-discovery.schema.json'} or path in CODEX_FILES or
            (path.startswith('app/server/') and not path.startswith(('app/server/evals/', 'app/server/demo-'))
             and path.endswith('.mjs') and not path.endswith(('.test.mjs', '-fixtures.mjs'))))


def check_database_schema(database, manifest, *, allow_missing=False):
    """Protected launch/switch guard, including retained epoch-1 releases.

    Inspect SQLite read-only before executing any artifact-owned application code.
    Operator tools stay current when the selected application artifact changes.
    """
    database = Path(database)
    expected = manifest['schemaVersion']
    if type(expected) is not int or expected not in {1, 2}:
        raise ValueError('Unsupported application schema epoch.')
    try:
        meta = database.lstat()
    except FileNotFoundError:
        if allow_missing and expected == 2:
            return 0
        raise ValueError('Application database is missing.')
    if not stat.S_ISREG(meta.st_mode) or meta.st_nlink != 1 or database.is_symlink():
        raise ValueError('Application database must be a regular file.')
    try:
        with closing(sqlite3.connect('file:' + quote(str(database.resolve()), safe='/') + '?mode=ro', uri=True)) as db:
            epoch = db.execute('PRAGMA user_version').fetchone()[0]
            tables = {row[0] for row in db.execute("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'")}
            if allow_missing and expected == 2 and epoch == 0 and not tables:
                return 0
            prefix = 'justup_' if expected == 2 else 'demo_'
            other = 'demo_' if expected == 2 else 'justup_'
            if (epoch != expected or not {prefix + 'imports', prefix + 'jobs', 'job_source_identities'} <= tables
                    or (expected == 2 and any(name.startswith('demo_') for name in tables))
                    or any(other + name in tables for name in ('imports', 'jobs', 'tasks', 'searches', 'match_scans', 'jev_usage'))):
                raise ValueError('Application database epoch differs from the selected immutable release; use reviewed forward recovery.')
    except sqlite3.Error:
        raise ValueError('Application database schema cannot be verified.') from None
    return epoch


def identity(manifest):
    return sha(canonical({key: value for key, value in manifest.items() if key != 'buildIdentity'}))


def validate_manifest(manifest):
    if manifest.get('formatVersion') != 2 or manifest.get('nodeVersion') != NODE_VERSION or manifest.get('platform') != 'linux-arm64':
        raise ValueError('Unsupported artifact format or runtime.')
    if not OID.fullmatch(manifest.get('sourceCommit', '')) or not OID.fullmatch(manifest.get('sourceTree', '')):
        raise ValueError('Artifact source must use exact Git commit and tree identities.')
    if type(manifest.get('schemaVersion')) is not int or manifest['schemaVersion'] not in {1, 2} or manifest.get('entrypoint') != 'app/server/main.mjs':
        raise ValueError('Artifact schema or executable entrypoint differs from the preview contract.')
    files = manifest.get('files')
    required = {'runtime/bin/node', 'runtime/LICENSE', 'app/scripts/import-jobs.py'} | {
        'app/server/' + name + '.mjs' for name in
        ('main', 'auth', 'http', 'store', 'feed', 'tasks', 'config', 'composition', 'runner', 'runner-adapter', 'policies', 'processing-admission')}
    if manifest['schemaVersion'] == 2:
        required.add('app/server/schema.mjs')
    if not isinstance(files, dict) or not required <= files.keys():
        raise ValueError('Artifact is missing required runtime/application bytes.')
    if (manifest.get('codexVersion') != CODEX_VERSION or manifest.get('codexTarget') != CODEX_TARGET
            or manifest.get('codexArchiveSha256') != CODEX_ARCHIVE_SHA256
            or manifest.get('codexEntrypoint') != CODEX_ENTRYPOINT
            or any(files.get(name) != checksum for name, checksum in CODEX_FILES.items())):
        raise ValueError('Artifact does not contain the pinned native Codex distribution.')
    for module, schema in [('intent.mjs', 'intent.schema.json'), ('companies.mjs', 'company.schema.json'),
                          ('companies.mjs', 'company-discovery.schema.json')]:
        if 'app/server/' + module in files and 'app/server/model-schemas/' + schema not in files:
            raise ValueError('Runtime module is missing its immutable model schema asset.')
    if 'app/server/model-runner.mjs' in files and MODEL_CATALOGUE not in files:
        raise ValueError('Model runtime is missing its immutable model catalogue asset.')
    wire_transport = {'app/server/' + name + '.mjs' for name in ('hiring-wire-codex', 'hiring-wire-codex-policy', 'hiring-wire-codex-broker')}
    if (bool(wire_transport & files.keys()) and (not WIRE_MODULES <= files.keys() or files.get(WIRE_CATALOGUE) != WIRE_CATALOGUE_SHA256)
            or WIRE_CATALOGUE in files and files[WIRE_CATALOGUE] != WIRE_CATALOGUE_SHA256):
        raise ValueError('Hiring Wire runtime is missing its complete modules or pinned immutable model catalogue asset.')
    if any(not allowed(path) or not isinstance(value, str) or not SHA.fullmatch(value) for path, value in files.items()):
        raise ValueError('Artifact file inventory is unsafe or incomplete.')
    if manifest.get('nodeArchiveSha256') != NODE_ARCHIVE_SHA256 or manifest.get('buildIdentity') != identity(manifest):
        raise ValueError('Artifact runtime or build identity does not match its manifest.')
    return manifest


def read_bundle(bundle, expected_sha, *, retain_files=True, output_directory=None):
    if not SHA.fullmatch(expected_sha or '') or Path(bundle).stat().st_size > MAX_BYTES:
        raise ValueError('A bounded bundle with an exact expected SHA256 is required.')
    if file_sha(bundle) != expected_sha:
        raise ValueError('Bundle SHA256 mismatch.')
    files, members = {}, {}
    total = 0
    with tarfile.open(bundle, mode='r:') as archive:
        for member in archive:
            if not member.isfile() or member.name in members or len(members) >= 256 or not 0 <= member.size <= MAX_BYTES or not (allowed(member.name) or member.name == 'manifest.json'):
                raise ValueError('Bundle contains an unsafe, repeated or unexpected member.')
            total += member.size
            if total > MAX_BYTES:
                raise ValueError('Unpacked bundle exceeds its ceiling.')
            members[member.name] = member
        if 'manifest.json' not in members or members['manifest.json'].size > 64 * 1024:
            raise ValueError('Bundle manifest is missing or oversized.')
        manifest = validate_manifest(json.loads(archive.extractfile(members.pop('manifest.json')).read()))
        if members.keys() != manifest['files'].keys():
            raise ValueError('Bundle bytes differ from the complete manifest inventory.')
        for name, member in members.items():
            digest, data, output = hashlib.sha256(), bytearray() if retain_files else None, None
            try:
                if output_directory is not None:
                    path = Path(output_directory) / name
                    path.parent.mkdir(parents=True, exist_ok=True)
                    output = path.open('xb')
                with archive.extractfile(member) as source:
                    for block in iter(lambda: source.read(1024 ** 2), b''):
                        digest.update(block)
                        if data is not None:
                            data.extend(block)
                        if output is not None:
                            output.write(block)
                if digest.hexdigest() != manifest['files'][name]:
                    raise ValueError('Bundle bytes differ from the complete manifest inventory.')
                if output is not None:
                    output.flush()
                    os.fsync(output.fileno())
                    path.chmod(0o555 if name in EXECUTABLES else 0o444)
                if data is not None:
                    files[name] = bytes(data)
            finally:
                if output is not None:
                    output.close()
    return manifest, files


def verify_directory(folder):
    folder = Path(folder)
    if folder.is_symlink():
        raise ValueError('Verify the real immutable release directory, not a moving symlink.')
    manifest = validate_manifest(json.loads((folder / 'manifest.json').read_text()))
    actual = set()
    for path in folder.rglob('*'):
        if path.is_symlink():
            raise ValueError('Release payload must contain no symlinks.')
        if path.is_file():
            relative = path.relative_to(folder).as_posix()
            actual.add(relative)
            if path.stat().st_mode & 0o222:
                raise ValueError('Release bytes must be read-only.')
            if relative != 'manifest.json' and file_sha(path) != manifest['files'].get(relative):
                raise ValueError('Deployed file digest mismatch.')
    if actual != set(manifest['files']) | {'manifest.json'}:
        raise ValueError('Deployed directory contains missing or additional files.')
    return manifest


def build(root, commit, node_archive, codex_archive, output):
    if not OID.fullmatch(commit):
        raise ValueError('Build an exact source commit, not a moving branch.')
    root, output = Path(root), Path(output)
    runtime = Path(node_archive).read_bytes()
    if len(runtime) > MAX_BYTES or sha(runtime) != NODE_ARCHIVE_SHA256:
        raise ValueError('Node archive differs from the official pinned ARM64 checksum.')
    files = {}
    prefix = f'node-v{NODE_VERSION}-linux-arm64/'
    with tarfile.open(fileobj=io.BytesIO(runtime), mode='r:xz') as archive:
        for name, target in [('bin/node', 'runtime/bin/node'), ('LICENSE', 'runtime/LICENSE')]:
            member = archive.getmember(prefix + name)
            if not member.isfile() or member.size > MAX_BYTES:
                raise ValueError('Invalid runtime archive member.')
            files[target] = archive.extractfile(member).read()
    if Path(codex_archive).stat().st_size > MAX_CODEX_ARCHIVE_BYTES:
        raise ValueError('Codex archive exceeds the off-host input ceiling.')
    native = Path(codex_archive).read_bytes()
    if (len(native) > MAX_CODEX_ARCHIVE_BYTES or sha(native) != CODEX_ARCHIVE_SHA256
            or 'sha512-' + base64.b64encode(hashlib.sha512(native).digest()).decode() != CODEX_ARCHIVE_INTEGRITY):
        raise ValueError('Codex archive differs from its pinned npm distribution integrity.')
    prefix = f'package/vendor/{CODEX_TARGET}/'
    with tarfile.open(fileobj=io.BytesIO(native), mode='r:gz') as archive:
        for name, target in [(prefix + 'bin/codex', CODEX_ENTRYPOINT),
                             (prefix + 'codex-resources/bwrap', 'runtime/codex/codex-resources/bwrap'),
                             (prefix + 'codex-package.json', 'runtime/codex/codex-package.json'),
                             ('package/package.json', 'runtime/codex/package.json')]:
            member = archive.getmember(name)
            if not member.isfile() or member.size > MAX_BYTES:
                raise ValueError('Invalid Codex archive member.')
            files[target] = archive.extractfile(member).read()
            if sha(files[target]) != CODEX_FILES[target]:
                raise ValueError('Codex native executable or metadata digest differs.')
            if target in EXECUTABLES and (files[target][:6] != b'\x7fELF\x02\x01' or files[target][18:20] != b'\xb7\x00'):
                raise ValueError('Codex executable is not Linux ELF64 little-endian AArch64.')
    def git(*args):
        return subprocess.check_output(['git', '-C', str(root), *args])
    tree = git('rev-parse', commit + '^{tree}').decode().strip()
    schema_source = git('show', f'{commit}:server/schema.mjs').decode()
    if not re.search(r'^export const SCHEMA_VERSION = 2;$', schema_source, re.MULTILINE):
        raise ValueError('Build source does not declare the current application database epoch.')
    files['runtime/codex/LICENSE'] = git('show', f'{commit}:deploy/justup-preview/codex-LICENSE')
    if sha(files['runtime/codex/LICENSE']) != CODEX_FILES['runtime/codex/LICENSE']:
        raise ValueError('Codex license differs from the pinned official source.')
    entries = git('ls-tree', '-r', commit, '--', 'server', 'scripts/import-jobs.py',
                  'scripts/hiring-wire/enqueue.mjs', 'scripts/hiring-wire/check-snapshot.mjs').decode().splitlines()
    for entry in entries:
        meta, path = entry.split('\t', 1)
        target = 'app/' + path
        if not allowed(target):
            continue
        if meta.split()[0] not in {'100644', '100755'}:
            raise ValueError('Application source must contain regular files only.')
        files[target] = git('show', f'{commit}:{path}')
    manifest = {'formatVersion': 2, 'sourceCommit': commit, 'sourceTree': tree,
                'schemaVersion': 2, 'nodeVersion': NODE_VERSION, 'platform': 'linux-arm64',
                'nodeArchiveSha256': NODE_ARCHIVE_SHA256, 'entrypoint': 'app/server/main.mjs',
                'codexVersion': CODEX_VERSION, 'codexTarget': CODEX_TARGET,
                'codexArchiveSha256': CODEX_ARCHIVE_SHA256, 'codexEntrypoint': CODEX_ENTRYPOINT,
                'files': {name: sha(data) for name, data in sorted(files.items())}}
    manifest['buildIdentity'] = identity(manifest)
    validate_manifest(manifest)
    files['manifest.json'] = canonical(manifest) + b'\n'
    if sum(map(len, files.values())) > MAX_BYTES:
        raise ValueError('Artifact exceeds the unpacked byte ceiling.')
    with output.open('xb') as stream, tarfile.open(fileobj=stream, mode='w') as archive:
        for name, data in sorted(files.items()):
            info = tarfile.TarInfo(name)
            info.size, info.mtime, info.uid, info.gid = len(data), 0, 0, 0
            info.mode = 0o555 if name in EXECUTABLES else 0o444
            archive.addfile(info, io.BytesIO(data))
    return {'bundleSha256': file_sha(output), 'buildIdentity': manifest['buildIdentity'],
            'sourceCommit': commit, 'sourceTree': tree, 'bytes': output.stat().st_size}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    make = commands.add_parser('build')
    make.add_argument('--source-root', type=Path, required=True)
    make.add_argument('--commit', required=True)
    make.add_argument('--node-archive', type=Path, required=True)
    make.add_argument('--codex-archive', type=Path, required=True)
    make.add_argument('--output', type=Path, required=True)
    verify = commands.add_parser('verify')
    verify.add_argument('--bundle', type=Path, required=True)
    verify.add_argument('--sha256', required=True)
    folder = commands.add_parser('verify-directory')
    folder.add_argument('--directory', type=Path, required=True)
    args = parser.parse_args()
    try:
        if args.command == 'build':
            result = build(args.source_root, args.commit, args.node_archive, args.codex_archive, args.output)
        elif args.command == 'verify':
            result = read_bundle(args.bundle, args.sha256, retain_files=False)[0]
        else:
            result = verify_directory(args.directory)
        print(json.dumps(result, sort_keys=True))
        return 0
    except (ValueError, OSError, KeyError, tarfile.TarError, subprocess.CalledProcessError):
        print('Artifact verification failed; no runtime was activated.', file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
