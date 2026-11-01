#!/usr/bin/env python3
"""Poll Justup's critical IRM groups and queue one fixed Codex triage prompt.

Run as a macOS LaunchAgent after the read-only IRM token and dedicated Codex chat
have been reviewed. This watcher cannot page a phone; Grafana IRM owns paging.
"""
from __future__ import annotations

import argparse
from contextlib import closing
import fcntl
import json
import os
from pathlib import Path
import plistlib
import re
import sqlite3
import stat
import subprocess
import sys
import time
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlparse
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener
from uuid import UUID

GROUP_ID = re.compile(r'[A-Z0-9]{8,32}\Z')
INTEGRATION_ID = GROUP_ID
MAX_RESPONSE = 512 * 1024
MAX_PAGES = 3
MAX_ROWS = 10_000
KEYCHAIN_SERVICE = 'justup-irm-alert-groups-readonly'
KEYCHAIN_ACCOUNT = 'justup-incident-watch'
DEFAULT_CONFIG = Path.home() / 'Library/Application Support/Justup/incident-watch.json'
LAUNCH_AGENT = 'com.colophon.justup-incident-watch'
PROMPT = (
    'Justup critical IRM alert group {id} is active. Perform read-only incident triage. '
    'Use only approved read-only sources; report customer impact, evidence, likely cause and '
    'recommended operator action. Do not deploy, restart services, change data or alert rules, '
    'acknowledge the incident, or message anyone. If evidence is unavailable, say so.'
)


class WatchError(Exception):
    """A safe, operator-actionable watcher failure."""


def private_file(path: Path, maximum: int) -> bytes:
    path = path.expanduser()
    if not path.is_absolute() or path.resolve(strict=True) != path:
        raise WatchError('Configuration or evidence path is not canonical.')
    parent = path.parent.stat()
    if not stat.S_ISDIR(parent.st_mode) or parent.st_uid != os.getuid() or parent.st_mode & 0o077:
        raise WatchError('Watcher configuration directory is not private.')
    before = path.lstat()
    if (not stat.S_ISREG(before.st_mode) or before.st_uid != os.getuid()
            or before.st_nlink != 1 or before.st_mode & 0o077 or not 0 < before.st_size <= maximum):
        raise WatchError('Configuration or evidence file is not private and bounded.')
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC)
    try:
        opened = os.fstat(fd)
        if (not stat.S_ISREG(opened.st_mode) or opened.st_dev != before.st_dev
                or opened.st_ino != before.st_ino or opened.st_uid != before.st_uid
                or opened.st_size != before.st_size):
            raise WatchError('Configuration or evidence changed while reading.')
        data = os.read(fd, maximum + 1)
        if len(data) != before.st_size:
            raise WatchError('Configuration or evidence changed while reading.')
        return data
    finally:
        os.close(fd)


def https_url(value: str, *, stack: bool) -> str:
    if (not isinstance(value, str) or len(value) > 300
            or any(ord(char) <= 32 or ord(char) == 127 for char in value)):
        raise WatchError('IRM and stack URLs must be reviewed HTTPS URLs.')
    parsed = urlparse(value)
    host = parsed.hostname or ''
    if (parsed.scheme != 'https' or not host.endswith('.grafana.net')
            or parsed.username or parsed.password or parsed.port
            or parsed.query or parsed.fragment or (stack and parsed.path not in ('', '/'))
            or not stack and ('..' in parsed.path or parsed.path.endswith('/api/v1/alert_groups/'))):
        raise WatchError('IRM and stack URLs must be reviewed HTTPS Grafana endpoints.')
    return value.rstrip('/')


def read_config(path: Path) -> dict:
    raw = json.loads(private_file(path, 8192))
    if not isinstance(raw, dict) or set(raw) != {'api_url', 'stack_url', 'integration_id', 'thread_id', 'codex_bin'}:
        raise WatchError('Watcher configuration has unknown or missing fields.')
    raw['api_url'] = https_url(raw['api_url'], stack=False)
    raw['stack_url'] = https_url(raw['stack_url'], stack=True)
    if not isinstance(raw['integration_id'], str) or not INTEGRATION_ID.fullmatch(raw['integration_id']):
        raise WatchError('Use the exact Justup-only IRM integration ID.')
    try:
        if str(UUID(raw['thread_id'])) != raw['thread_id']:
            raise ValueError()
    except (ValueError, TypeError, AttributeError):
        raise WatchError('Use the reviewed dedicated Codex chat UUID.') from None
    codex = Path(raw['codex_bin']) if isinstance(raw['codex_bin'], str) else Path('')
    if not codex.is_absolute() or not codex.is_file() or not os.access(codex, os.X_OK):
        raise WatchError('Codex binary must be an absolute executable path.')
    return raw


def keychain_token() -> str:
    result = subprocess.run(['/usr/bin/security', 'find-generic-password', '-w',
                             '-s', KEYCHAIN_SERVICE, '-a', KEYCHAIN_ACCOUNT],
                            capture_output=True, timeout=10, check=False)
    token = result.stdout.rstrip(b'\r\n')
    if result.returncode or not 16 <= len(token) <= 4096 or any(char <= 32 or char >= 127 for char in token):
        raise WatchError('The read-only IRM token is unavailable from macOS Keychain.')
    return token.decode('ascii')


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, newurl):
        return None


def fetch_groups(config: dict, token: str, *, opener=None) -> list[str]:
    opener = opener or build_opener(NoRedirect(), ProxyHandler({}))
    found: list[str] = []
    for state in ('new', 'acknowledged'):
        pages = None
        for page in range(1, MAX_PAGES + 1):
            query = urlencode({'integration_id': config['integration_id'],
                               'label': 'severity:critical', 'state': state,
                               'page': page, 'perpage': 100})
            url = config['api_url'] + '/api/v1/alert_groups/?' + query
            request = Request(url, headers={'Authorization': 'Bearer ' + token,
                                            'X-Grafana-URL': config['stack_url'],
                                            'Accept': 'application/json'}, method='GET')
            with opener.open(request, timeout=10) as response:
                if response.status != 200:
                    raise WatchError('IRM did not return a successful read-only response.')
                body = response.read(MAX_RESPONSE + 1)
            if len(body) > MAX_RESPONSE:
                raise WatchError('IRM returned an oversized response.')
            payload = json.loads(body)
            if not isinstance(payload, dict) or not isinstance(payload.get('results'), list):
                raise WatchError('IRM returned an unexpected alert-group response.')
            total = payload.get('total_pages')
            if isinstance(total, bool) or not isinstance(total, int) or not 0 <= total <= MAX_PAGES:
                raise WatchError('IRM pagination exceeds the reviewed watcher limit.')
            if total == 0:
                if page != 1 or payload['results']:
                    raise WatchError('IRM returned inconsistent empty pagination.')
                break
            if pages is not None and pages != total:
                raise WatchError('IRM pagination changed during the poll.')
            pages = total
            for group in payload['results']:
                if not isinstance(group, dict):
                    raise WatchError('IRM returned an invalid alert group.')
                group_id = group.get('id')
                if group.get('integration_id') != config['integration_id'] or group.get('state') != state:
                    raise WatchError('IRM returned an alert group outside the requested scope.')
                if not isinstance(group_id, str) or not GROUP_ID.fullmatch(group_id):
                    raise WatchError('IRM returned an invalid alert-group ID.')
                found.append(group_id)
            if page == total:
                break
    return list(dict.fromkeys(found))


def state_dir(path: Path) -> Path:
    folder = path.parent / 'incident-watch-state'
    folder.mkdir(mode=0o700, exist_ok=True)
    meta = folder.lstat()
    if not stat.S_ISDIR(meta.st_mode) or meta.st_uid != os.getuid() or meta.st_mode & 0o077:
        raise WatchError('Watcher state directory is not private.')
    return folder


def open_state(folder: Path):
    database = folder / 'deliveries.sqlite3'
    if os.path.lexists(database):
        meta = database.lstat()
        if (not stat.S_ISREG(meta.st_mode) or meta.st_uid != os.getuid()
                or meta.st_nlink != 1 or meta.st_mode & 0o077):
            raise WatchError('Watcher state database is not private.')
    old_umask = os.umask(0o077)
    try:
        connection = sqlite3.connect(database, timeout=3)
    finally:
        os.umask(old_umask)
    connection.execute('CREATE TABLE IF NOT EXISTS deliveries ('
                       'id TEXT PRIMARY KEY, status TEXT NOT NULL CHECK(status IN (\'claimed\', \'queued\')),'
                       'first_seen INTEGER NOT NULL, queued_at INTEGER)')
    connection.commit()
    return connection


def queue_codex(config: dict, group_id: str) -> bool:
    if not GROUP_ID.fullmatch(group_id):
        raise WatchError('Refuse an unvalidated alert-group ID.')
    result = subprocess.run([config['codex_bin'], 'queue', '--resume', '--thread', config['thread_id'],
                             '--message', PROMPT.format(id=group_id)],
                            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                            stderr=subprocess.PIPE, timeout=30, check=False)
    # Codex 0.166 can queue successfully but only warn when resume fails.
    # An ambiguous wake must not be silently called successful or replayed.
    return result.returncode == 0 and not result.stderr


def deliver_one(connection, groups: list[str], config: dict, queue=queue_codex) -> str | None:
    if connection.execute('SELECT COUNT(*) FROM deliveries').fetchone()[0] >= MAX_ROWS:
        raise WatchError('Watcher delivery history reached its reviewed bound.')
    for group_id in groups:
        if not GROUP_ID.fullmatch(group_id):
            raise WatchError('Refuse an unvalidated alert-group ID.')
        connection.execute('BEGIN IMMEDIATE')
        existing = connection.execute('SELECT status FROM deliveries WHERE id=?', (group_id,)).fetchone()
        if existing:
            connection.rollback()
            continue
        connection.execute('INSERT INTO deliveries(id,status,first_seen) VALUES(?,?,?)',
                           (group_id, 'claimed', int(time.time())))
        connection.commit()
        # A crash after this durable claim has an ambiguous queue outcome. Do not
        # replay automatically; the operator must inspect the Codex chat first.
        try:
            accepted = queue(config, group_id)
        except (OSError, subprocess.SubprocessError):
            accepted = False
        if not accepted:
            raise WatchError('Codex queue outcome is uncertain; inspect the chat before retrying.')
        connection.execute('UPDATE deliveries SET status=\'queued\',queued_at=? WHERE id=?',
                           (int(time.time()), group_id))
        connection.commit()
        return group_id
    return None


def run_once(config_path: Path, *, fetch=fetch_groups, queue=queue_codex) -> str | None:
    supplied_path = config_path.expanduser()
    config = read_config(supplied_path)
    config_path = supplied_path.resolve(strict=True)
    folder = state_dir(config_path)
    lock = folder / 'watch.lock'
    old_umask = os.umask(0o077)
    try:
        lock_fd = os.open(lock, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
    finally:
        os.umask(old_umask)
    try:
        fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        token = keychain_token()
        groups = fetch(config, token)
        with closing(open_state(folder)) as connection:
            return deliver_one(connection, groups, config, queue)
    finally:
        os.close(lock_fd)


def launchagent_plist(config_path: Path) -> bytes:
    if not config_path.is_absolute():
        raise WatchError('LaunchAgent needs an absolute config path.')
    return plistlib.dumps({'Label': LAUNCH_AGENT,
                           'ProgramArguments': [sys.executable, str(Path(__file__).resolve()),
                                                '--config', str(config_path), 'once'],
                           'RunAtLoad': True, 'StartInterval': 120,
                           'ProcessType': 'Background'})


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', type=Path, default=DEFAULT_CONFIG)
    parser.add_argument('command', choices=('once', 'launchagent'))
    args = parser.parse_args()
    try:
        if args.command == 'launchagent':
            sys.stdout.buffer.write(launchagent_plist(args.config))
        else:
            run_once(args.config)
        return 0
    except (WatchError, ValueError, OSError, UnicodeError, json.JSONDecodeError,
            HTTPError, URLError, sqlite3.Error, subprocess.SubprocessError, BlockingIOError) as error:
        detail = str(error) if isinstance(error, WatchError) else type(error).__name__
        print(f'Justup incident watcher: {detail}; no alert content logged.', file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
