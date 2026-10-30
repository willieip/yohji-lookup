/** Pure code parsing, catalog matching, search links, and local history. */

const HISTORY_KEY = "yohjiLookupHistory.v2";
const LEGACY_HISTORY_KEY = "yohjiHistory";
const HISTORY_LIMIT = 10;

const BRANDS = Object.freeze({
  H: "Yohji Yamamoto POUR HOMME",
  F: "Yohji Yamamoto Femme",
  N: "Yohji Yamamoto Noir",
  L: "LIMI feu",
  Y: "Y’s",
  M: "Y’s for men",
});

const ITEM_TYPES = Object.freeze({
  E: "Shoes",
  J: "Jacket",
  C: "Coat",
  S: "Skirt",
  B: "Blouse / Shirt",
  P: "Pants / Trousers",
  K: "Knit",
  T: "Top",
});

/**
 * Normalize a complete product code without guessing omitted variant digits.
 * Three-letter prefixes are accepted only as hints, never as item identities.
 */
export function normalizeCode(value) {
  if (typeof value !== "string" || value.length > 96) {
    return { valid: false, error: "Enter a product code such as HC-C23-100." };
  }

  const cleaned = value
    .normalize("NFKC")
    .trim()
    .toUpperCase()
    .replace(/[\u2010-\u2015\u2212\uFE58\uFE63\uFF0D]/g, "-")
    .replace(/\s*-\s*/g, "-")
    .replace(/\s+/g, "-");

  if (!cleaned) {
    return { valid: false, error: "Enter the product code from your garment’s label." };
  }

  const prefixOnly = cleaned.replace(/-/g, "");
  if (/^(?:[A-Z]{3}|[A-Z]{2}-[A-Z]|[A-Z]-[A-Z]-[A-Z])$/.test(cleaned)) {
    return {
      valid: true,
      kind: "prefix",
      normalized: prefixOnly,
      baseCode: null,
      prefix: prefixOnly,
      suffix: [],
    };
  }

  // Core separators may be omitted, but suffix boundaries must be explicit.
  const match = cleaned.match(/^([A-Z]{2})-?([A-Z]\d{2})-?(\d{3})((?:-[A-Z0-9]{1,12}){0,4})$/);
  if (!match) {
    return {
      valid: false,
      error: "Use a complete code such as HC-C23-100, including any color or size suffix. Three letters such as HCC show code hints only.",
    };
  }

  const baseCode = `${match[1]}-${match[2]}-${match[3]}`;
  const suffix = match[4] ? match[4].slice(1).split("-") : [];
  return {
    valid: true,
    kind: "product",
    normalized: [baseCode, ...suffix].join("-"),
    baseCode,
    prefix: match[1] + match[2][0],
    suffix,
  };
}

function normalizedProduct(value) {
  const parsed = normalizeCode(value);
  return parsed.valid && parsed.kind === "product" ? parsed : null;
}

/**
 * A full-code match requires an explicitly listed source code. A different
 * suffix remains unconfirmed even when its base product code is in the index.
 */
export function findMatches(records, parsed) {
  if (!parsed?.valid) return { type: "none", matches: [] };
  if (parsed.kind === "prefix") return { type: "prefix", matches: [] };
  if (parsed.kind !== "product" || !Array.isArray(records)) {
    return { type: "none", matches: [] };
  }

  const matches = [];
  for (const record of records) {
    if (!record || typeof record !== "object") continue;
    const sourceBase = normalizedProduct(record.code);
    if (!sourceBase || sourceBase.baseCode !== parsed.baseCode) continue;

    if (parsed.suffix.length === 0) {
      matches.push({ record, matchType: "style" });
      continue;
    }

    const explicitlyListed = [
      record.code,
      record.productCode,
      ...(Array.isArray(record.variantCodes) ? record.variantCodes : []),
    ];
    const exact = explicitlyListed.some((code) => normalizedProduct(code)?.normalized === parsed.normalized);
    matches.push({ record, matchType: exact ? "exact" : "variant-unconfirmed" });
  }

  if (matches.length === 0) return { type: "none", matches: [] };
  if (parsed.suffix.length === 0) return { type: "style", matches };

  // Stable sort retains every source record, with confirmed variants first.
  matches.sort((a, b) => Number(b.matchType === "exact") - Number(a.matchType === "exact"));
  return {
    type: matches.some((match) => match.matchType === "exact") ? "exact" : "variant-unconfirmed",
    matches,
  };
}

/** These are label-code hints, not item identifications or season estimates. */
export function getCodeHints(parsed) {
  if (!parsed?.valid || !/^[A-Z]{3}$/.test(parsed.prefix || "")) {
    return { brand: null, itemType: null, seasonCode: null };
  }
  return {
    brand: BRANDS[parsed.prefix[0]] || null,
    itemType: ITEM_TYPES[parsed.prefix[2]] || null,
    seasonCode: parsed.prefix[1],
  };
}

function googleURL(query, images = false) {
  const url = new URL("https://www.google.com/search");
  url.searchParams.set("q", query);
  if (images) url.searchParams.set("tbm", "isch");
  return url.href;
}

/** External searches are search shortcuts, not evidence of an item match. */
export function buildSearchLinks(parsed) {
  if (!parsed?.valid || parsed.kind !== "product") return [];
  const quoted = `"${parsed.normalized}"`;
  const query = `${quoted} "Yohji Yamamoto"`;
  const links = [
    {
      label: "Search the web",
      description: "Look for listings containing the full quoted code.",
      url: googleURL(query),
    },
    {
      label: "Search images",
      description: "Compare garment photos from results for this code.",
      url: googleURL(query, true),
    },
    {
      label: "Official shop",
      description: "Search the international and Japanese official stores.",
      url: googleURL(`${quoted} (site:theshopyohjiyamamoto.com OR site:theshopyohjiyamamoto.jp)`),
    },
    {
      label: "FASCINATE",
      description: "Search current and older retailer product pages.",
      url: googleURL(`${quoted} (site:fascinate-online.com OR site:fascinate.jp)`),
    },
    {
      label: "Japanese resale",
      description: "Search RAGTAG, Kindal, and 2nd STREET for this code.",
      url: googleURL(`${quoted} (site:ragtag.jp OR site:kind.co.jp OR site:2ndstreet.jp)`),
    },
  ];

  if (parsed.suffix.length > 0) {
    links.push({
      label: `Broaden to ${parsed.baseCode}`,
      description: "Search the base product code across color and size variants.",
      url: googleURL(`"${parsed.baseCode}" "Yohji Yamamoto"`),
    });
  }
  return links;
}

function cleanHistory(entries, legacy = false) {
  if (!Array.isArray(entries)) return [];
  const history = [];
  for (const entry of entries.slice(0, 200)) {
    const value = typeof entry === "string" ? entry : legacy ? entry?.serial : null;
    const parsed = normalizeCode(value);
    if (!parsed.valid || history.includes(parsed.normalized)) continue;
    history.push(parsed.normalized);
    if (history.length === HISTORY_LIMIT) break;
  }
  return history;
}

function storedList(storage, key) {
  try {
    const raw = storage?.getItem(key);
    if (typeof raw !== "string" || raw.length > 20000) return null;
    const entries = JSON.parse(raw);
    return Array.isArray(entries) ? entries : null;
  } catch {
    return null;
  }
}

function persistHistory(storage, history) {
  try {
    storage?.setItem(HISTORY_KEY, JSON.stringify(history));
    return Boolean(storage);
  } catch {
    return false;
  }
}

/** Returns normalized code strings, newest first. Storage can be unavailable. */
export function readHistory(storage) {
  const current = storedList(storage, HISTORY_KEY);
  if (current !== null) return cleanHistory(current);

  const legacy = storedList(storage, LEGACY_HISTORY_KEY);
  if (legacy === null) return [];
  const migrated = cleanHistory(legacy, true);
  if (persistHistory(storage, migrated)) {
    try {
      storage.removeItem(LEGACY_HISTORY_KEY);
    } catch {
      // The new key takes priority even if old storage cannot be removed.
    }
  }
  return migrated;
}

export function saveHistory(storage, code) {
  const current = readHistory(storage);
  const parsed = normalizeCode(code);
  if (!parsed.valid) return current;
  const history = [parsed.normalized, ...current.filter((entry) => entry !== parsed.normalized)].slice(0, HISTORY_LIMIT);
  persistHistory(storage, history);
  return history;
}

export function clearHistory(storage) {
  // Keep an empty current list so a leftover legacy key cannot reappear.
  persistHistory(storage, []);
  try {
    storage?.removeItem(LEGACY_HISTORY_KEY);
  } catch {
    // Browsers may disable storage; clearing still must not crash the lookup.
  }
  return [];
}
