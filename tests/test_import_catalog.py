"""Focused safety and data-integrity tests; no network calls."""

import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("import_catalog", ROOT / "scripts" / "import-catalog.py")
catalog = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(catalog)
NOW = "2026-10-30T17:00:00Z"
EARLIER = "2026-10-01T10:00:00Z"


def product(product_id=1, **overrides):
    result = {
        "id": product_id,
        "handle": "ha-p30-900-1",
        "title": "Y-3 KURO TRACK PANTS",
        "vendor": "Yohji Yamamoto POUR HOMME",
        "variants": [{"sku": "HA-P30-900-1-01"}, {"sku": "HA-P30-900-1-02"}],
        "images": [{"src": "https://cdn.shopify.com/example.jpg"}],
    }
    result.update(overrides)
    return result


class RecordTests(unittest.TestCase):
    def test_record_is_based_on_observed_skus_and_handle(self):
        record = catalog.record_from_product(product(), NOW)
        self.assertEqual(record["code"], "HA-P30-900")
        self.assertEqual(record["productCode"], "HA-P30-900-1")
        self.assertEqual(record["variantCodes"], ["HA-P30-900-1-01", "HA-P30-900-1-02"])
        self.assertEqual(record["sourceUrl"], catalog.SOURCE_URL + "/products/ha-p30-900-1")
        self.assertEqual(record["firstSeenAt"], NOW)
        self.assertNotIn("season", record)
        self.assertNotIn("available", record)

    def test_invalid_or_conflicting_skus_are_not_invented_from_handle(self):
        for variants in [
            [], [{"sku": ""}], [{"sku": "HA-P30-900-1-01 extra"}],
            [{"sku": "HA-P30-900-1-01"}, {"sku": "HW-J01-100-1-01"}],
        ]:
            with self.subTest(variants=variants):
                self.assertIsNone(catalog.record_from_product(product(variants=variants), NOW))

    def test_handle_must_match_sku_to_supply_color_code(self):
        record = catalog.record_from_product(product(handle="ha-p30-900-9"), NOW)
        self.assertEqual(record["code"], "HA-P30-900")
        self.assertIsNone(record["productCode"])

    def test_unsafe_or_missing_images_do_not_hide_valid_codes(self):
        for image in ["javascript:alert(1)", "http://example.com/image.jpg", "https://user:pass@example.com/image.jpg"]:
            with self.subTest(image=image):
                record = catalog.record_from_product(product(images=[{"src": image}]), NOW)
                self.assertEqual(record["code"], "HA-P30-900")
                self.assertIsNone(record["imageUrl"])
        self.assertIsNone(catalog.record_from_product(product(images=[]), NOW)["imageUrl"])
        record = catalog.record_from_product(product(images=[{"src": "//cdn.shopify.com/example.jpg"}]), NOW)
        self.assertEqual(record["imageUrl"], "https://cdn.shopify.com/example.jpg")


class ImportTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.output = Path(self.directory.name) / "catalog.json"

    def initial_snapshot(self):
        return catalog.import_catalog(
            self.output, page_fetcher=lambda page: [product(1), product(2)], delay=0, now=EARLIER
        )

    def test_refresh_keeps_missing_records_and_original_first_seen(self):
        self.initial_snapshot()
        refreshed = catalog.import_catalog(
            self.output, page_fetcher=lambda page: [product(1, title="Updated title")], delay=0, now=NOW
        )
        records = {record["id"]: record for record in refreshed["records"]}
        self.assertEqual(records["official-shop:1"]["firstSeenAt"], EARLIER)
        self.assertEqual(records["official-shop:1"]["lastSeenAt"], NOW)
        self.assertEqual(records["official-shop:1"]["title"], "Updated title")
        self.assertEqual(records["official-shop:2"]["lastSeenAt"], EARLIER)
        self.assertEqual(refreshed["coverage"]["retainedRecords"], 1)
        self.assertEqual(refreshed["coverage"]["indexedRecords"], 2)
        self.assertTrue(refreshed["coverage"]["complete"])

    def test_explicit_page_limit_marks_incomplete_snapshot(self):
        payload = catalog.import_catalog(
            self.output, max_pages=1,
            page_fetcher=lambda page: [product(i) for i in range(1, 251)], delay=0, now=NOW,
        )
        self.assertFalse(payload["coverage"]["complete"])
        self.assertEqual(payload["coverage"]["productsFetched"], 250)
        self.assertEqual(payload["coverage"]["pagesFetched"], 1)

    def test_network_failure_does_not_replace_previous_snapshot(self):
        self.initial_snapshot()
        before = self.output.read_bytes()

        def failing_fetch(page):
            if page == 1:
                return [product(i) for i in range(1, 251)]
            raise catalog.CatalogError("Temporary network failure")

        with self.assertRaises(catalog.CatalogError):
            catalog.import_catalog(self.output, page_fetcher=failing_fetch, delay=0, now=NOW)
        self.assertEqual(self.output.read_bytes(), before)

    def test_empty_feed_and_no_valid_products_preserve_previous_snapshot(self):
        self.initial_snapshot()
        before = self.output.read_bytes()
        for values in [[], [product(variants=[])]]:
            with self.subTest(values=values), self.assertRaises(catalog.CatalogError):
                catalog.import_catalog(self.output, page_fetcher=lambda page: values, delay=0, now=NOW)
            self.assertEqual(self.output.read_bytes(), before)

    def test_atomic_replace_failure_preserves_previous_snapshot(self):
        self.initial_snapshot()
        before = self.output.read_bytes()
        with mock.patch.object(catalog.os, "replace", side_effect=OSError("disk error")):
            with self.assertRaises(OSError):
                catalog.import_catalog(
                    self.output, page_fetcher=lambda page: [product(1, title="Changed")], delay=0, now=NOW
                )
        self.assertEqual(self.output.read_bytes(), before)
        self.assertEqual(list(self.output.parent.glob("*.tmp")), [])

    def test_invalid_previous_json_is_preserved(self):
        self.output.write_text("not json", encoding="utf-8")
        with self.assertRaises(catalog.CatalogError):
            catalog.import_catalog(self.output, page_fetcher=lambda page: [product()], delay=0, now=NOW)
        self.assertEqual(self.output.read_text(encoding="utf-8"), "not json")


if __name__ == "__main__":
    unittest.main()
