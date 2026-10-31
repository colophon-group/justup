#!/usr/bin/env python3
"""Record actual HTTP identity/readiness evidence for one fixed preview candidate.

This complements frontend-owned browser journeys. A process-only result cannot
mark a preview shareable or satisfy the complete release gate.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone, timedelta
import importlib.util
import json
from pathlib import Path
import re
import sys
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

MAX_BODY = 1024 ** 2


class FixedOriginRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if urlsplit(req.full_url).netloc != urlsplit(newurl).netloc:
            raise ValueError('Candidate redirected to another host.')
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def get(url, as_json=True):
    opener = build_opener(FixedOriginRedirect())
    with opener.open(Request(url, headers={'Accept': 'application/json' if as_json else 'text/html'}), timeout=10) as response:
        data = response.read(MAX_BODY + 1)
        if len(data) > MAX_BODY or response.status != 200:
            raise ValueError('Candidate response is oversized or unsuccessful.')
        headers = {key.lower(): value for key, value in response.headers.items()}
        return (json.loads(data) if as_json else data.decode('utf8')), headers


def timestamp(value):
    result = datetime.fromisoformat(value.replace('Z', '+00:00'))
    if result.tzinfo is None:
        raise ValueError('Candidate timestamp lacks its timezone.')
    return result.astimezone(timezone.utc)


def verify(base_url, manifest, mode, runner_identity=None, import_generation=None, policy_version=None, fetch=get):
    base_url = base_url.rstrip('/')
    origin = urlsplit(base_url)
    if origin.username or origin.password or origin.path or origin.query or origin.fragment or not origin.hostname:
        raise ValueError('Use one fixed candidate origin without credentials or a path.')
    if origin.scheme != 'https' and not (mode == 'process' and origin.scheme == 'http' and origin.hostname in {'127.0.0.1', 'localhost'}):
        raise ValueError('The shared preview requires HTTPS.')
    expected = {'sourceCommit': manifest['sourceCommit'], 'buildIdentity': manifest['buildIdentity'], 'schemaVersion': manifest['schemaVersion']}
    health, _ = fetch(base_url + '/api/v1/health')
    if health.get('ready') is not True:
        raise ValueError('API process is not ready.')
    version, _ = fetch(base_url + '/api/v1/version')
    if any(version.get(key) != value for key, value in expected.items()):
        raise ValueError('Deployed API source, schema or build identity differs.')
    session, headers = fetch(base_url + '/api/v1/session')
    if 'no-store' not in headers.get('cache-control', '') or session.get('user') is not None:
        raise ValueError('Guest session is cached or discloses a user.')
    access = session.get('access', {})
    if access.get('kind') != 'guest' or access.get('fullAccess') is not False or access.get('billingEnabled') is not False:
        raise ValueError('Guest access or disabled billing contract differs.')
    caps = session.get('capabilities', {})
    if any(caps.get(key) is not False for key in ('sse', 'follows', 'viewed', 'preferences', 'hiddenMatchCounts')):
        raise ValueError('An unavailable demo capability was not reported as disabled.')
    checks = ['process_ready', 'exact_api_identity', 'uncached_guest_session', 'guest_access', 'disabled_capabilities']
    if mode == 'preview':
        if not runner_identity or version.get('runner', {}).get('ready') is not True or version.get('runner', {}).get('identity') != runner_identity:
            raise ValueError('Actual runner readiness and exact identity are required.')
        if not import_generation or version.get('importGeneration') != import_generation:
            raise ValueError('Deployed import generation differs from the verified snapshot.')
        policies = session.get('policies', {})
        if not policy_version or policies.get('reviewed') is not True or policies.get('version') != policy_version:
            raise ValueError('Approved policy version is absent or differs.')
        for key in ('privacyUrl', 'usageUrl'):
            url = urlsplit(policies.get(key, ''))
            if url.scheme != 'https' or url.netloc != origin.netloc or url.username or url.password:
                raise ValueError('Policy page does not belong to the approved HTTPS preview origin.')
            fetch(policies[key], False)
        if any(caps.get(key) is not True for key in ('search', 'companyRequests')):
            raise ValueError('Required live demo capabilities are unavailable.')
        if session.get('coverage', {}).get('stale') is not False:
            raise ValueError('Imported coverage is stale or unavailable.')
        jobs, _ = fetch(base_url + '/api/v1/jobs?limit=12')
        if not jobs.get('items'):
            raise ValueError('A representative eligible guest listing is required.')
        now = timestamp(session['serverTime'])
        for item in jobs['items']:
            observed = timestamp(item['firstObserved'])
            if not now - timedelta(days=14) < observed <= now - timedelta(hours=48):
                raise ValueError('Guest listing age falls outside the explicit demo access interval.')
            if any(key in item for key in ('body', 'description', 'evidenceHash', 'internal', 'boards')):
                raise ValueError('Public listing contains internal or full-body data.')
            source = urlsplit(item.get('sourceUrl', ''))
            if source.scheme != 'https' or not source.hostname or source.username or source.password:
                raise ValueError('Public listing source URL is not a safe HTTPS link.')
        html, frontend_headers = fetch(base_url, False)
        if 'noindex' not in frontend_headers.get('x-robots-tag', '').lower() and not re.search(r'<meta[^>]+name=["\']robots["\'][^>]+content=["\'][^"\']*noindex', html, re.I):
            raise ValueError('Frontend candidate does not explicitly exclude indexing.')
        checks += ['exact_ready_runner', 'exact_import_generation', 'approved_policy_pages', 'live_capabilities',
                   'fresh_guest_public_projection', 'frontend_noindex']
    return {'formatVersion': 1, 'scope': mode, 'baseUrl': base_url, **expected,
            'runnerIdentity': version.get('runner', {}).get('identity'), 'importGeneration': version.get('importGeneration'),
            'checkedAt': datetime.now(timezone.utc).isoformat(), 'checks': checks, 'passed': True,
            'completeReleaseGate': False, 'browserJourneysRequired': True,
            'shareable': False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base-url', required=True)
    parser.add_argument('--manifest', type=Path, required=True)
    parser.add_argument('--mode', choices=['process', 'preview'], required=True)
    parser.add_argument('--expected-runner-identity')
    parser.add_argument('--expected-import-generation')
    parser.add_argument('--approved-policy-version')
    parser.add_argument('--report', type=Path, required=True)
    args = parser.parse_args()
    try:
        spec = importlib.util.spec_from_file_location('preview_artifact', Path(__file__).with_name('preview-artifact.py'))
        artifact = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(artifact)
        manifest = artifact.validate_manifest(json.loads(args.manifest.read_text()))
        report = verify(args.base_url, manifest, args.mode, args.expected_runner_identity,
                        args.expected_import_generation, args.approved_policy_version)
        status = 0
    except (ValueError, OSError, KeyError, TypeError, HTTPError, URLError):
        report = {'formatVersion': 1, 'scope': args.mode, 'passed': False, 'shareable': False,
                  'completeReleaseGate': False, 'error': 'candidate_verification_failed'}
        status = 1
    # Report only assertions and fixed build identities, never HTTP bodies/cookies.
    with args.report.open('x') as file:
        json.dump(report, file, sort_keys=True, indent=2)
        file.write('\n')
    print(json.dumps(report, sort_keys=True))
    return status


if __name__ == '__main__':
    raise SystemExit(main())
