import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeCode,
  findMatches,
  getCodeHints,
  buildSearchLinks,
  readHistory,
  saveHistory,
  clearHistory,
} from "../js/lookup.mjs";

const white = {
  id: "white",
  code: "FW-T51-058",
  productCode: "FW-T51-058-1",
  variantCodes: ["FW-T51-058-1-02", "FW-T51-058-1-03"],
};
const black = {
  id: "black",
  code: "FW-T51-058",
  productCode: "FW-T51-058-2",
  variantCodes: ["FW-T51-058-2-02"],
};
const otherStyle = {
  id: "other",
  code: "FW-T52-058",
  productCode: "FW-T52-058-1",
  variantCodes: ["FW-T52-058-1-02"],
};
const records = [black, otherStyle, white];

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
}

test("canonical, compact, Unicode, and spaced codes identify the same base", () => {
  for (const input of ["fw-t51-058", " FWT51058 ", "fw–t51–058", "ＦＷ－Ｔ５１－０５８", "FW T51 058", "FW - T51 - 058"]) {
    const parsed = normalizeCode(input);
    assert.equal(parsed.valid, true, input);
    assert.equal(parsed.normalized, "FW-T51-058", input);
    assert.equal(parsed.baseCode, "FW-T51-058", input);
    assert.equal(parsed.prefix, "FWT", input);
    assert.deepEqual(parsed.suffix, []);
  }
});

test("variant suffixes keep their exact boundaries and leading zeroes", () => {
  for (const input of ["fw-t51-058-1-02", "FWT51058-1-02", "FW T51 058 1 02"]) {
    const parsed = normalizeCode(input);
    assert.equal(parsed.normalized, "FW-T51-058-1-02");
    assert.deepEqual(parsed.suffix, ["1", "02"]);
  }
  assert.equal(normalizeCode("FWT51058102").valid, false, "ambiguous joined suffixes must not be guessed");
});

test("prefixes are hints and never garment matches", () => {
  for (const input of ["HCC", "HC-C", "hc c"]) {
    const parsed = normalizeCode(input);
    assert.equal(parsed.kind, "prefix");
    assert.equal(parsed.normalized, "HCC");
    assert.equal(parsed.baseCode, null);
    assert.deepEqual(findMatches(records, parsed), { type: "prefix", matches: [] });
    assert.deepEqual(buildSearchLinks(parsed), []);
  }
});

test("malformed input cannot silently turn into a plausible garment code", () => {
  for (const input of [null, 123, {}, "", "garment", "HC-C23", "HC-C23-100<script>", "HC-C23-100?size=2", "-HCC", "HC--C", "FW-T51-058--1", "FW-T51-058-", "A".repeat(97)]) {
    const parsed = normalizeCode(input);
    assert.equal(parsed.valid, false, String(input));
    assert.equal(typeof parsed.error, "string");
    assert.deepEqual(findMatches(records, parsed), { type: "none", matches: [] });
  }
});

test("a structurally valid unknown brand can still match a catalog record", () => {
  const parsed = normalizeCode("ZZ-P01-999");
  assert.equal(parsed.valid, true);
  assert.equal(findMatches([{ code: "ZZ-P01-999" }], parsed).type, "style");
  assert.deepEqual(getCodeHints(parsed), { brand: null, itemType: "Pants / Trousers", seasonCode: "Z" });
});

test("a base-code query retains all records and never claims a specific variant", () => {
  const result = findMatches(records, normalizeCode("FW-T51-058"));
  assert.equal(result.type, "style");
  assert.deepEqual(result.matches.map(({ record }) => record.id), ["black", "white"]);
  assert.ok(result.matches.every(({ matchType }) => matchType === "style"));
});

test("full source-listed variant codes rank first without hiding other records", () => {
  const result = findMatches(records, normalizeCode("FW-T51-058-1-02"));
  assert.equal(result.type, "exact");
  assert.deepEqual(result.matches.map(({ record, matchType }) => [record.id, matchType]), [
    ["white", "exact"],
    ["black", "variant-unconfirmed"],
  ]);
  assert.equal(records[0], black, "matching must not reorder the original catalog");
});

test("source-listed product/color code can match exactly", () => {
  const result = findMatches(records, normalizeCode("FW-T51-058-1"));
  assert.equal(result.type, "exact");
  assert.equal(result.matches[0].record, white);
});

test("an unlisted suffix cannot borrow an exact match from another color or size", () => {
  for (const query of ["FW-T51-058-9-99", "FW-T51-058-1-2", "FW-T51-058-1-04"]) {
    const result = findMatches(records, normalizeCode(query));
    assert.equal(result.type, "variant-unconfirmed", query);
    assert.equal(result.matches.length, 2);
    assert.ok(result.matches.every(({ matchType }) => matchType === "variant-unconfirmed"));
  }
});

test("the complete model and material digits participate in garment matching", () => {
  const coats = [{ code: "HC-C23-100" }, { code: "HC-C99-100" }, { code: "HC-C23-001" }];
  const result = findMatches(coats, normalizeCode("HC-C23-100"));
  assert.equal(result.matches.length, 1);
  assert.equal(result.matches[0].record.code, "HC-C23-100");
  assert.deepEqual(findMatches(coats, normalizeCode("HC-C23-999")), { type: "none", matches: [] });
});

test("repeated source records remain available and malformed records are ignored", () => {
  const duplicate = { ...white, id: "another-source" };
  const result = findMatches([null, {}, { code: "HCC" }, white, duplicate], normalizeCode("FW-T51-058-1-02"));
  assert.equal(result.matches.length, 2);
  assert.ok(result.matches.every(({ matchType }) => matchType === "exact"));
  assert.deepEqual(findMatches(null, normalizeCode("FW-T51-058")), { type: "none", matches: [] });
});

test("code hints expose letters but never infer a year", () => {
  assert.deepEqual(getCodeHints(normalizeCode("HC-C23-100")), {
    brand: "Yohji Yamamoto POUR HOMME",
    itemType: "Coat",
    seasonCode: "C",
  });
  assert.equal(getCodeHints(normalizeCode("LC-C23-100")).brand, "LIMI feu");
  assert.deepEqual(getCodeHints(normalizeCode("not a code")), { brand: null, itemType: null, seasonCode: null });
});

test("external links quote the complete code and explicitly separate base broadening", () => {
  const links = buildSearchLinks(normalizeCode("FW-T51-058-1-02"));
  assert.equal(links.length, 6);
  for (const link of links.slice(0, 5)) {
    const url = new URL(link.url);
    assert.equal(url.protocol, "https:");
    assert.equal(url.hostname, "www.google.com");
    assert.ok(url.searchParams.get("q").includes('"FW-T51-058-1-02"'));
    assert.ok(link.label && link.description);
  }
  assert.equal(new URL(links[1].url).searchParams.get("tbm"), "isch");
  assert.match(links[5].label, /Broaden/);
  assert.ok(new URL(links[5].url).searchParams.get("q").includes('"FW-T51-058"'));
  assert.equal(buildSearchLinks(normalizeCode("FW-T51-058")).length, 5);
});

test("legacy history migrates only valid codes, dropping HTML and inferred metadata", () => {
  const storage = memoryStorage({
    yohjiHistory: JSON.stringify([
      { serial: "fw-t51-058", season: "invented season", item: "invented item" },
      { serial: "FW-T51-058" },
      { serial: '<img src=x onerror="alert(1)">' },
      null,
      { serial: "HC-C23-100" },
    ]),
  });
  assert.deepEqual(readHistory(storage), ["FW-T51-058", "HC-C23-100"]);
  assert.equal(storage.getItem("yohjiHistory"), null);
  assert.ok([...storage.values.values()].every((value) => !value.includes("invented")));
  assert.deepEqual(readHistory(storage), ["FW-T51-058", "HC-C23-100"]);
});

test("history deduplicates normalized queries, keeps newest first, and caps length", () => {
  const storage = memoryStorage();
  for (let i = 0; i < 12; i += 1) saveHistory(storage, `HC-C${String(i).padStart(2, "0")}-100`);
  assert.equal(readHistory(storage).length, 10);
  const updated = saveHistory(storage, "hcc05100");
  assert.equal(updated[0], "HC-C05-100");
  assert.equal(updated.filter((code) => code === "HC-C05-100").length, 1);
  assert.deepEqual(readHistory(storage), updated);
  assert.deepEqual(saveHistory(storage, "<script>"), updated);
});

test("corrupt and blocked storage cannot break the lookup", () => {
  assert.deepEqual(readHistory(memoryStorage({ yohjiHistory: "{broken" })), []);
  const blocked = {
    getItem() { throw new Error("Storage disabled"); },
    setItem() { throw new Error("Quota exceeded"); },
    removeItem() { throw new Error("Storage disabled"); },
  };
  assert.deepEqual(readHistory(blocked), []);
  assert.deepEqual(saveHistory(blocked, "FW-T51-058"), ["FW-T51-058"]);
  assert.deepEqual(clearHistory(blocked), []);
  assert.deepEqual(readHistory(null), []);
});

test("modified current history is revalidated before it reaches the UI", () => {
  const storage = memoryStorage();
  saveHistory(storage, "FW-T51-058");
  const currentKey = [...storage.values.keys()][0];
  storage.setItem(currentKey, JSON.stringify(["<img src=x onerror=alert(1)>", "hc-c23-100", {}, "HC-C23-100"]));
  assert.deepEqual(readHistory(storage), ["HC-C23-100"]);
  storage.setItem(currentKey, "{broken");
  assert.deepEqual(readHistory(storage), []);
});

test("cleared history does not resurrect legacy entries", () => {
  const storage = memoryStorage({ yohjiHistory: JSON.stringify([{ serial: "HC-C23-100" }]) });
  clearHistory(storage);
  assert.deepEqual(readHistory(storage), []);
  storage.setItem("yohjiHistory", JSON.stringify([{ serial: "HC-C23-100" }]));
  assert.deepEqual(readHistory(storage), [], "an empty current history takes precedence over a leftover legacy key");
});
