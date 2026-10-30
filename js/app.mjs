import { normalizeCode, findMatches, getCodeHints, buildSearchLinks, readHistory, saveHistory, clearHistory } from './lookup.mjs';

const $ = (id) => document.getElementById(id);
const PAGE_SIZE = 12;
const number = new Intl.NumberFormat('en');
const state = { catalog: null, records: [], loading: true, error: false, page: 1, parsed: null };
let storage;
try { storage = window.localStorage; } catch { storage = null; }

function element(tag, className = '', text = '') {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function httpsURL(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url : null;
  } catch { return null; }
}

function externalLink(url, className, label) {
  const node = element('a', className, label);
  const safe = httpsURL(url);
  if (safe) {
    node.href = safe.href;
    node.target = '_blank';
    node.rel = 'noopener noreferrer';
  }
  return node;
}

function formatDate(value) {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat('en', { day: 'numeric', month: 'short', year: 'numeric' }).format(date)
    : 'Date unavailable';
}

function imageFor(record, eager = false) {
  const frame = element('div', 'product-image');
  const safe = httpsURL(record.imageUrl);
  if (!safe) {
    frame.append(element('span', 'image-fallback', 'Photograph unavailable'));
    return frame;
  }
  if (safe.hostname === 'cdn.shopify.com' || safe.hostname === 'theshopyohjiyamamoto.com') safe.searchParams.set('width', '640');
  const img = element('img');
  img.src = safe.href;
  img.alt = record.title;
  img.loading = eager ? 'eager' : 'lazy';
  img.decoding = 'async';
  img.width = 640;
  img.height = 800;
  img.addEventListener('error', () => frame.replaceChildren(element('span', 'image-fallback', 'Photograph unavailable')), { once: true });
  frame.append(img);
  return frame;
}

function actionButton(label, className, action) {
  const button = element('button', className, label);
  button.type = 'button';
  button.addEventListener('click', action);
  return button;
}

function catalogCard(record) {
  const card = element('article', 'product-card');
  const photoLink = externalLink(record.sourceUrl, '', '');
  photoLink.setAttribute('aria-label', `View ${record.title} at the original source`);
  photoLink.append(imageFor(record));
  card.append(photoLink, element('p', 'card-code', record.productCode || record.code), element('h3', '', record.title), element('p', 'card-brand', record.brand || 'Brand line unspecified'));
  const bottom = element('div', 'card-bottom');
  bottom.append(externalLink(record.sourceUrl, 'card-source', 'Official source ↗'), actionButton('View record →', 'inspect-button', () => submitCode(record.productCode || record.code)));
  card.append(bottom);
  return card;
}

const MATCH_LABELS = { exact: 'Exact recorded code', style: 'Product code match', 'variant-unconfirmed': 'Variant unconfirmed' };

function resultCard({ record, matchType }, index) {
  const card = element('article', 'result-card');
  const photoLink = externalLink(record.sourceUrl, '', '');
  photoLink.setAttribute('aria-label', `View ${record.title} at the original source`);
  photoLink.append(imageFor(record, index < 2));
  const detail = element('div', 'result-detail');
  detail.append(element('span', `match-badge${matchType === 'variant-unconfirmed' ? ' unconfirmed' : ''}`, MATCH_LABELS[matchType]), element('p', 'card-code', record.productCode || record.code), element('h3', '', record.title), element('p', 'card-brand', record.brand || 'Brand line unspecified'));
  detail.append(externalLink(record.sourceUrl, 'result-source-link', 'View original listing ↗'));
  detail.append(element('p', 'record-source', `${record.sourceName || 'Official shop'} · Last seen ${formatDate(record.lastSeenAt)}`));
  const codes = [...new Set([record.productCode, ...(record.variantCodes || [])].filter(Boolean))];
  if (codes.length) {
    const disclosure = element('details', 'record-variants');
    disclosure.append(element('summary', '', `${codes.length} recorded product number${codes.length === 1 ? '' : 's'}`));
    const list = element('ul', 'variant-list');
    for (const code of codes) {
      const li = element('li');
      const codeNode = element(code === state.parsed?.normalized ? 'strong' : 'span', '', code);
      li.append(codeNode);
      list.append(li);
    }
    disclosure.append(list);
    detail.append(disclosure);
  }
  card.append(photoLink, detail);
  return card;
}

function renderHistory(codes = readHistory(storage)) {
  $('history-list').replaceChildren(...codes.map((code) => actionButton(code, 'history-button', () => submitCode(code))));
  $('history-section').hidden = codes.length === 0;
  $('clear-history').hidden = codes.length === 0;
}

function updateAddress(code, push = true) {
  const url = new URL(location.href);
  url.searchParams.set('code', code);
  url.hash = '';
  if (url.href !== location.href) {
    try { window.history[push ? 'pushState' : 'replaceState']({}, '', url); } catch { /* Lookup also works without URL history. */ }
  }
}

function renderClues(parsed) {
  const hints = getCodeHints(parsed);
  const grid = element('dl', 'clue-grid');
  for (const [label, value] of [['Possible line', hints.brand || 'Not mapped'], ['Possible item type', hints.itemType || 'Not mapped'], ['Season letter', hints.seasonCode ? `${hints.seasonCode} — year unconfirmed` : 'Not mapped']]) {
    const group = element('div');
    group.append(element('dt', '', label), element('dd', '', value));
    grid.append(group);
  }
  $('clue-content').replaceChildren(grid);
  $('code-clues').hidden = false;
  $('code-clues').open = parsed.kind === 'prefix';
}

function renderSearchLinks(parsed) {
  const links = buildSearchLinks(parsed);
  $('search-links').replaceChildren(...links.map((item) => {
    const link = externalLink(item.url, 'search-link', '');
    link.append(element('strong', '', item.label), element('span', '', item.description));
    return link;
  }));
  $('continue-search').hidden = !links.length;
}

function renderResult() {
  const parsed = state.parsed;
  if (!parsed) { $('results').hidden = true; return; }
  $('results').hidden = false;
  $('query-code').textContent = parsed.normalized;
  $('result-grid').replaceChildren();
  $('result-actions').replaceChildren();
  renderClues(parsed);
  renderSearchLinks(parsed);
  let title, description, kicker;

  if (parsed.kind === 'prefix') {
    kicker = 'Label clues only';
    title = 'Add the rest of the code.';
    description = 'Three letters can suggest a brand line and an item type. The model and material numbers are needed to search for a garment.';
  } else if (state.loading) {
    kicker = 'Checking the index';
    title = 'Loading the garment records…';
    description = 'Your code is ready. The lookup will run as soon as the catalog finishes loading.';
  } else if (state.error) {
    kicker = 'Catalog unavailable';
    title = 'The index could not be loaded.';
    description = 'We could not check your code. Try loading the catalog again, or use the source searches below.';
    $('result-actions').append(actionButton('Retry loading the catalog', 'button-secondary', loadCatalog));
  } else {
    const result = findMatches(state.records, parsed);
    if (result.type === 'none') {
      kicker = 'Not in this index';
      title = `No record for ${parsed.normalized}.`;
      description = `This index has ${number.format(state.records.length)} source records. Older, removed, or unindexed pieces may still exist elsewhere. Continue with an exact-code search below.`;
    } else {
      const count = result.matches.length;
      kicker = MATCH_LABELS[result.type];
      if (result.type === 'variant-unconfirmed') {
        title = 'A related product. The suffix is unconfirmed.';
        description = `The base code ${parsed.baseCode} appears in the source, but the full code you entered is not recorded. Compare the original listing before treating it as the same variant.`;
      } else if (result.type === 'exact') {
        const exactCount = result.matches.filter((match) => match.matchType === 'exact').length;
        title = exactCount === 1 ? 'Your code has a source.' : `${exactCount} records list your exact code.`;
        description = `The full code is recorded by the source. ${count > exactCount ? 'Other records sharing the base code appear below as unconfirmed variants. ' : ''}Open the original listing to compare the garment and its details.`;
      } else {
        title = count === 1 ? 'A record for your product code.' : `${count} records share this product code.`;
        description = 'These listings share the complete base code. Check the photographs and any color or size suffix against your label.';
      }
      // All matching sources remain accessible; paginate unusually large groups.
      let shown = 0;
      function showMore() {
        const next = result.matches.slice(shown, shown + 12);
        $('result-grid').append(...next.map((match, index) => resultCard(match, shown + index)));
        shown += next.length;
        $('result-actions').replaceChildren();
        if (shown < count) $('result-actions').append(actionButton(`Show more records (${count - shown} remaining)`, 'button-secondary', showMore));
      }
      showMore();
    }
  }
  $('result-kicker').textContent = kicker;
  $('result-title').textContent = title;
  $('result-description').textContent = description;
  $('result-status').textContent = `${parsed.normalized}: ${kicker}. ${title}`;
}

function submitCode(value, { updateURL = true, focus = true, save = true } = {}) {
  const parsed = normalizeCode(value);
  $('code-error').hidden = parsed.valid;
  $('code-input').setAttribute('aria-invalid', String(!parsed.valid));
  if (!parsed.valid) {
    $('code-error').textContent = parsed.error;
    $('results').hidden = true;
    state.parsed = null;
    $('result-status').textContent = parsed.error;
    if (updateURL) {
      const url = new URL(location.href);
      url.searchParams.delete('code');
      if (url.href !== location.href) {
        try { window.history.pushState({}, '', url); } catch { /* Validation does not depend on URL history. */ }
      }
    }
    if (focus) $('code-input').focus();
    return;
  }
  $('code-input').value = parsed.normalized;
  state.parsed = parsed;
  if (updateURL) updateAddress(parsed.normalized);
  if (save) renderHistory(saveHistory(storage, parsed.normalized));
  renderResult();
  if (focus) {
    $('result-title').focus({ preventScroll: true });
    $('results').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'start' });
  }
}

function renderCatalog() {
  if (!state.catalog) return;
  const search = $('catalog-filter').value.normalize('NFKC').trim().toLowerCase();
  const compactSearch = search.replace(/[\s\u2010-\u2015\u2212-]+/g, '');
  const brand = $('brand-filter').value;
  const filtered = state.records.filter((record) => (!brand || record.brand === brand) && (!search || record.searchText.includes(search) || record.compactCodes.includes(compactSearch)));
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  state.page = Math.min(state.page, pageCount);
  const start = (state.page - 1) * PAGE_SIZE;
  $('catalog-grid').replaceChildren(...filtered.slice(start, start + PAGE_SIZE).map(catalogCard));
  $('catalog-state').hidden = filtered.length > 0;
  if (!filtered.length) {
    $('catalog-state').replaceChildren(element('p', '', 'No records match these filters.'), actionButton('Clear filters', 'button-secondary', () => { $('catalog-filter').value = ''; $('brand-filter').value = ''; state.page = 1; renderCatalog(); }));
  }
  $('pagination').hidden = filtered.length === 0;
  $('page-label').textContent = `Showing ${number.format(start + 1)}–${number.format(Math.min(start + PAGE_SIZE, filtered.length))} of ${number.format(filtered.length)} records · Page ${state.page} of ${pageCount}`;
  $('previous-page').disabled = state.page <= 1;
  $('next-page').disabled = state.page >= pageCount;
}

function validateCatalog(data) {
  if (data?.schemaVersion !== 1 || !Array.isArray(data.records) || !data.records.length) throw new Error('Catalog schema missing.');
  const records = data.records.filter((record) => {
    const parsed = normalizeCode(record?.code);
    return parsed.valid && parsed.kind === 'product' && !parsed.suffix.length && typeof record.title === 'string' && record.title.length > 0 && httpsURL(record.sourceUrl);
  });
  // A malformed snapshot must not turn a partial validation into false no-match results.
  if (records.length !== data.records.length) throw new Error('Catalog contains invalid records.');
  return records.map((record) => ({
    ...record,
    variantCodes: Array.isArray(record.variantCodes) ? record.variantCodes.filter((code) => typeof code === 'string') : [],
    searchText: [record.title, record.code, record.productCode, record.brand, ...(record.variantCodes || [])].join(' ').toLowerCase(),
    compactCodes: [record.code, record.productCode, ...(record.variantCodes || [])].join(' ').replace(/-/g, '').toLowerCase(),
  }));
}

function populateCatalogInfo() {
  const data = state.catalog;
  const count = number.format(state.records.length);
  $('catalog-total').textContent = `${count} source records`;
  $('hero-coverage').textContent = `${count} records from the official shop, ready to search.`;
  $('catalog-updated').textContent = formatDate(data.updatedAt);
  $('coverage-text').textContent = `${count} indexed records. ${data.coverage?.complete ? 'Public shop feed retrieved in full on the import date.' : 'Partial snapshot of the public shop feed.'} Historical coverage varies.`;
  const brands = [...new Set(state.records.map((record) => record.brand).filter(Boolean))].sort();
  $('brand-filter').replaceChildren(new Option('All brand lines', ''), ...brands.map((brand) => new Option(brand, brand)));
  $('catalog-filter').disabled = false;
  $('brand-filter').disabled = false;
  const examples = [];
  for (const prefix of ['H', 'Y', 'F']) {
    const record = state.records.find((item) => item.code.startsWith(prefix) && /[JCPBTK]/.test(item.code[3]));
    if (record && !examples.includes(record.code)) examples.push(record.code);
  }
  if (!examples.length && state.records[0]) examples.push(state.records[0].code);
  $('example-buttons').replaceChildren(...examples.map((code) => actionButton(code, 'example-button', () => submitCode(code))));
  $('examples').hidden = !examples.length;
}

let catalogRequest = null;
async function loadCatalog() {
  if (catalogRequest) return catalogRequest;
  state.loading = true;
  state.error = false;
  $('catalog-state').hidden = false;
  $('catalog-state').textContent = 'Loading the catalog…';
  if (state.parsed) renderResult();
  catalogRequest = Promise.resolve().then(async () => {
    let timeout;
    try {
      const controller = new AbortController();
      timeout = setTimeout(() => controller.abort(), 30000);
      const response = await fetch(new URL('../data/catalog.json', import.meta.url), { cache: 'no-cache', signal: controller.signal });
      if (!response.ok) throw new Error(`Catalog response ${response.status}`);
      const data = await response.json();
      const records = validateCatalog(data);
      const garmentRank = (record) => 'CJPBTKS'.includes(record.code[3]) ? 0 : 1;
      records.sort((a, b) => garmentRank(a) - garmentRank(b) || Number(!a.code.startsWith('H')) - Number(!b.code.startsWith('H')) || a.code.localeCompare(b.code));
      state.catalog = data;
      state.records = records;
      state.loading = false;
      populateCatalogInfo();
      renderCatalog();
    } catch {
      state.loading = false;
      state.error = true;
      $('hero-coverage').textContent = 'The catalog is temporarily unavailable.';
      $('catalog-total').textContent = 'Catalog unavailable';
      $('catalog-updated').textContent = 'Unavailable';
      $('catalog-state').replaceChildren(element('p', '', 'The catalog could not be loaded. Your code can still be searched at the original sources.'), actionButton('Retry loading', 'button-secondary', loadCatalog));
    } finally {
      clearTimeout(timeout);
      catalogRequest = null;
      if (state.parsed) renderResult();
    }
  });
  return catalogRequest;
}

$('lookup-form').addEventListener('submit', (event) => { event.preventDefault(); submitCode($('code-input').value); });
$('code-input').addEventListener('input', () => { $('code-error').hidden = true; $('code-input').removeAttribute('aria-invalid'); });
$('clear-history').addEventListener('click', () => renderHistory(clearHistory(storage)));
$('catalog-filter').addEventListener('input', () => { state.page = 1; renderCatalog(); });
$('brand-filter').addEventListener('change', () => { state.page = 1; renderCatalog(); });
for (const [id, delta] of [['previous-page', -1], ['next-page', 1]]) {
  $(id).addEventListener('click', () => { state.page += delta; renderCatalog(); $('catalog-title').scrollIntoView({ block: 'start' }); });
}
window.addEventListener('popstate', () => {
  const code = new URL(location.href).searchParams.get('code');
  if (code) submitCode(code, { updateURL: false, focus: false, save: false });
  else { state.parsed = null; $('code-input').value = ''; $('code-error').hidden = true; $('code-input').removeAttribute('aria-invalid'); renderResult(); }
});
renderHistory();
const initialCode = new URL(location.href).searchParams.get('code');
if (initialCode) submitCode(initialCode, { updateURL: false, focus: false });
loadCatalog();
