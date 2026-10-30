#!/usr/bin/env python3
"""Refresh a small, attributable garment index from the official public shop.

Uses Python's standard library and Shopify's public storefront product feed.
No credentials, private APIs, inferred seasons, prices, or stock claims are used.
The output retains previously observed products when they leave the live feed.
"""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
import html
import json
import os
from pathlib import Path
import re
import sys
import tempfile
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
import urllib.robotparser


SOURCE_NAME = "THE SHOP YOHJI YAMAMOTO"
SOURCE_URL = "https://theshopyohjiyamamoto.com"
FEED_URL = SOURCE_URL + "/products.json"
USER_AGENT = "YohjiLookup/1.0 (+https://github.com/willieip/yohji-lookup)"
PAGE_SIZE = 250
HARD_PAGE_LIMIT = 200
MAX_RESPONSE_BYTES = 16 * 1024 * 1024
DEFAULT_OUTPUT = Path(__file__).resolve().parents[1] / "data" / "catalog.json"
CODE_PATTERN = re.compile(r"^([A-Z]{2}-[A-Z][0-9]{2}-[0-9]{3})(?:-[0-9]+)*$")
HANDLE_PATTERN = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")


class CatalogError(Exception):
    """An import failed without replacing the previous catalogue."""


def normalized_code(value):
    if not isinstance(value, str):
        return None
    code = unicodedata.normalize("NFKC", value).strip().upper()
    return code if CODE_PATTERN.fullmatch(code) else None


def clean_text(value):
    if not isinstance(value, str):
        return ""
    return " ".join(html.unescape(value).replace("\x00", "").split())


def https_url(value):
    if not isinstance(value, str):
        return None
    value = value.strip()
    if value.startswith("//"):
        value = "https:" + value
    try:
        parsed = urllib.parse.urlsplit(value)
    except ValueError:
        return None
    if (
        parsed.scheme != "https"
        or not parsed.hostname
        or parsed.username
        or parsed.password
        or any(ord(char) < 32 for char in value)
    ):
        return None
    return value


def record_from_product(product, observed_at):
    """Extract a style only when the official variants contain valid full SKUs."""
    if not isinstance(product, dict):
        return None
    product_id = str(product.get("id", ""))
    handle = product.get("handle")
    title = clean_text(product.get("title"))
    variants = product.get("variants")
    if (
        not product_id.isascii()
        or not product_id.isdigit()
        or int(product_id) <= 0
        or not isinstance(handle, str)
        or not HANDLE_PATTERN.fullmatch(handle)
        or not title
        or not isinstance(variants, list)
    ):
        return None

    variant_codes = sorted(
        {
            code
            for variant in variants
            if isinstance(variant, dict)
            for code in [normalized_code(variant.get("sku"))]
            if code
        }
    )
    base_codes = {CODE_PATTERN.fullmatch(code).group(1) for code in variant_codes}
    # Conflicting style references should be reviewed, never guessed.
    if len(base_codes) != 1:
        return None
    code = next(iter(base_codes))
    handle_code = normalized_code(handle)
    product_code = None
    if (
        handle_code
        and handle_code != code
        and CODE_PATTERN.fullmatch(handle_code).group(1) == code
        and any(
            variant == handle_code or variant.startswith(handle_code + "-")
            for variant in variant_codes
        )
    ):
        product_code = handle_code

    images = product.get("images")
    image_url = next(
        (
            url
            for image in images if isinstance(image, dict)
            for url in [https_url(image.get("src"))]
            if url
        ),
        None,
    ) if isinstance(images, list) else None
    return {
        "id": "official-shop:" + product_id,
        "code": code,
        "productCode": product_code,
        "variantCodes": variant_codes,
        "title": title,
        "brand": clean_text(product.get("vendor")) or "Yohji Yamamoto group",
        "imageUrl": image_url,
        "sourceUrl": SOURCE_URL + "/products/" + handle,
        "sourceName": SOURCE_NAME,
        "firstSeenAt": observed_at,
        "lastSeenAt": observed_at,
    }


def request_bytes(url, timeout=30):
    request = urllib.request.Request(
        url, headers={"User-Agent": USER_AGENT, "Accept": "application/json, text/plain;q=0.9"}
    )
    for attempt in range(3):
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                payload = response.read(MAX_RESPONSE_BYTES + 1)
            if len(payload) > MAX_RESPONSE_BYTES:
                raise CatalogError("Response exceeded the safe import size: " + url)
            return payload
        except urllib.error.HTTPError as exc:
            if exc.code not in {429, 500, 502, 503, 504} or attempt == 2:
                raise CatalogError(f"HTTP {exc.code} while fetching {url}") from exc
            retry_after = exc.headers.get("Retry-After", "")
            wait_seconds = 2 ** attempt
            if retry_after:
                try:
                    wait_seconds = int(retry_after) if retry_after.isdigit() else max(
                        0, (parsedate_to_datetime(retry_after) - datetime.now(timezone.utc)).total_seconds()
                    )
                except (ValueError, TypeError) as parse_error:
                    raise CatalogError("The source requested a retry delay; please retry the import later.") from parse_error
                if wait_seconds > 60:
                    raise CatalogError("The source requested a longer retry delay; please retry the import later.") from exc
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            if attempt == 2:
                raise CatalogError(f"Could not fetch {url}: {exc}") from exc
            wait_seconds = 2 ** attempt
        print(f"Retrying public feed in {wait_seconds}s…", file=sys.stderr, flush=True)
        time.sleep(wait_seconds)
    raise CatalogError("The public feed request did not complete.")


def check_robots():
    robots_url = SOURCE_URL + "/robots.txt"
    try:
        content = request_bytes(robots_url).decode("utf-8")
    except (CatalogError, UnicodeDecodeError) as exc:
        raise CatalogError("Could not check the source's robots.txt; import stopped.") from exc
    parser = urllib.robotparser.RobotFileParser(robots_url)
    parser.parse(content.splitlines())
    if not parser.can_fetch(USER_AGENT, FEED_URL + "?limit=250&page=1"):
        raise CatalogError("The source's robots.txt does not allow this public feed import.")
    delay = max(0.5, float(parser.crawl_delay(USER_AGENT) or 0))
    rate = parser.request_rate(USER_AGENT)
    if rate and rate.requests:
        delay = max(delay, rate.seconds / rate.requests)
    if delay > 60:
        raise CatalogError("The source now requests a crawl delay over one minute; import stopped.")
    return delay


def fetch_page(page):
    url = FEED_URL + "?" + urllib.parse.urlencode({"limit": PAGE_SIZE, "page": page})
    try:
        payload = json.loads(request_bytes(url))
    except (json.JSONDecodeError, UnicodeDecodeError) as exc:
        raise CatalogError("The public feed returned invalid JSON: " + url) from exc
    if not isinstance(payload, dict) or not isinstance(payload.get("products"), list):
        raise CatalogError("The public feed no longer has the expected products array.")
    if len(payload["products"]) > PAGE_SIZE:
        raise CatalogError("The public feed did not respect the requested page size.")
    return payload["products"]


def read_previous(output):
    if not output.exists():
        return []
    try:
        previous = json.loads(output.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise CatalogError("Existing catalogue could not be read; it has been preserved.") from exc
    if (
        not isinstance(previous, dict)
        or previous.get("schemaVersion") != 1
        or not isinstance(previous.get("records"), list)
    ):
        raise CatalogError("Existing catalogue has an unknown schema; it has been preserved.")
    records = previous["records"]
    ids = set()
    for record in records:
        if (
            not isinstance(record, dict)
            or not isinstance(record.get("id"), str)
            or record["id"] in ids
            or not normalized_code(record.get("code"))
            or not isinstance(record.get("firstSeenAt"), str)
            or not isinstance(record.get("lastSeenAt"), str)
        ):
            raise CatalogError("Existing catalogue has invalid records; it has been preserved.")
        ids.add(record["id"])
    return records


def atomic_write(output, payload):
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary_path = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w", encoding="utf-8", dir=output.parent,
            prefix=".catalog-", suffix=".json.tmp", delete=False,
        ) as temporary:
            temporary_path = Path(temporary.name)
            json.dump(payload, temporary, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
            temporary.write("\n")
            temporary.flush()
            os.fsync(temporary.fileno())
        os.replace(temporary_path, output)
    finally:
        if temporary_path is not None and temporary_path.exists():
            temporary_path.unlink()


def import_catalog(output, *, max_pages=None, page_fetcher=fetch_page, delay=0.5, now=None):
    if max_pages is not None and not 1 <= max_pages <= HARD_PAGE_LIMIT:
        raise CatalogError(f"--max-pages must be between 1 and {HARD_PAGE_LIMIT}.")
    output = Path(output)
    previous = {record["id"]: record for record in read_previous(output)}
    observed_at = now or datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
    observed = {}
    products_fetched = 0
    complete = False
    pages_fetched = 0
    limit = max_pages if max_pages is not None else HARD_PAGE_LIMIT

    for page in range(1, limit + 1):
        products = page_fetcher(page)
        if not isinstance(products, list) or len(products) > PAGE_SIZE:
            raise CatalogError("The public feed returned an invalid page.")
        if page == 1 and not products:
            raise CatalogError("The first feed page was empty; existing catalogue has been preserved.")
        pages_fetched += 1
        products_fetched += len(products)
        for product in products:
            record = record_from_product(product, observed_at)
            if record:
                older = previous.get(record["id"])
                if older:
                    record["firstSeenAt"] = older["firstSeenAt"]
                observed[record["id"]] = record
        print(
            f"Page {page}: {len(products)} products; {len(observed)} verified records so far.",
            file=sys.stderr, flush=True,
        )
        if len(products) < PAGE_SIZE:
            complete = True
            break
        if page < limit and delay:
            time.sleep(delay)

    if not complete and max_pages is None:
        raise CatalogError(
            f"Reached the {HARD_PAGE_LIMIT}-page safety limit before the feed ended; "
            "existing catalogue has been preserved."
        )
    if not observed:
        raise CatalogError("No verifiable garment records were found; existing catalogue has been preserved.")

    retained_count = len(set(previous) - set(observed))
    records = dict(previous)
    records.update(observed)
    payload = {
        "schemaVersion": 1,
        "updatedAt": observed_at,
        "source": {"name": SOURCE_NAME, "url": SOURCE_URL, "feedUrl": FEED_URL},
        "coverage": {
            "complete": complete,
            "pagesFetched": pages_fetched,
            "productsFetched": products_fetched,
            "indexedRecords": len(records),
            "retainedRecords": retained_count,
        },
        "records": sorted(
            records.values(), key=lambda record: (
                record["code"], record.get("productCode") or "", record["id"]
            ),
        ),
    }
    atomic_write(output, payload)
    return payload


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument(
        "--max-pages", type=int,
        help="Stop after this many pages; coverage is marked partial unless the feed ended.",
    )
    args = parser.parse_args(argv)
    try:
        if args.max_pages is not None and not 1 <= args.max_pages <= HARD_PAGE_LIMIT:
            raise CatalogError(f"--max-pages must be between 1 and {HARD_PAGE_LIMIT}.")
        delay = check_robots()
        payload = import_catalog(args.output, max_pages=args.max_pages, delay=delay)
    except (CatalogError, OSError) as exc:
        print("Import failed: " + str(exc), file=sys.stderr)
        return 1
    coverage = payload["coverage"]
    status = "complete public-feed snapshot" if coverage["complete"] else "PARTIAL public-feed snapshot"
    print(
        f"Saved {coverage['indexedRecords']} records ({coverage['retainedRecords']} retained) "
        f"to {args.output}: {status}."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
