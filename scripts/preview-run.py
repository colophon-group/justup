#!/usr/bin/env python3
"""Launch the fixed API with a credential allowlist and bounded, redacted local logs.

This is an API launcher, not a model-agent launcher. Model credentials and tools
must run behind a separately reviewed isolation boundary.
"""
from __future__ import annotations

import importlib.util
import json
import math
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import time
from urllib.parse import urlsplit

BASE = Path('/srv/justup_preview')
CONFIG_KEYS = {
    'JUSTUP_DEMO_ORIGIN', 'JUSTUP_DEMO_INVITE_CODE', 'JUSTUP_DEMO_CSRF_SECRET', 'JUSTUP_DEMO_CURSOR_SECRET',
    'JUSTUP_DEMO_POLICIES_REVIEWED', 'JUSTUP_DEMO_PRIVACY_URL', 'JUSTUP_DEMO_USAGE_URL', 'JUSTUP_DEMO_POLICY_VERSION',
}
CATEGORIES = {'unknown', 'auth', 'mutation', 'health', 'read'}
ROUTES = {'session', 'auth', 'jobs', 'searches', 'tasks', 'companies', 'company-requests', 'account', 'health', 'version'}
MAX_LOG_BYTES = 8 * 1024 ** 2


def module(name):
    path = Path(__file__).with_name(name + '.py')
    spec = importlib.util.spec_from_file_location(name.replace('-', '_'), path)
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


def safe_log(value):
    if not isinstance(value, dict):
        return None
    result = {}
    if value.get('category') in CATEGORIES:
        result['category'] = value['category']
    route = value.get('route')
    if isinstance(route, str) and route in ROUTES:
        result['route'] = route
    for key, minimum, maximum in [('status', 100, 599), ('durationMs', 0, 3600000), ('tokens', 0, 1000000), ('costUsd', 0, 100)]:
        number = value.get(key)
        if type(number) in (int, float) and math.isfinite(number) and minimum <= number <= maximum:
            result[key] = number
    request_id = value.get('requestId')
    if isinstance(request_id, str) and re.fullmatch(r'[a-f0-9-]{36}', request_id):
        result['requestId'] = request_id
    code = value.get('code')
    if code in {'ready', 'request', 'dependency_unavailable', 'rate_limited', 'task_failed', 'task_completed', 'disk_floor', 'retention_completed'}:
        result['code'] = code
    if not result:
        return None
    result['at'] = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
    return result


def log_event(value, folder):
    safe = safe_log(value)
    if safe is None:
        return
    folder = Path(folder)
    now = time.time()
    files = sorted(folder.glob('api-*.jsonl'))
    for old in files:
        if old.is_symlink() or not old.is_file():
            raise ValueError('Log paths must be dedicated regular files.')
        if old.stat().st_mtime < now - 7 * 86400:
            old.unlink()
    today = folder / time.strftime('api-%Y%m%d.jsonl', time.gmtime())
    if today.is_symlink():
        raise ValueError('Log path cannot be a symlink.')
    encoded = json.dumps(safe, sort_keys=True) + '\n'
    if today.exists() and today.stat().st_size + len(encoded.encode()) > MAX_LOG_BYTES:
        return  # Bound one day's telemetry; never spill to global journald.
    with today.open('a', encoding='utf8') as stream:
        os.chmod(today, 0o600)
        stream.write(encoded)
    # At most seven active daily files plus today's creation; the host guard also
    # enforces the aggregate 128 MiB budget for all future preview components.


def child_environment(config, manifest):
    if not isinstance(config, dict) or set(config) - CONFIG_KEYS or any(not isinstance(value, str) for value in config.values()):
        raise ValueError('Only the documented API configuration keys are accepted.')
    origin = urlsplit(config.get('JUSTUP_DEMO_ORIGIN', ''))
    if origin.scheme != 'https' or not origin.hostname or origin.path or origin.query or origin.fragment or origin.username or origin.password:
        raise ValueError('API origin must be an exact HTTPS origin.')
    for key in ('JUSTUP_DEMO_CSRF_SECRET', 'JUSTUP_DEMO_CURSOR_SECRET'):
        if len(config.get(key, '').encode()) < 32:
            raise ValueError('Stable API CSRF and cursor secrets are required.')
    if config.get('JUSTUP_DEMO_POLICIES_REVIEWED') == 'true':
        for key in ('JUSTUP_DEMO_PRIVACY_URL', 'JUSTUP_DEMO_USAGE_URL'):
            parsed = urlsplit(config.get(key, ''))
            if parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password:
                raise ValueError('Reviewed policy URLs must use HTTPS.')
        if not config.get('JUSTUP_DEMO_POLICY_VERSION'):
            raise ValueError('Reviewed policy version is required.')
    result = {'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8', 'TZ': 'UTC', 'HOME': str(BASE / 'state'),
              'TMPDIR': str(BASE / 'state/work'), **config,
              'JUSTUP_DEMO_PORT': '8787', 'JUSTUP_DEMO_DB_PATH': str(BASE / 'state/preview.sqlite'),
              'JUSTUP_DEMO_PRIVATE_GENERATION_PATH': str(BASE / 'state/private-generation'),
              'JUSTUP_DEMO_BACKUP_DIR': str(BASE / 'state/backups'),
              'JUSTUP_DEMO_SOURCE_COMMIT': manifest['sourceCommit'],
              'JUSTUP_DEMO_BUILD_ID': manifest['buildIdentity']}
    result.setdefault('JUSTUP_DEMO_POLICIES_REVIEWED', 'false')
    return result


def main():
    try:
        release = (BASE / 'current').resolve(strict=True)
        if release.parent != BASE / 'releases':
            raise ValueError('Current release points outside the dedicated release directory.')
        manifest = module('preview-artifact').verify_directory(release)
        config_path = BASE / 'config/api.json'
        if config_path.is_symlink() or config_path.stat().st_mode & 0o077:
            raise ValueError('API config must be a private regular file.')
        config = json.loads(config_path.read_text())
        environment = child_environment(config, manifest)
        child = subprocess.Popen([str(release / 'runtime/bin/node'), str(release / manifest['entrypoint'])],
                                 cwd=release / 'app', env=environment, stdout=subprocess.PIPE,
                                 stderr=subprocess.STDOUT, start_new_session=True)
        def stop(signum, frame):
            os.killpg(child.pid, signum)
        signal.signal(signal.SIGTERM, stop)
        signal.signal(signal.SIGINT, stop)
        # A bounded reader drains unknown/provider output without persisting it.
        while line := child.stdout.readline(8193):
            if len(line) > 8192 or not line.endswith(b'\n'):
                # Drain the rest of one oversized line without accepting a suffix
                # as a fresh JSON event.
                while line and not line.endswith(b'\n'):
                    line = child.stdout.readline(8193)
                continue
            try:
                log_event(json.loads(line), BASE / 'logs')
            except (ValueError, UnicodeError):
                pass
        return child.wait()
    except (ValueError, OSError, KeyError, json.JSONDecodeError):
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
