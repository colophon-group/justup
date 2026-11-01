#!/usr/bin/env python3
"""Copy bounded public Jobseek evidence for Justup; never writes to Jobseek.
Read docs/job-data.md before running this explicit operator command.
"""

import argparse
from datetime import datetime, timedelta, timezone
import hashlib
import hmac
from html.parser import HTMLParser
import ipaddress
import json
import os
from pathlib import Path
import re
import stat
import sys
import tempfile
from typing import NamedTuple
import urllib.error
import urllib.parse
import urllib.request
from uuid import UUID

BOOTSTRAP_URL = "https://jseek.co/api/typesense-key"
ASSET_ORIGIN = "https://jobseek-assets.colophon-group.org"
USER_AGENT = "Mozilla/5.0 (Justup bounded public job import)"
BODY_LIMIT = 512 * 1024
BODY_BUDGET_LIMIT = 48 * 1024 * 1024
EXPORT_LIMIT = 64 * 1024 * 1024
JSON_LIMIT = 8 * 1024 * 1024
MAX_JOBS = 1000
MAX_COMPANY_IDS = 100
COMPANY_SELECTOR_LIMIT = 16 * 1024
FEED_MANIFEST_LIMIT = 1024 * 1024
FEED_PARTS_LIMIT = 1001
FEED_ROWS_LIMIT = 100_000
FEED_PART_BYTES_LIMIT = 64 * 1024 * 1024
FEED_BYTES_LIMIT = 512 * 1024 * 1024
SOURCE_COMPANY_ID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
SOURCE_FIELDS = (
    "id", "company_id", "company_name", "company_slug", "title", "source_url",
    "is_active", "has_content", "tdm_reserved", "first_seen_at", "last_seen_at",
    "locales", "location_direct_ids", "location_names", "location_types",
    "location_geo_types", "employment_type", "seniority_id", "seniority_name",
    "salary_min", "salary_max", "salary_currency", "salary_period",
    "occupation_id", "occupation_name",
    "experience_min_years", "experience_max_years",
)
EMPLOYMENT = frozenset(("full_time", "part_time", "contract", "temporary", "volunteer", "full_or_part"))
IDENTIFIER = re.compile(r"^[A-Za-z0-9_-]{1,128}$")
LOCALE = re.compile(r"^[A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{2,8})*$")
ATS_DOMAINS = ("greenhouse.io", "lever.co", "workdayjobs.com", "myworkdayjobs.com", "smartrecruiters.com", "ashbyhq.com", "bamboohr.com", "recruitee.com", "personio.com", "personio.de", "teamtailor.com", "icims.com", "jobvite.com", "successfactors.com", "oraclecloud.com")


class ImportFailure(Exception):
    """Safe operator error without request headers, response bodies or source content."""


class BodyRead(NamedTuple):
    """Bytes and source provenance for one observed description version."""

    data: bytes
    url: str | None
    expected_sha256: str | None = None


def _unique_object(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            raise ImportFailure("Feed bundle contains duplicate fields.")
        value[key] = item
    return value


def _private_file(path, limit):
    try:
        descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
        with os.fdopen(descriptor, "rb") as handle:
            info = os.fstat(handle.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_nlink != 1 or info.st_mode & 0o077:
                raise ImportFailure("Feed bundle file is not private and regular.")
            data = handle.read(limit + 1)
    except (OSError, ValueError) as exc:
        raise ImportFailure("Feed bundle file could not be read.") from exc
    if len(data) > limit:
        raise ImportFailure("Feed bundle exceeds its size limit.")
    return data


def _feed_json(data):
    try:
        return json.loads(data.decode("utf-8"), object_pairs_hook=_unique_object)
    except (ValueError, UnicodeDecodeError, RecursionError) as exc:
        raise ImportFailure("Feed bundle contains invalid JSON.") from exc


def _feed_cursor(value):
    if not isinstance(value, dict) or set(value) != {"updatedAt", "id"}:
        raise ImportFailure("Feed cursor is invalid.")
    timestamp = utc(value["updatedAt"])
    try:
        if not isinstance(value["id"], str) or str(UUID(value["id"])) != value["id"]:
            raise ValueError
    except (ValueError, AttributeError) as exc:
        raise ImportFailure("Feed cursor is invalid.") from exc
    return timestamp, value["id"]


def _feed_scope(scope):
    if not isinstance(scope, dict):
        raise ImportFailure("Feed scope is invalid.")
    if scope == {"kind": "all_eligible"}:
        return scope
    if (set(scope) != {"kind", "requestedCount", "requestedSetSha256"} or scope["kind"] != "company_ids"
            or type(scope["requestedCount"]) is not int or not 1 <= scope["requestedCount"] <= MAX_COMPANY_IDS
            or not isinstance(scope["requestedSetSha256"], str)
            or not re.fullmatch(r"[a-f0-9]{64}", scope["requestedSetSha256"])):
        raise ImportFailure("Feed scope is invalid.")
    return scope


def read_feed_bundle(manifest_path):
    """Yield private batch rows only after checking each part's declared digest."""
    manifest_path = Path(manifest_path).expanduser()
    if (".." in manifest_path.parts or manifest_path.name != "manifest.json"
            or not re.fullmatch(r"batch-[a-f0-9]{32}", manifest_path.parent.name)):
        raise ImportFailure("Feed manifest filename is invalid.")
    directory = manifest_path.parent
    for private_dir in (directory.parent, directory):
        try:
            info = private_dir.lstat()
            if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
                raise ImportFailure("Feed bundle directory must be private and regular.")
        except OSError as exc:
            raise ImportFailure("Feed bundle directory could not be read.") from exc
    manifest_bytes = _private_file(manifest_path, FEED_MANIFEST_LIMIT)
    manifest = _feed_json(manifest_bytes)
    if (not isinstance(manifest, dict) or type(manifest.get("schemaVersion")) is not int or manifest["schemaVersion"] != 1
            or set(manifest) != {"schemaVersion", "kind", "fromCursor", "toCursor", "cutoffAt", "complete", "scope", "windowDays", "sourceScopeRowCount", "rows", "parts"}
            or manifest["kind"] not in ("snapshot", "changes") or type(manifest["complete"]) is not bool
            or type(manifest["windowDays"]) is not int or manifest["windowDays"] != 14
            or type(manifest["sourceScopeRowCount"]) is not int or manifest["sourceScopeRowCount"] < 0
            or type(manifest["rows"]) is not int or not 0 <= manifest["rows"] <= FEED_ROWS_LIMIT
            or not isinstance(manifest["parts"], list) or len(manifest["parts"]) > FEED_PARTS_LIMIT):
        raise ImportFailure("Feed bundle manifest is incomplete or unsupported.")
    cutoff = utc(manifest["cutoffAt"])
    _feed_scope(manifest["scope"])
    if manifest["fromCursor"] is None:
        if manifest["kind"] != "snapshot":
            raise ImportFailure("Feed changes require an acknowledged cursor.")
    else:
        _feed_cursor(manifest["fromCursor"])
    to_cursor = _feed_cursor(manifest["toCursor"])
    if to_cursor[0] > cutoff or (manifest["fromCursor"] is not None and _feed_cursor(manifest["fromCursor"]) > to_cursor):
        raise ImportFailure("Feed cursor exceeds the batch cutoff.")
    names, declared_rows = set(), 0
    for index, part in enumerate(manifest["parts"], start=1):
        if not isinstance(part, dict) or set(part) != {"file", "sha256", "rows"}:
            raise ImportFailure("Feed bundle part declaration is invalid.")
        name, digest, count = part["file"], part["sha256"], part["rows"]
        if (not isinstance(name, str) or name != f"part-{index:04d}.json" or name in names
                or not isinstance(digest, str) or not re.fullmatch(r"[a-f0-9]{64}", digest)
                or type(count) is not int or not 1 <= count <= 100 or declared_rows + count > FEED_ROWS_LIMIT):
            raise ImportFailure("Feed bundle part declaration is invalid.")
        names.add(name)
        declared_rows += count
    if declared_rows != manifest["rows"]:
        raise ImportFailure("Feed bundle row count differs from its manifest.")

    def rows():
        total_bytes = 0
        for part in manifest["parts"]:
            data = _private_file(directory / part["file"], min(FEED_PART_BYTES_LIMIT, FEED_BYTES_LIMIT - total_bytes))
            total_bytes += len(data)
            if not hmac.compare_digest(hashlib.sha256(data).hexdigest(), part["sha256"]):
                raise ImportFailure("Feed bundle part digest differs from its manifest.")
            content = _feed_json(data)
            if (not isinstance(content, dict) or set(content) != {"schemaVersion", "rows"}
                    or type(content["schemaVersion"]) is not int or content["schemaVersion"] != 1
                    or not isinstance(content["rows"], list) or len(content["rows"]) != part["rows"]
                    or any(not isinstance(row, dict) for row in content["rows"])):
                raise ImportFailure("Feed bundle part is invalid.")
            yield from content["rows"]

    return manifest, rows(), hashlib.sha256(manifest_bytes).hexdigest()


def utc(value):
    if not isinstance(value, str) or not value.endswith("Z"):
        raise ImportFailure("Use an explicit UTC time ending in Z.")
    try:
        result = datetime.fromisoformat(value[:-1] + "+00:00")
    except ValueError as exc:
        raise ImportFailure("Invalid UTC time.") from exc
    if result.utcoffset() != timedelta(0):
        raise ImportFailure("Invalid UTC time.")
    return result


def iso(value):
    return value.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def source_time(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not 0 < value < 10**11:
        return None
    try:
        return iso(datetime.fromtimestamp(value, timezone.utc))
    except (ValueError, OverflowError, OSError):
        return None


def text(value, limit):
    return value.strip()[:limit] if isinstance(value, str) else ""


def location_id(value):
    # Public Typesense location_direct_ids are positive int32 GeoNames IDs.
    # Preserve older opaque string IDs, but never stringify a malformed number.
    if isinstance(value, str):
        value = value.strip()
        if not value or len(value) > 128:
            return None
        if re.fullmatch(r"[+-]?\d+", value):
            value = int(value)
        elif re.match(r"[+-]?\d", value):
            return None
        else:
            return value
    return str(value) if not isinstance(value, bool) and isinstance(value, int) and 0 < value <= 2147483647 else None


def number(value):
    return value if not isinstance(value, bool) and isinstance(value, (int, float)) and 0 <= value < 10**12 else None


def safe_url(value):
    if not isinstance(value, str) or len(value) > 2048:
        return None
    try:
        parsed = urllib.parse.urlsplit(value)
        if parsed.scheme not in ("http", "https") or not parsed.hostname or parsed.username or parsed.password:
            return None
        if any(ord(char) < 33 for char in value):
            return None
        return value
    except ValueError:
        return None


def official_domain(website):
    """Use only the explicit public company.website field, never a posting URL."""
    if not safe_url(website) or len(website) > 2048:
        return None
    try:
        parsed = urllib.parse.urlsplit(website)
        host = parsed.hostname.lower().rstrip(".")
        if parsed.scheme != "https" or parsed.port not in (None, 443) or parsed.fragment or len(host) > 253:
            return None
    except (ValueError, AttributeError):
        return None
    try:
        ipaddress.ip_address(host)
        return None
    except ValueError:
        pass
    if "." not in host or not re.fullmatch(r"[a-z0-9.-]+", host) or any(not re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", label) for label in host.split(".")):
        return None
    if re.search(r"(?:^|\.)(?:localhost|local|internal|home|lan|invalid|test)$", host) or re.search(r"(?:^|\.)localhost\.", host):
        return None
    if any(host == ats or host.endswith("." + ats) for ats in ATS_DOMAINS):
        return None
    return host


def company_identities(client, jobs):
    """At most four exact-ID public reads; missing evidence stays unbound."""
    identities = []
    ids = sorted({job["companyId"] for job in jobs})
    for start in range(0, len(ids), 250):
        batch = ids[start:start + 250]
        try:
            rows = documents(client.search({"collection": "company", "q": "*", "query_by": "name",
                "filter_by": "id:=[" + ",".join("`" + value + "`" for value in batch) + "]",
                "include_fields": "id,website", "per_page": len(batch)}), len(batch))
        except ImportFailure:
            continue
        # Conflicting duplicate source identities cannot authorize an alias.
        seen, ambiguous = {}, set()
        for row in rows:
            identifier = row.get("id")
            if not isinstance(identifier, str) or identifier not in batch:
                continue
            if identifier in seen:
                ambiguous.add(identifier)
            seen[identifier] = official_domain(row.get("website"))
        identities.extend({"companyId": identifier, "officialDomain": domain} for identifier, domain in sorted(seen.items()) if domain and identifier not in ambiguous)
    return identities


class VisibleText(HTMLParser):
    SKIP = frozenset(("script", "style", "noscript", "template", "svg", "head", "iframe"))
    BLOCK = frozenset(("p", "div", "section", "article", "header", "footer", "li", "ul", "ol", "br", "h1", "h2", "h3", "h4", "h5", "h6", "table", "tr", "td"))
    VOID = frozenset(("area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"))

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts = []
        self.stack = []

    def handle_starttag(self, tag, attrs):
        if len(self.stack) >= 1024:
            raise ImportFailure("body_invalid_html")
        attrs = dict(attrs)
        style = re.sub(r"\s+", "", attrs.get("style") or "").lower()
        hidden = bool(self.stack and self.stack[-1][1]) or tag in self.SKIP or "hidden" in attrs or (attrs.get("aria-hidden") or "").lower() == "true" or "display:none" in style or "visibility:hidden" in style
        if not hidden and tag in self.BLOCK:
            self.parts.append("\n")
        if tag not in self.VOID:
            self.stack.append((tag, hidden))

    def handle_endtag(self, tag):
        hidden = bool(self.stack and self.stack[-1][1])
        for index in range(len(self.stack) - 1, -1, -1):
            if self.stack[index][0] == tag:
                del self.stack[index:]
                break
        if not hidden and tag in self.BLOCK:
            self.parts.append("\n")

    def handle_data(self, data):
        if not self.stack or not self.stack[-1][1]:
            self.parts.append(data)

    def normalized(self):
        value = "".join(self.parts)
        value = "".join(char for char in value if ord(char) >= 32 or char in "\n\t")
        lines = [re.sub(r"\s+", " ", line).strip() for line in value.splitlines()]
        return "\n".join(line for line in lines if line)


def normalize_html(body):
    if len(body) > BODY_LIMIT:
        raise ImportFailure("body_too_large")
    try:
        html = body.decode("utf-8", errors="strict")
    except UnicodeDecodeError as exc:
        raise ImportFailure("body_invalid_utf8") from exc
    parser = VisibleText()
    parser.feed(html)
    parser.close()
    return parser.normalized()


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ImportFailure("Public source redirect refused.")


class PublicClient:
    """HTTPS allowlisted requests only; the public scoped key never enters exports."""

    def __init__(self, approved_host):
        approved_host = approved_host.lower().rstrip(".")
        if not re.fullmatch(r"[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?", approved_host) or "." not in approved_host:
            raise ImportFailure("An approved public Typesense hostname is required.")
        try:
            ipaddress.ip_address(approved_host)
        except ValueError:
            pass
        else:
            raise ImportFailure("Typesense must use an approved hostname, not an IP address.")
        self.host = approved_host
        self.opener = urllib.request.build_opener(NoRedirect())
        self.key = None

    def fetch(self, url, *, data=None, headers=None, limit=JSON_LIMIT):
        parsed = urllib.parse.urlsplit(url)
        allowed = {"jseek.co", self.host, "jobseek-assets.colophon-group.org"}
        if parsed.scheme != "https" or parsed.hostname not in allowed or parsed.port not in (None, 443) or parsed.username or parsed.password:
            raise ImportFailure("Public source URL refused.")
        request_headers = {"User-Agent": USER_AGENT, **(headers or {})}
        request = urllib.request.Request(url, data=data, headers=request_headers)
        try:
            with self.opener.open(request, timeout=20) as response:
                body = response.read(limit + 1)
        except ImportFailure:
            raise
        except (OSError, urllib.error.URLError, ValueError) as exc:
            raise ImportFailure("Public source request failed.") from exc
        if len(body) > limit:
            raise ImportFailure("body_too_large" if limit == BODY_LIMIT else "Public source response exceeded its limit.")
        return body

    def json(self, url, **kwargs):
        try:
            return json.loads(self.fetch(url, **kwargs).decode("utf-8"))
        except (ValueError, UnicodeDecodeError) as exc:
            raise ImportFailure("Public source returned invalid JSON.") from exc

    def search(self, search):
        if self.key is None:
            bootstrap = self.json(BOOTSTRAP_URL)
            if not isinstance(bootstrap, dict) or not isinstance(bootstrap.get("host"), str) or bootstrap["host"].lower().rstrip(".") != self.host or bootstrap.get("protocol") != "https" or str(bootstrap.get("port")) != "443":
                raise ImportFailure("Public Typesense target does not match the approved HTTPS host.")
            key = bootstrap.get("apiKey")
            if not isinstance(key, str) or not 1 <= len(key) <= 4096:
                raise ImportFailure("Public Typesense key is unavailable.")
            self.key = key
        result = self.json(
            f"https://{self.host}/multi_search",
            data=json.dumps({"searches": [search]}, separators=(",", ":")).encode(),
            headers={"Content-Type": "application/json", "X-TYPESENSE-API-KEY": self.key},
        )
        if not isinstance(result, dict) or not isinstance(result.get("results"), list) or len(result["results"]) != 1:
            raise ImportFailure("Public search response is invalid.")
        item = result["results"][0]
        if not isinstance(item, dict) or "error" in item:
            raise ImportFailure("Public search is unavailable.")
        return item

    def body(self, posting_id, locale):
        url = f"{ASSET_ORIGIN}/job/{posting_id}/{locale}/latest.html"
        return BodyRead(self.fetch(url, limit=BODY_LIMIT), url)


def documents(result, limit):
    hits = result.get("hits")
    if hits is None:
        groups = result.get("grouped_hits", [])
        if not isinstance(groups, list):
            raise ImportFailure("Public search groups are invalid.")
        if any(not isinstance(group, dict) or not isinstance(group.get("hits"), list) for group in groups):
            raise ImportFailure("Public search groups are invalid.")
        hits = [hit for group in groups for hit in group["hits"]]
    if not isinstance(hits, list) or len(hits) > limit:
        raise ImportFailure("Public search exceeded the requested document bound.")
    return [hit["document"] for hit in hits if isinstance(hit, dict) and isinstance(hit.get("document"), dict)]


def selected_company_ids(values):
    if not isinstance(values, list) or not 1 <= len(values) <= MAX_COMPANY_IDS:
        raise ImportFailure("Company selector requires 1 to 100 unique canonical source UUIDs.")
    if any(not isinstance(value, str) or not SOURCE_COMPANY_ID.fullmatch(value) for value in values) or len(set(values)) != len(values):
        raise ImportFailure("Company selector requires 1 to 100 unique canonical source UUIDs.")
    return sorted(values)


def read_company_ids(path):
    """Read the bounded private operator selector without accepting filter syntax."""
    def unique_object(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ImportFailure("Company selector contains duplicate keys.")
            result[key] = value
        return result

    try:
        with Path(path).open("rb") as handle:
            data = handle.read(COMPANY_SELECTOR_LIMIT + 1)
        if len(data) > COMPANY_SELECTOR_LIMIT:
            raise ImportFailure("Company selector exceeds the 16 KiB file limit.")
        selector = json.loads(data.decode("utf-8"), object_pairs_hook=unique_object)
    except (OSError, ValueError, RecursionError) as exc:
        raise ImportFailure("Company selector could not be read as UTF-8 JSON.") from exc
    if not isinstance(selector, dict) or set(selector) != {"schemaVersion", "companyIds"} or type(selector["schemaVersion"]) is not int or selector["schemaVersion"] != 1:
        raise ImportFailure("Company selector must contain only schemaVersion 1 and companyIds.")
    return selected_company_ids(selector["companyIds"])


def normalize_job(raw, fetched_at, client, clock=None, body_budget=None):
    # Read exactly this allowlist. New public source fields cannot silently enter Justup.
    raw = {key: raw[key] for key in SOURCE_FIELDS if key in raw}
    posting_id = raw.get("id")
    company_id = raw.get("company_id")
    if not isinstance(posting_id, str) or not IDENTIFIER.fullmatch(posting_id) or not isinstance(company_id, str) or not IDENTIFIER.fullmatch(company_id):
        return None
    first_observed = source_time(raw.get("first_seen_at"))
    title, company_name = text(raw.get("title"), 500), text(raw.get("company_name"), 256)
    source_url = safe_url(raw.get("source_url"))
    if not first_observed or not title or not company_name or not source_url or raw.get("is_active") is not True or raw.get("has_content") is not True or raw.get("tdm_reserved") is not False:
        return None
    locales = [value for value in raw.get("locales", []) if isinstance(value, str) and LOCALE.fullmatch(value)] if isinstance(raw.get("locales"), list) else []
    locales = list(dict.fromkeys(locales))[:20]
    arrays = {name: raw.get(name) if isinstance(raw.get(name), list) else [] for name in ("location_direct_ids", "location_names", "location_types", "location_geo_types")}
    locations = []
    for position in range(min(64, max(map(len, arrays.values()), default=0))):
        def at(name):
            return arrays[name][position] if position < len(arrays[name]) else None
        name = text(at("location_names"), 200) or None
        identifier = location_id(at("location_direct_ids"))
        workplace = at("location_types") if at("location_types") in ("onsite", "remote", "hybrid") else "unknown"
        geo_type = text(at("location_geo_types"), 40) or None
        if name or identifier:
            locations.append({"id": identifier, "name": name, "workplace": workplace, "geoType": geo_type})
    employment_raw = raw.get("employment_type", [])
    if isinstance(employment_raw, str):
        employment_raw = [employment_raw]
    employment = list(dict.fromkeys(value for value in employment_raw if isinstance(value, str) and value in EMPLOYMENT)) if isinstance(employment_raw, list) else []
    seniority_name = text(raw.get("seniority_name"), 100)
    seniority_id = text(raw.get("seniority_id"), 100)
    occupation_id = raw.get("occupation_id")
    occupation_name = text(raw.get("occupation_name"), 200)
    occupation = {"id": str(occupation_id), "name": occupation_name} if type(occupation_id) is int and 0 < occupation_id <= 2147483647 and occupation_name and not re.search(r"[\x00-\x1f\x7f]", occupation_name) else None
    salary_min, salary_max = number(raw.get("salary_min")), number(raw.get("salary_max"))
    currency, period = text(raw.get("salary_currency"), 10), text(raw.get("salary_period"), 30)
    salary = {"min": salary_min, "max": salary_max, "currency": currency or None, "period": period or None} if salary_min is not None or salary_max is not None else None
    experience_min, experience_max = number(raw.get("experience_min_years")), number(raw.get("experience_max_years"))
    experience_min = experience_min if experience_min is not None and experience_min <= 99 else None
    experience_max = experience_max if experience_max is not None and experience_max <= 99 else None
    open_ended = experience_max == 99
    evidence = {
        "source": "jobseek_public", "metadataFetchedAt": fetched_at, "bodyFetchedAt": None,
        "bodyUrl": None, "bodySha256": None, "textSha256": None, "normalizationVersion": 1,
        "bodyBytes": 0, "truncated": False, "aiEligible": False, "bodyError": None,
    }
    locale = locales[0] if locales else "en"
    body_text = None
    try:
        if body_budget is not None and body_budget["remaining"] <= 0:
            raise ImportFailure("body_budget_exceeded")
        observed = client.body(posting_id, locale)
        if not isinstance(observed, BodyRead) or not isinstance(observed.data, bytes):
            raise ImportFailure("body_invalid_source")
        body_url = observed.url
        if body_url is not None and (safe_url(body_url) != body_url or not body_url.startswith("https://")):
            raise ImportFailure("body_invalid_source")
        expected_hash = observed.expected_sha256
        if expected_hash is not None and (not isinstance(expected_hash, str) or not re.fullmatch(r"[a-f0-9]{64}", expected_hash)):
            raise ImportFailure("body_invalid_source")
        body = observed.data
        if len(body) > BODY_LIMIT:
            raise ImportFailure("body_too_large")
        actual_hash = hashlib.sha256(body).hexdigest()
        if expected_hash is not None and not hmac.compare_digest(actual_hash, expected_hash):
            raise ImportFailure("body_hash_mismatch")
        evidence.update(bodyFetchedAt=iso(clock()) if clock else fetched_at, bodyUrl=body_url, bodyBytes=len(body), bodySha256=actual_hash)
        body_text = normalize_html(body) or None
        if body_text and body_budget is not None:
            size = len(body_text.encode("utf-8"))
            if size > body_budget["remaining"]:
                body_text = None
                raise ImportFailure("body_budget_exceeded")
            body_budget["remaining"] -= size
        evidence.update(textSha256=hashlib.sha256(body_text.encode()).hexdigest() if body_text else None, aiEligible=bool(body_text and len(body_text) >= 200))
    except ImportFailure as exc:
        code = str(exc) if str(exc) in ("body_too_large", "body_invalid_utf8", "body_invalid_html", "body_budget_exceeded", "body_hash_mismatch", "body_invalid_source") else "body_unavailable"
        evidence.update(bodyError=code, truncated=code == "body_too_large")
    return {
        "id": posting_id, "companyId": company_id, "companyName": company_name,
        "companySlug": text(raw.get("company_slug"), 200) or None, "title": title,
        "sourceUrl": source_url, "active": True, "firstObserved": first_observed,
        "lastObserved": source_time(raw.get("last_seen_at")), "locales": locales,
        "locations": locations, "employmentTypes": employment,
        "seniority": {"id": seniority_id or None, "name": seniority_name or None} if seniority_id or seniority_name else None,
        "salary": salary, "occupation": occupation, "experience": {"min": experience_min, "max": None if open_ended else experience_max, "openEnded": open_ended},
        "reserved": False, "hasContent": True, "bodyText": body_text, "evidence": evidence,
    }


def import_snapshot(client, snapshot_at, *, max_jobs=500, previous=None, company_ids=None, now=None):
    if not isinstance(max_jobs, int) or not 1 <= max_jobs <= MAX_JOBS:
        raise ImportFailure("The import limit must be between 1 and 1000.")
    snapshot = utc(snapshot_at)
    clock = now if callable(now) else (lambda: now) if now is not None else (lambda: datetime.now(timezone.utc))
    observed = clock()
    if snapshot > observed + timedelta(minutes=1):
        raise ImportFailure("Snapshot time cannot be in the future.")
    cutoff = snapshot - timedelta(days=14)
    base_filter = f"is_active:=true && has_content:=true && tdm_reserved:!=true && first_seen_at:>={int(cutoff.timestamp())} && first_seen_at:<={int(snapshot.timestamp())}"
    company_scope = None if company_ids is None else frozenset(selected_company_ids(company_ids))
    if company_scope is not None:
        base_filter += " && company_id:=[" + ",".join("`" + value + "`" for value in sorted(company_scope)) + "]"
    selected, seen, returned, query_count = {}, set(), 0, 0
    body_budget = {"remaining": BODY_BUDGET_LIMIT}
    common = {"collection": "job_posting", "q": "*", "query_by": "title", "include_fields": ",".join(SOURCE_FIELDS), "sort_by": "first_seen_at:desc"}

    def collect(extra_filter="", *, grouped=False, page=1, requested=250, query="*"):
        nonlocal returned, query_count
        limit = min(250, requested, MAX_JOBS - returned)
        if limit <= 0 or len(selected) >= max_jobs:
            return 0
        search = {**common, "q": query, "filter_by": base_filter + (" && " + extra_filter if extra_filter else ""), "per_page": limit, "page": page}
        if grouped:
            search.update(group_by="company_id", group_limit=1)
        rows = documents(client.search(search), limit)
        fetched_at = iso(clock())
        returned += len(rows)
        query_count += 1
        for raw in rows:
            if company_scope is not None and (not isinstance(raw.get("company_id"), str) or raw["company_id"] not in company_scope):
                continue
            identifier = raw.get("id")
            if not isinstance(identifier, str) or identifier in seen:
                continue
            seen.add(identifier)
            first = source_time(raw.get("first_seen_at"))
            if not first or not cutoff <= utc(first) <= snapshot:
                continue
            job = normalize_job(raw, fetched_at, client, clock, body_budget)
            if job:
                selected[job["id"]] = job
                if len(selected) == max_jobs:
                    break
        return len(rows)

    # Reserve slots before newest-first fill: plentiful companies must not consume
    # the age windows or the explicit diversity requests. Tiny samples prefer guests.
    guest_boundary = int((snapshot - timedelta(hours=48)).timestamp())
    guest_budget = max(1, max_jobs // 4)
    recent_budget = min(max_jobs - guest_budget, max(1, max_jobs // 4)) if max_jobs > 1 else 0
    company_budget = max_jobs // 8
    diversity_budget = max_jobs // 4
    collect(f"first_seen_at:<={guest_boundary}", requested=guest_budget)
    collect(f"first_seen_at:>{guest_boundary}", requested=recent_budget)
    collect(grouped=True, requested=company_budget)
    strata = (
        ("location_types:=remote", "*"), ("location_types:=hybrid", "*"),
        ("locales:=de", "*"), ("locales:=fr", "*"),
        ("", "engineer"), ("", "sales"), ("", "care"),
    )
    for index, (extra_filter, query) in enumerate(strata):
        quota = diversity_budget // len(strata) + (index < diversity_budget % len(strata))
        collect(extra_filter, query=query, requested=quota)
    for page in range(1, 5):
        if returned >= MAX_JOBS or len(selected) >= max_jobs or collect(page=page, requested=min(250, max_jobs - len(selected))) == 0:
            break

    observations, unknown = [], set()
    previous_jobs = previous.get("jobs", []) if isinstance(previous, dict) else []
    known = []
    for job in previous_jobs:
        identifier = job.get("id") if isinstance(job, dict) else None
        if isinstance(identifier, str) and IDENTIFIER.fullmatch(identifier) and identifier not in known:
            known.append(identifier)
    if len(known) > MAX_JOBS:
        raise ImportFailure("Previous snapshot exceeds the 1000 known-ID refresh bound.")
    # Refresh known IDs independently. Freshness and active filters must not hide a closure.
    for start in range(0, len(known), 250):
        batch = known[start:start + 250]
        search = {**common, "filter_by": "id:=[" + ",".join("`" + identifier + "`" for identifier in batch) + "]", "per_page": 250}
        try:
            rows = documents(client.search(search), 250)
            fetched_at = iso(clock())
        except ImportFailure:
            unknown.update(batch)
            continue
        refreshed = set()
        for raw in rows:
            identifier = raw.get("id")
            if identifier not in batch or identifier in refreshed:
                continue
            refreshed.add(identifier)
            if raw.get("is_active") is False or raw.get("tdm_reserved") is True:
                observations.append({"id": identifier, "active": raw.get("is_active") is not False, "reserved": raw.get("tdm_reserved") is True, "observedAt": fetched_at})
                selected.pop(identifier, None)
            elif raw.get("is_active") is True:
                if company_scope is not None and (not isinstance(raw.get("company_id"), str) or raw["company_id"] not in company_scope):
                    # Keep checking prior IDs for closures, but never renew active
                    # evidence outside the operator's current company selection.
                    selected.pop(identifier, None)
                    if not isinstance(raw.get("company_id"), str):
                        unknown.add(identifier)
                    continue
                first = source_time(raw.get("first_seen_at"))
                if first and utc(first) < cutoff:
                    selected.pop(identifier, None)
                    continue
                if not first or utc(first) > snapshot:
                    selected.pop(identifier, None)
                    unknown.add(identifier)
                    continue
                job = normalize_job(raw, fetched_at, client, clock, body_budget)
                if job:
                    # Refresh must not displace the reserved initial age/diversity sample.
                    if identifier in selected or len(selected) < max_jobs:
                        selected[identifier] = job
                else:
                    selected.pop(identifier, None)
                    unknown.add(identifier)
            else:
                selected.pop(identifier, None)
                unknown.add(identifier)
        unknown.update(set(batch) - refreshed)
    # Keep the initial selection ceiling even when refreshing a previous snapshot.
    jobs = sorted(selected.values(), key=lambda item: (-utc(item["firstObserved"]).timestamp(), item["id"]))[:max_jobs]
    identities = company_identities(client, jobs)
    result = {
        "schemaVersion": 1, "snapshotAt": iso(snapshot), "verifiedAt": iso(clock()),
        "selection": {"source": "jobseek_public", "cutoffAt": iso(cutoff), "rule": "reserved_age_windows_companies_diversity_then_newest", "samplingBudgets": {"guest48HoursTo14Days": guest_budget, "recentUnder48Hours": recent_budget, "companyRepresentatives": company_budget, "diversity": diversity_budget}, "limit": max_jobs, "initialReturnedDocuments": returned, "initialQueries": query_count, "knownIdsRefreshed": len(known), "bodyTextBudgetBytes": BODY_BUDGET_LIMIT, "bodyTextRetainedBytes": sum(len(job["bodyText"].encode("utf-8")) for job in jobs if job["bodyText"]), "selectedJobs": len(jobs), "selectedCompanies": len({job["companyId"] for job in jobs})},
        "jobs": jobs, "observations": observations, "unknownIds": sorted(unknown), "companyIdentities": identities,
    }
    if company_scope is not None:
        result["selection"]["companySelection"] = {
            "schemaVersion": 1, "requestedCount": len(company_scope),
            "requestedSetSha256": hashlib.sha256(json.dumps(sorted(company_scope), separators=(",", ":")).encode("utf-8")).hexdigest(),
            "missingCount": len(company_scope - {job["companyId"] for job in jobs}),
        }
    return result


FEED_ROW_FIELDS = frozenset((
    "id", "companyId", "companyName", "companySlug", "companyWebsite", "title", "sourceUrl", "active", "reserved",
    "hasContent", "firstSeenAt", "lastSeenAt", "updatedAt", "locales", "locationDirectIds",
    "locationNames", "locationTypes", "locationGeoTypes", "employmentType", "salaryMin", "salaryMax",
    "salaryCurrency", "salaryPeriod", "experienceMin", "experienceMax", "occupationId",
    "occupationName", "seniorityId", "seniorityName", "body", "bodyStatus",
))


def _feed_row(row, cutoff):
    if not isinstance(row, dict) or set(row) != FEED_ROW_FIELDS:
        raise ImportFailure("Feed posting fields differ from schema 1.")
    for name in ("id", "companyId"):
        try:
            if not isinstance(row[name], str) or str(UUID(row[name])) != row[name]:
                raise ValueError
        except (ValueError, AttributeError) as exc:
            raise ImportFailure("Feed posting identity is invalid.") from exc
    for name in ("active", "reserved", "hasContent"):
        if type(row[name]) is not bool:
            raise ImportFailure("Feed posting state is invalid.")
    first, updated = utc(row["firstSeenAt"]), utc(row["updatedAt"])
    if updated >= cutoff or (row["lastSeenAt"] is not None and utc(row["lastSeenAt"]) > cutoff):
        raise ImportFailure("Feed posting exceeds its batch cutoff.")
    if not isinstance(row["companyName"], str) or not isinstance(row["sourceUrl"], str):
        raise ImportFailure("Feed posting public identity is invalid.")
    if (row["companySlug"] is not None and not isinstance(row["companySlug"], str)) or (row["companyWebsite"] is not None and not isinstance(row["companyWebsite"], str)):
        raise ImportFailure("Feed posting public identity is invalid.")
    if row["title"] is not None and not isinstance(row["title"], str):
        raise ImportFailure("Feed posting title is invalid.")
    if not isinstance(row["locales"], list) or len(row["locales"]) > 20 or any(not isinstance(value, str) for value in row["locales"]):
        raise ImportFailure("Feed posting locales are invalid.")
    arrays = [row[name] for name in ("locationDirectIds", "locationNames", "locationTypes", "locationGeoTypes")]
    if any(not isinstance(value, list) or len(value) > 64 for value in arrays) or len({len(value) for value in arrays}) != 1:
        raise ImportFailure("Feed posting locations are invalid.")
    status, body = row["bodyStatus"], row["body"]
    if status not in ("ready", "missing", "too_large", "hash_mismatch") or (body is None) != (status != "ready"):
        raise ImportFailure("Feed posting body state is invalid.")
    if body is not None:
        if not isinstance(body, dict) or set(body) != {"locale", "html", "sha256"}:
            raise ImportFailure("Feed posting body is invalid.")
        try:
            body_bytes = len(body["html"].encode("utf-8")) if isinstance(body["html"], str) else BODY_LIMIT + 1
        except UnicodeEncodeError as exc:
            raise ImportFailure("Feed posting body is invalid.") from exc
        if (not isinstance(body["locale"], str) or body["locale"] not in row["locales"]
                or body_bytes > BODY_LIMIT or not isinstance(body["sha256"], str)
                or not re.fullmatch(r"[a-f0-9]{64}", body["sha256"])):
            raise ImportFailure("Feed posting body is invalid.")
    return first, updated


def _feed_raw(row):
    locales = [value for value in row["locales"] if LOCALE.fullmatch(value)]
    if row["body"] and row["body"]["locale"] in locales:
        locales = [row["body"]["locale"], *[value for value in locales if value != row["body"]["locale"]]]
    return {
        "id": row["id"], "company_id": row["companyId"], "company_name": row["companyName"],
        "company_slug": row["companySlug"], "title": row["title"], "source_url": row["sourceUrl"],
        "is_active": row["active"], "tdm_reserved": row["reserved"], "has_content": row["hasContent"],
        "first_seen_at": utc(row["firstSeenAt"]).timestamp(),
        "last_seen_at": utc(row["lastSeenAt"]).timestamp() if row["lastSeenAt"] else None,
        "locales": locales, "location_direct_ids": row["locationDirectIds"],
        "location_names": row["locationNames"], "location_types": row["locationTypes"],
        "location_geo_types": row["locationGeoTypes"], "employment_type": row["employmentType"],
        "salary_min": row["salaryMin"], "salary_max": row["salaryMax"], "salary_currency": row["salaryCurrency"],
        "salary_period": row["salaryPeriod"], "experience_min_years": row["experienceMin"],
        "experience_max_years": row["experienceMax"], "occupation_id": row["occupationId"],
        "occupation_name": row["occupationName"], "seniority_id": str(row["seniorityId"]) if row["seniorityId"] is not None else None,
        "seniority_name": row["seniorityName"],
    }


class _FeedBody:
    def __init__(self, row):
        self.row = row

    def body(self, identifier, locale):
        body, status = self.row["body"], self.row["bodyStatus"]
        if identifier != self.row["id"] or status == "missing":
            raise ImportFailure("body_unavailable")
        if status == "too_large":
            raise ImportFailure("body_too_large")
        if status == "hash_mismatch":
            raise ImportFailure("body_hash_mismatch")
        if body is None or locale != body["locale"]:
            raise ImportFailure("body_unavailable")
        return BodyRead(body["html"].encode("utf-8"), None, body["sha256"])


def _feed_selection(rows, cutoff, max_jobs):
    """Reserve guest, recent and company breadth before newest-first fill."""
    descriptors = sorted(rows, key=lambda item: (-item[1].timestamp(), item[0]["id"]))
    chosen, seen = [], set()

    def take(items, limit):
        for row, first in items:
            if len(chosen) >= max_jobs or limit <= 0:
                break
            if row["id"] not in seen:
                chosen.append(row["id"])
                seen.add(row["id"])
                limit -= 1

    guest = max(1, max_jobs // 4)
    recent = min(max_jobs - guest, max(1, max_jobs // 4)) if max_jobs > 1 else 0
    boundary = cutoff - timedelta(hours=48)
    take((item for item in descriptors if item[1] <= boundary), guest)
    take((item for item in descriptors if item[1] > boundary), recent)
    company_reps, companies = [], set()
    for item in descriptors:
        company = item[0]["companyId"]
        if company not in companies:
            companies.add(company)
            company_reps.append(item)
    take(company_reps, max_jobs // 8)
    strata = (
        lambda row: "remote" in row["locationTypes"], lambda row: "hybrid" in row["locationTypes"],
        lambda row: "de" in row["locales"], lambda row: "fr" in row["locales"],
        lambda row: "engineer" in (row["title"] or "").lower(),
        lambda row: "sales" in (row["title"] or "").lower(),
        lambda row: "care" in (row["title"] or "").lower(),
    )
    budget = max_jobs // 4
    for index, predicate in enumerate(strata):
        take((item for item in descriptors if predicate(item[0])), budget // len(strata) + (index < budget % len(strata)))
    take(descriptors, max_jobs)
    return set(chosen)


def import_feed_bundle(manifest_path, *, previous=None, max_jobs=500, now=None):
    if type(max_jobs) is not int or not 1 <= max_jobs <= MAX_JOBS:
        raise ImportFailure("The import limit must be between 1 and 1000.")
    manifest, rows, manifest_sha256 = read_feed_bundle(manifest_path)
    cutoff = utc(manifest["cutoffAt"])
    observed = now() if callable(now) else now if now is not None else datetime.now(timezone.utc)
    if cutoff > observed or observed - cutoff >= timedelta(hours=24):
        raise ImportFailure("Feed cutoff must be within the 24-hour verification window.")
    prior = previous.get("candidate") if isinstance(previous, dict) and previous.get("stageVersion") == 1 else previous
    if prior is not None and (not isinstance(prior, dict) or prior.get("schemaVersion") != 1
                              or not isinstance(prior.get("jobs"), list) or len(prior["jobs"]) > MAX_JOBS
                              or not isinstance(prior.get("observations"), list) or len(prior["observations"]) > MAX_JOBS
                              or not isinstance(prior.get("unknownIds"), list) or len(prior["unknownIds"]) > MAX_JOBS
                              or not isinstance(prior.get("companyIdentities"), list) or len(prior["companyIdentities"]) > MAX_JOBS
                              or any(not isinstance(item, dict) or not isinstance(item.get("id"), str) for item in prior["jobs"] + prior["observations"])):
        raise ImportFailure("Previous feed import is invalid.")
    prior_feed = prior.get("selection", {}).get("feed") if isinstance(prior, dict) else None
    if manifest["kind"] == "changes":
        if (not isinstance(prior_feed, dict) or prior_feed.get("cursor") != manifest["fromCursor"]
                or prior_feed.get("scope") != manifest["scope"] or prior_feed.get("limit") != max_jobs
                or type(prior_feed.get("complete")) is not bool
                or any(item.get("bodyText") is not None and not isinstance(item["bodyText"], str) for item in prior["jobs"])):
            raise ImportFailure("Feed changes do not follow the previous import cursor, scope and limit.")
        full_at = utc(prior_feed.get("fullSnapshotAt"))
        if observed - full_at >= timedelta(hours=24):
            raise ImportFailure("A full source snapshot is needed before refreshing listings.")
    else:
        full_at = cutoff
        if prior_feed and manifest["scope"] != prior_feed.get("scope"):
            raise ImportFailure("Feed scope changed; use a separately reviewed reconciliation.")
    since = _feed_cursor(manifest["fromCursor"]) if manifest["fromCursor"] else None
    last = since
    descriptions, row_count, seen_ids = [], 0, set()
    for row in rows:
        first, updated = _feed_row(row, cutoff)
        if row["id"] in seen_ids:
            raise ImportFailure("Feed batch repeats a posting identity.")
        seen_ids.add(row["id"])
        position = (updated, row["id"])
        if last is not None and position <= last:
            raise ImportFailure("Feed rows are not strictly ordered after the cursor.")
        last = position
        row_count += 1
        if row["active"] and not row["reserved"] and row["hasContent"] and cutoff - timedelta(days=14) <= first <= cutoff:
            descriptions.append(({
                "id": row["id"], "companyId": row["companyId"], "title": row["title"],
                "locationTypes": row["locationTypes"], "locales": row["locales"],
            }, first))
    if row_count != manifest["rows"]:
        raise ImportFailure("Feed row count changed during import.")
    end = _feed_cursor(manifest["toCursor"])
    if manifest["complete"] and end != (cutoff, "00000000-0000-0000-0000-000000000000"):
        raise ImportFailure("Complete feed batch did not reach its cutoff.")
    if not manifest["complete"] and (row_count == 0 or last is None or last != end):
        raise ImportFailure("Partial feed batch cursor differs from its final row.")
    selected = _feed_selection(descriptions, cutoff, max_jobs) if manifest["kind"] == "snapshot" else {item[0]["id"] for item in descriptions}
    jobs = {} if manifest["kind"] == "snapshot" else {
        item["id"]: item for item in prior.get("jobs", [])
        if cutoff - timedelta(days=14) <= utc(item["firstObserved"]) <= cutoff
    }
    identities = {} if manifest["kind"] == "snapshot" else {item["companyId"]: item["officialDomain"] for item in prior.get("companyIdentities", [])}
    carrying_partial = manifest["kind"] == "changes" and prior_feed["complete"] is False
    observations = {item["id"]: item for item in prior.get("observations", [])} if carrying_partial else {}
    unknown = set(prior.get("unknownIds", [])) if carrying_partial else set()
    next_manifest, replay, next_sha256 = read_feed_bundle(manifest_path)
    if next_manifest != manifest or next_sha256 != manifest_sha256:
        raise ImportFailure("Feed manifest changed during import.")
    retained_body_bytes = sum(len(item["bodyText"].encode("utf-8")) for item in jobs.values() if item.get("bodyText"))
    if retained_body_bytes > BODY_BUDGET_LIMIT:
        raise ImportFailure("Previous feed body budget is invalid.")
    body_budget = {"remaining": BODY_BUDGET_LIMIT - retained_body_bytes}

    def remove_job(identifier):
        old = jobs.pop(identifier, None)
        if old and old.get("bodyText"):
            body_budget["remaining"] += len(old["bodyText"].encode("utf-8"))

    for row in replay:
        identifier = row["id"]
        if not row["active"] or row["reserved"]:
            remove_job(identifier)
            observations[identifier] = {"id": identifier, "active": row["active"], "reserved": row["reserved"], "observedAt": manifest["cutoffAt"]}
            unknown.discard(identifier)
        elif identifier in selected:
            observations.pop(identifier, None)
            remove_job(identifier)
            job = normalize_job(_feed_raw(row), manifest["cutoffAt"], _FeedBody(row), lambda: cutoff, body_budget)
            if job is None:
                unknown.add(identifier)
            else:
                jobs[identifier] = job
                unknown.discard(identifier)
                domain = official_domain(row["companyWebsite"])
                if domain:
                    existing = identities.get(row["companyId"])
                    if existing is not None and existing != domain:
                        raise ImportFailure("Source company website changed; review its identity before import.")
                    identities[row["companyId"]] = domain
        elif manifest["kind"] == "changes":
            remove_job(identifier)
            unknown.add(identifier)
    if manifest["kind"] == "changes":
        # Retained records keep their original per-record verification times.
        eligible = [(item, utc(item["firstObserved"])) for item in jobs.values() if cutoff - timedelta(days=14) <= utc(item["firstObserved"]) <= cutoff]
        keep = _feed_selection([({"id": item["id"], "companyId": item["companyId"], "title": item["title"],
                                 "locationTypes": [location["workplace"] for location in item["locations"]], "locales": item["locales"]}, first)
                                for item, first in eligible], cutoff, max_jobs)
        jobs = {identifier: item for identifier, item in jobs.items() if identifier in keep}
    if len(jobs) > max_jobs or len(observations) > MAX_JOBS or len(unknown) > MAX_JOBS:
        raise ImportFailure("Feed batch exceeds the application import bound; keep it for recovery.")
    active_companies = {job["companyId"] for job in jobs.values()}
    result = {
        "schemaVersion": 1, "snapshotAt": manifest["cutoffAt"], "verifiedAt": manifest["cutoffAt"],
        "selection": {"source": "jobseek_feed_v1", "limit": max_jobs, "sourceScopeRowCount": manifest["sourceScopeRowCount"],
                      "limitedCoverage": manifest["scope"]["kind"] != "all_eligible" or len(jobs) < manifest["sourceScopeRowCount"] or not manifest["complete"],
                      "feed": {"cursor": manifest["toCursor"], "scope": manifest["scope"], "limit": max_jobs,
                               "fullSnapshotAt": iso(full_at), "complete": manifest["complete"], "manifestSha256": manifest_sha256}},
        "jobs": sorted(jobs.values(), key=lambda item: (-utc(item["firstObserved"]).timestamp(), item["id"])),
        "observations": list(observations.values()), "unknownIds": sorted(unknown),
        "companyIdentities": [{"companyId": identifier, "officialDomain": domain} for identifier, domain in sorted(identities.items()) if identifier in active_companies],
    }
    return result if manifest["complete"] else {"stageVersion": 1, "candidate": result}


def export_snapshot(snapshot, output, *, checkout=None):
    checkout = (checkout or Path(__file__).resolve().parents[1]).resolve()
    output = Path(output).expanduser().resolve()
    if output == checkout or checkout in output.parents:
        raise ImportFailure("Write public posting exports outside the Git checkout.")
    if not output.parent.is_dir():
        raise ImportFailure("The output directory must already exist.")
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode="wb", dir=output.parent, prefix=".justup-import-", delete=False) as handle:
            temporary = Path(handle.name)
            os.chmod(temporary, 0o600)
            written = 1  # Final newline also counts toward the import file ceiling.
            encoder = json.JSONEncoder(ensure_ascii=False, separators=(",", ":"), allow_nan=False)
            for chunk in encoder.iterencode(snapshot):
                encoded = chunk.encode("utf-8")
                written += len(encoded)
                if written > EXPORT_LIMIT:
                    raise ImportFailure("Export exceeds the 64 MiB file limit.")
                handle.write(encoded)
            handle.write(b"\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, output)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def read_previous(path):
    with Path(path).open("rb") as handle:
        data = handle.read(EXPORT_LIMIT + 1)
    if len(data) > EXPORT_LIMIT:
        raise ImportFailure("Previous export exceeds the 64 MiB file limit.")
    return json.loads(data.decode("utf-8"))


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--typesense-host", help="independently approved public HTTPS Typesense host")
    source.add_argument("--feed-manifest", type=Path, help="private versioned Jobseek feed manifest")
    parser.add_argument("--snapshot", help="fixed UTC snapshot for the public Typesense source")
    parser.add_argument("--output", required=True, type=Path, help="private JSON output outside the checkout")
    parser.add_argument("--previous", type=Path, help="previous export whose known IDs must be refreshed")
    parser.add_argument("--company-ids-file", type=Path, help="private schema-1 source-company UUID selector for operator QA; no global fallback")
    parser.add_argument("--max-jobs", default=500, type=int, help="1..1000; initial selection defaults to 500")
    args = parser.parse_args(argv)
    try:
        if args.feed_manifest and (args.snapshot or args.company_ids_file):
            raise ImportFailure("The private feed uses its own cutoff and company scope.")
        if args.typesense_host and not args.snapshot:
            raise ImportFailure("The public Typesense source requires a fixed UTC snapshot.")
        company_ids = read_company_ids(args.company_ids_file) if args.company_ids_file else None
        previous = None
        if args.previous:
            previous = read_previous(args.previous)
        # Validate the destination before any network call.
        output = args.output.expanduser().resolve()
        checkout = Path(__file__).resolve().parents[1]
        if output == checkout or checkout in output.parents or not output.parent.is_dir():
            raise ImportFailure("Use an existing private output directory outside the Git checkout.")
        snapshot = (import_feed_bundle(args.feed_manifest, previous=previous, max_jobs=args.max_jobs)
                    if args.feed_manifest else import_snapshot(PublicClient(args.typesense_host), args.snapshot, max_jobs=args.max_jobs, previous=previous, company_ids=company_ids))
        export_snapshot(snapshot, output)
        staged = snapshot.get("stageVersion") == 1
        candidate = snapshot["candidate"] if staged else snapshot
        receipt = {"jobs": len(candidate["jobs"]), "companies": len({job["companyId"] for job in candidate["jobs"]}),
                   "observations": len(candidate["observations"]), "unknownIds": len(candidate["unknownIds"]),
                   "snapshotAt": candidate["snapshotAt"], "importable": not staged}
        if args.feed_manifest:
            receipt.update(sourceScopeRowCount=candidate["selection"]["sourceScopeRowCount"],
                           limitedCoverage=candidate["selection"]["limitedCoverage"],
                           manifestSha256=candidate["selection"]["feed"]["manifestSha256"])
        if company_ids is not None:
            receipt.update(companySelection=snapshot["selection"]["companySelection"], observedLocales=sorted({locale for job in snapshot["jobs"] for locale in job["locales"]}))
        print(json.dumps(receipt))
    except (ImportFailure, OSError, ValueError) as exc:
        message = str(exc) if isinstance(exc, ImportFailure) else "Import input/output failed."
        print("Import stopped: " + message, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
