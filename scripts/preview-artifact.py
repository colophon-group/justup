#!/usr/bin/env python3
"""Build immutable ARM64 preview bytes off-host and validate their complete inventory."""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import subprocess
import sys
import tarfile

NODE_VERSION = '24.22.2'
NODE_ARCHIVE_SHA256 = 'eb187837a2230d4047161ac0be008584e16b46f726e9c9490ee35dc6b17d9ba8'
MAX_BYTES = 384 * 1024 ** 2
SHA = re.compile(r'^[a-f0-9]{64}$')
OID = re.compile(r'^[a-f0-9]{40}$')


def sha(data):
    return hashlib.sha256(data).hexdigest()


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':')).encode()


def allowed(path):
    parts = PurePosixPath(path).parts
    return (not path.startswith('/') and '..' not in parts and '\\' not in path
            and (path in {'runtime/bin/node', 'runtime/LICENSE'} or
                 (path.startswith('app/server/') and path.endswith('.mjs') and not path.endswith('.test.mjs')) or
                 path in {'app/scripts/import-demo-jobs.py', 'app/server/model-schemas/intent.schema.json', 'app/server/model-schemas/company.schema.json'}))


def identity(manifest):
    return sha(canonical({key: value for key, value in manifest.items() if key != 'buildIdentity'}))


def validate_manifest(manifest):
    if manifest.get('formatVersion') != 1 or manifest.get('nodeVersion') != NODE_VERSION or manifest.get('platform') != 'linux-arm64':
        raise ValueError('Unsupported artifact format or runtime.')
    if not OID.fullmatch(manifest.get('sourceCommit', '')) or not OID.fullmatch(manifest.get('sourceTree', '')):
        raise ValueError('Artifact source must use exact Git commit and tree identities.')
    if manifest.get('schemaVersion') != 1 or manifest.get('entrypoint') != 'app/server/main.mjs':
        raise ValueError('Artifact schema or executable entrypoint differs from the preview contract.')
    files = manifest.get('files')
    required = {'runtime/bin/node', 'runtime/LICENSE'} | {'app/server/' + name + '.mjs' for name in ('main', 'auth', 'http', 'store', 'feed', 'tasks')}
    if not isinstance(files, dict) or not required <= files.keys():
        raise ValueError('Artifact is missing required runtime/application bytes.')
    for module, schema in [('intent.mjs', 'intent.schema.json'), ('companies.mjs', 'company.schema.json')]:
        if 'app/server/' + module in files and 'app/server/model-schemas/' + schema not in files:
            raise ValueError('Runtime module is missing its immutable model schema asset.')
    if any(not allowed(path) or not isinstance(value, str) or not SHA.fullmatch(value) for path, value in files.items()):
        raise ValueError('Artifact file inventory is unsafe or incomplete.')
    if manifest.get('nodeArchiveSha256') != NODE_ARCHIVE_SHA256 or manifest.get('buildIdentity') != identity(manifest):
        raise ValueError('Artifact runtime or build identity does not match its manifest.')
    return manifest


def read_bundle(bundle, expected_sha):
    if not SHA.fullmatch(expected_sha or '') or Path(bundle).stat().st_size > MAX_BYTES:
        raise ValueError('A bounded bundle with an exact expected SHA256 is required.')
    data = Path(bundle).read_bytes()
    if sha(data) != expected_sha:
        raise ValueError('Bundle SHA256 mismatch.')
    files = {}
    total = 0
    with tarfile.open(fileobj=io.BytesIO(data), mode='r:') as archive:
        for member in archive:
            if not member.isfile() or member.name in files or member.size > MAX_BYTES or not (allowed(member.name) or member.name == 'manifest.json'):
                raise ValueError('Bundle contains an unsafe, repeated or unexpected member.')
            total += member.size
            if total > MAX_BYTES:
                raise ValueError('Unpacked bundle exceeds its ceiling.')
            files[member.name] = archive.extractfile(member).read()
    if 'manifest.json' not in files or len(files['manifest.json']) > 64 * 1024:
        raise ValueError('Bundle manifest is missing or oversized.')
    manifest = validate_manifest(json.loads(files.pop('manifest.json')))
    if files.keys() != manifest['files'].keys() or any(sha(value) != manifest['files'][name] for name, value in files.items()):
        raise ValueError('Bundle bytes differ from the complete manifest inventory.')
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
            if relative != 'manifest.json' and sha(path.read_bytes()) != manifest['files'].get(relative):
                raise ValueError('Deployed file digest mismatch.')
    if actual != set(manifest['files']) | {'manifest.json'}:
        raise ValueError('Deployed directory contains missing or additional files.')
    return manifest


def build(root, commit, node_archive, output):
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
    def git(*args):
        return subprocess.check_output(['git', '-C', str(root), *args])
    tree = git('rev-parse', commit + '^{tree}').decode().strip()
    entries = git('ls-tree', '-r', commit, '--', 'server', 'scripts/import-demo-jobs.py').decode().splitlines()
    for entry in entries:
        meta, path = entry.split('\t', 1)
        target = 'app/' + path
        if not allowed(target):
            continue
        if meta.split()[0] not in {'100644', '100755'}:
            raise ValueError('Application source must contain regular files only.')
        files[target] = git('show', f'{commit}:{path}')
    manifest = {'formatVersion': 1, 'sourceCommit': commit, 'sourceTree': tree,
                'schemaVersion': 1, 'nodeVersion': NODE_VERSION, 'platform': 'linux-arm64',
                'nodeArchiveSha256': NODE_ARCHIVE_SHA256, 'entrypoint': 'app/server/main.mjs',
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
            info.mode = 0o555 if name == 'runtime/bin/node' else 0o444
            archive.addfile(info, io.BytesIO(data))
    return {'bundleSha256': sha(output.read_bytes()), 'buildIdentity': manifest['buildIdentity'],
            'sourceCommit': commit, 'sourceTree': tree, 'bytes': output.stat().st_size}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    make = commands.add_parser('build')
    make.add_argument('--source-root', type=Path, required=True)
    make.add_argument('--commit', required=True)
    make.add_argument('--node-archive', type=Path, required=True)
    make.add_argument('--output', type=Path, required=True)
    verify = commands.add_parser('verify')
    verify.add_argument('--bundle', type=Path, required=True)
    verify.add_argument('--sha256', required=True)
    folder = commands.add_parser('verify-directory')
    folder.add_argument('--directory', type=Path, required=True)
    args = parser.parse_args()
    try:
        if args.command == 'build':
            result = build(args.source_root, args.commit, args.node_archive, args.output)
        elif args.command == 'verify':
            result = read_bundle(args.bundle, args.sha256)[0]
        else:
            result = verify_directory(args.directory)
        print(json.dumps(result, sort_keys=True))
        return 0
    except (ValueError, OSError, KeyError, tarfile.TarError, subprocess.CalledProcessError):
        print('Artifact verification failed; no runtime was activated.', file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
