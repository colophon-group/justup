#!/usr/bin/env python3
"""Record actual HTTP identity/readiness evidence for one fixed preview candidate.

This complements frontend-owned browser journeys. A process-only result cannot
mark a preview shareable or satisfy the complete release gate.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone, timedelta
import hashlib
from html.parser import HTMLParser
import importlib.util
import json
from pathlib import Path
import re
import sys
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

MAX_BODY = 1024 ** 2
FIRST_RELEASE_CAPABILITIES = ('search', 'aiMatching', 'companyRequests', 'hiringWire',
                              'sse', 'follows', 'viewed', 'preferences', 'hiddenMatchCounts')


class FixedOriginRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        previous, following = urlsplit(req.full_url), urlsplit(newurl)
        if (previous.scheme, previous.netloc) != (following.scheme, following.netloc):
            raise ValueError('Candidate redirected to another origin.')
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def get(url, as_json=True, headers=None):
    opener = build_opener(FixedOriginRedirect())
    with opener.open(Request(url, headers={'Accept': 'application/json' if as_json else 'text/html', **(headers or {})}), timeout=10) as response:
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


def canonical_https_origin(value):
    if not isinstance(value, str):
        return False
    parsed = urlsplit(value)
    if (parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password
            or parsed.path or parsed.query or parsed.fragment):
        return False
    hostname = parsed.hostname.encode('idna').decode().lower()
    if ':' in hostname:
        hostname = '[' + hostname + ']'
    canonical = 'https://' + hostname + (':' + str(parsed.port) if parsed.port not in {None, 443} else '')
    return value == canonical


class PolicyMetadata(HTMLParser):
    def __init__(self):
        super().__init__()
        self.languages, self.versions, self.bodies = [], [], []

    def handle_starttag(self, tag, attributes):
        values = dict(attributes)
        if len(values) != len(attributes):
            raise ValueError('Policy metadata has duplicate attributes.')
        if tag == 'html':
            self.languages.append(values.get('lang'))
        if tag == 'meta' and values.get('name') == 'justup-policy-version':
            self.versions.append(values.get('content'))
        if tag == 'body':
            self.bodies.append((values.get('data-policy'), values.get('data-policy-version')))


def verify_policy_assets(base_url, manifest, frontend_release, proof, fetch=get):
    """Compare served bytes with operator-reviewed hashes in a retained inventory."""
    sha = lambda value: isinstance(value, str) and re.fullmatch(r'[a-f0-9]{64}', value)
    if (not isinstance(proof, dict) or set(proof) != {'origin', 'sourceCommit', 'assetsSha256', 'locales'}
            or proof['origin'] != base_url or proof['sourceCommit'] != manifest['sourceCommit']
            or not isinstance(proof['locales'], dict) or not proof['locales']
            or not isinstance(frontend_release, dict) or frontend_release.get('sourceSha') != manifest['sourceCommit']
            or frontend_release.get('treeSha') != manifest['sourceTree']
            or not sha(proof['assetsSha256']) or proof['assetsSha256'] != frontend_release.get('assetsSha256')):
        raise ValueError('Reviewed policy asset proof differs from the retained built frontend candidate.')
    assets = frontend_release.get('assets')
    if (not isinstance(assets, list) or not 1 <= len(assets) <= 200
            or any(not isinstance(asset, dict) or set(asset) != {'path', 'sha256', 'bytes'}
                   or not isinstance(asset['path'], str) or not sha(asset['sha256'])
                   or type(asset['bytes']) is not int or asset['bytes'] < 0 for asset in assets)
            or len({asset['path'] for asset in assets}) != len(assets)
            or hashlib.sha256(json.dumps(assets, ensure_ascii=False, separators=(',', ':')).encode()).hexdigest() != proof['assetsSha256']):
        raise ValueError('Retained policy asset inventory differs from its digest.')
    by_path = {asset['path']: asset for asset in assets}
    for locale, entry in proof['locales'].items():
        if (locale not in {'en', 'de', 'fr', 'it', 'es'} or not isinstance(entry, dict)
                or set(entry) != {'version', 'privacySha256', 'usageSha256'}
                or not isinstance(entry['version'], str) or not re.fullmatch(r'[A-Za-z0-9_.:-]{1,100}', entry['version'])):
            raise ValueError('Reviewed policy locale proof is invalid.')
        suffix = '' if locale == 'en' else '.' + locale
        for kind in ('privacy', 'usage'):
            path = kind + suffix + '.html'
            expected = entry[kind + 'Sha256']
            if not sha(expected) or by_path.get(path, {}).get('sha256') != expected:
                raise ValueError('Reviewed policy hash is absent from the retained artifact.')
            body, _ = fetch(base_url + '/' + path, False)
            if (not isinstance(body, str) or len(body.encode('utf8')) != by_path[path]['bytes']
                    or hashlib.sha256(body.encode('utf8')).hexdigest() != expected):
                raise ValueError('Served policy bytes differ from the reviewed retained artifact.')
            metadata = PolicyMetadata()
            metadata.feed(body)
            if (metadata.languages != [locale] or metadata.versions != [entry['version']]
                    or metadata.bodies != [(kind, entry['version'])]):
                raise ValueError('Served policy language, kind or version differs from the reviewed proof.')
    return proof


def verify(base_url, manifest, mode, runner_identity=None, import_generation=None, policy_version=None, fetch=get, frontend_release=None, frontend_config=None, policy_asset_proof=None):
    base_url = base_url.rstrip('/')
    origin = urlsplit(base_url)
    if origin.username or origin.password or origin.path or origin.query or origin.fragment or not origin.hostname:
        raise ValueError('Use one fixed candidate origin without credentials or a path.')
    if origin.scheme != 'https' and not (mode == 'process' and origin.scheme == 'http' and origin.hostname in {'127.0.0.1', 'localhost'}):
        raise ValueError('The shared preview requires HTTPS.')
    expected = {'sourceCommit': manifest['sourceCommit'], 'buildIdentity': manifest['buildIdentity'], 'schemaVersion': manifest['schemaVersion']}
    if mode == 'policies':
        proof = verify_policy_assets(base_url, manifest, frontend_release, policy_asset_proof, fetch)
        return {'formatVersion': 1, 'scope': mode, 'baseUrl': base_url, **expected, 'policyAssetProof': proof,
                'checkedAt': datetime.now(timezone.utc).isoformat(), 'checks': ['reviewed_retained_policy_bytes', 'exact_policy_locales_and_versions'],
                'passed': True, 'completeReleaseGate': False, 'browserJourneysRequired': True, 'shareable': False}
    def private_api(path, request_headers=None):
        value, headers = fetch(base_url + path, headers=request_headers) if request_headers else fetch(base_url + path)
        control = {part.strip().lower() for part in headers.get('cache-control', '').split(',')}
        if not {'private', 'no-store'} <= control or 'noindex' not in headers.get('x-robots-tag', '').lower():
            raise ValueError('API response is cached or does not exclude indexing.')
        return value

    health = private_api('/api/v1/health')
    if health.get('ready') is not True:
        raise ValueError('API process is not ready.')
    version = private_api('/api/v1/version')
    if any(version.get(key) != value for key, value in expected.items()):
        raise ValueError('Deployed API source, schema or build identity differs.')
    session = private_api('/api/v1/session')
    if session.get('user') is not None:
        raise ValueError('Guest session discloses a user.')
    access = session.get('access', {})
    if access.get('kind') != 'guest' or access.get('fullAccess') is not False or access.get('billingEnabled') is not False:
        raise ValueError('Guest access or disabled billing contract differs.')
    caps = session.get('capabilities', {})
    checks = ['process_ready', 'exact_api_identity', 'private_noindex_api', 'uncached_guest_session', 'guest_access']
    frontend_identity = None
    if mode == 'preview':
        if not runner_identity or version.get('runner', {}).get('ready') is not True or version.get('runner', {}).get('identity') != runner_identity:
            raise ValueError('Actual runner readiness and exact identity are required.')
        if not import_generation or version.get('importGeneration') != import_generation:
            raise ValueError('Deployed import generation differs from the verified snapshot.')
        proof = verify_policy_assets(base_url, manifest, frontend_release, policy_asset_proof, fetch)
        primary = 'en' if 'en' in proof['locales'] else sorted(proof['locales'])[0]
        for locale in ('en', 'de', 'fr', 'it', 'es'):
            localized = private_api('/api/v1/session', {'Accept-Language': locale})
            policies = localized.get('policies', {})
            if policies.get('locale') != locale or localized.get('user') is not None:
                raise ValueError('Session policy metadata differs from the selected interface locale.')
            if locale in proof['locales'] and policies.get('reviewed') is not True:
                raise ValueError('Approved policy locale is not admitted by the deployed API.')
            if policies.get('reviewed') is True:
                target = policies.get('reviewedLocale')
                approved = proof['locales'].get(target)
                suffix = '' if target == 'en' else '.' + str(target)
                if (not approved or policies.get('version') != approved['version']
                        or policies.get('fallback') is not (target != locale)
                        or any(policies.get(kind + 'Url') != base_url + '/' + kind + suffix + '.html' for kind in ('privacy', 'usage'))):
                    raise ValueError('Approved policy URLs or version differ from the verified locale proof.')
            if locale == primary:
                session, caps = localized, localized.get('capabilities', {})
        if policy_version is not None and session.get('policies', {}).get('version') != policy_version:
            raise ValueError('Approved policy version is absent or differs.')
        if any(caps.get(key) is not True for key in FIRST_RELEASE_CAPABILITIES):
            raise ValueError('Required live product capabilities are unavailable.')
        fields = ('sourceSha', 'treeSha', 'assetsSha256', 'workerSha256', 'artifactSha256')
        if (not isinstance(frontend_release, dict)
                or frontend_release.get('sourceSha') != manifest['sourceCommit']
                or frontend_release.get('treeSha') != manifest['sourceTree']
                or any(not re.fullmatch(r'[a-f0-9]{64}', frontend_release.get(key, '')) for key in fields[2:])):
            raise ValueError('The retained built frontend must match this exact backend candidate.')
        variables = frontend_config.get('vars') if isinstance(frontend_config, dict) else None
        if not isinstance(variables, dict) or variables.get('DEPLOYMENT_MODE') != 'preview' or variables.get('PUBLIC_ORIGIN') != base_url:
            raise ValueError('The retained runtime configuration must select this exact preview origin and mode.')
        if (not canonical_https_origin(base_url) or not canonical_https_origin(variables.get('API_ORIGIN'))
                or variables['API_ORIGIN'] == base_url):
            raise ValueError('The retained API origin must be a distinct canonical HTTPS origin.')
        runtime = {'publicOrigin': base_url, 'apiOrigin': variables['API_ORIGIN'], 'apiPrefix': '/api/v1', 'deploymentMode': 'preview'}
        runtime_sha = hashlib.sha256(json.dumps(runtime, ensure_ascii=False, separators=(',', ':')).encode()).hexdigest()
        retained_identity = {key: frontend_release[key] for key in fields}
        if (variables.get('RUNTIME_CONFIG_SHA256') != runtime_sha
                or json.loads(variables.get('RELEASE_JSON', 'null')) != retained_identity):
            raise ValueError('The retained runtime configuration identity differs from its origins or artifact.')
        expected_frontend = {**retained_identity, 'runtimeConfigSha256': runtime_sha, 'apiPrefix': '/api/v1', 'deploymentMode': 'preview'}
        deployed_frontend = private_api('/__release/version')
        if not isinstance(deployed_frontend, dict) or deployed_frontend != expected_frontend:
            raise ValueError('Deployed frontend identity differs from the retained compiled artifact.')
        frontend_identity = expected_frontend
        if session.get('coverage', {}).get('stale') is not False:
            raise ValueError('Imported coverage is stale or unavailable.')
        jobs = private_api('/api/v1/jobs?limit=12')
        if not jobs.get('items'):
            raise ValueError('A representative eligible guest listing is required.')
        now = timestamp(session['serverTime'])
        for item in jobs['items']:
            observed = timestamp(item['firstObserved'])
            if not now - timedelta(days=14) < observed <= now - timedelta(hours=48):
                raise ValueError('Guest listing age falls outside the product access interval.')
            if any(key in item for key in ('body', 'description', 'evidenceHash', 'internal', 'boards')):
                raise ValueError('Public listing contains internal or full-body data.')
            source = urlsplit(item.get('sourceUrl', ''))
            if source.scheme != 'https' or not source.hostname or source.username or source.password:
                raise ValueError('Public listing source URL is not a safe HTTPS link.')
        html, frontend_headers = fetch(base_url, False)
        if 'noindex' not in frontend_headers.get('x-robots-tag', '').lower() and not re.search(r'<meta[^>]+name=["\']robots["\'][^>]+content=["\'][^"\']*noindex', html, re.I):
            raise ValueError('Frontend candidate does not explicitly exclude indexing.')
        checks += ['exact_ready_runner', 'exact_import_generation', 'approved_policy_pages', 'live_capabilities',
                   'fresh_guest_public_projection', 'exact_built_frontend_identity', 'frontend_noindex']
    return {'formatVersion': 1, 'scope': mode, 'baseUrl': base_url, **expected,
            'runnerIdentity': version.get('runner', {}).get('identity'), 'importGeneration': version.get('importGeneration'),
            'frontend': frontend_identity, 'policyAssetProof': policy_asset_proof if mode == 'preview' else None,
            'checkedAt': datetime.now(timezone.utc).isoformat(), 'checks': checks, 'passed': True,
            'completeReleaseGate': False, 'browserJourneysRequired': True,
            'shareable': False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base-url', required=True)
    parser.add_argument('--manifest', type=Path, required=True)
    parser.add_argument('--mode', choices=['process', 'policies', 'preview'], required=True)
    parser.add_argument('--expected-runner-identity')
    parser.add_argument('--expected-import-generation')
    parser.add_argument('--approved-policy-version')
    parser.add_argument('--policy-asset-proof', type=Path, help='Operator-reviewed origin/source/asset digest and locale version/page hashes; required for policies and preview modes.')
    parser.add_argument('--frontend-release', type=Path, help='Retained compiled frontend release.json; required in preview mode.')
    parser.add_argument('--frontend-config', type=Path, help='Retained frontend wrangler.json with exact runtime vars; required in preview mode.')
    parser.add_argument('--report', type=Path, required=True)
    args = parser.parse_args()
    try:
        spec = importlib.util.spec_from_file_location('preview_artifact', Path(__file__).with_name('preview-artifact.py'))
        artifact = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(artifact)
        manifest = artifact.validate_manifest(json.loads(args.manifest.read_text()))
        report = verify(args.base_url, manifest, args.mode, args.expected_runner_identity,
                        args.expected_import_generation, args.approved_policy_version,
                        frontend_release=json.loads(args.frontend_release.read_text()) if args.frontend_release else None,
                        frontend_config=json.loads(args.frontend_config.read_text()) if args.frontend_config else None,
                        policy_asset_proof=json.loads(args.policy_asset_proof.read_text()) if args.policy_asset_proof else None)
        status = 0
    except (ValueError, OSError, KeyError, TypeError, UnicodeError, HTTPError, URLError):
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
