// Content script: scans visible text for prices and rewrites them in the user's target currency.

const SYMBOL_TO_CODE = {
  "$": "USD",
  "US$": "USD",
  "C$": "CAD", "CA$": "CAD",
  "A$": "AUD", "AU$": "AUD",
  "NZ$": "NZD",
  "HK$": "HKD",
  "S$": "SGD",
  "NT$": "TWD",
  "R$": "BRL",
  "Mex$": "MXN",
  "€": "EUR",
  "£": "GBP",
  "¥": "JPY",
  "₹": "INR",
  "₩": "KRW",
  "₽": "RUB",
  "₺": "TRY",
  "₪": "ILS",
  "₫": "VND",
  "฿": "THB",
  "₱": "PHP",
  "د.إ": "AED",
  "﷼": "SAR",
  "zł": "PLN",
  "kr": "SEK", // ambiguous with NOK/DKK; default SEK
  "CHF": "CHF",
  "Fr.": "CHF",   // Swiss franc — require the period; bare "Fr" matches "From"/"Friday"
  "SFr.": "CHF",  // older Swiss-franc notation
  "RM": "MYR",    // Malaysian Ringgit — Google often shows these in cross-region results
  "Rp": "IDR",    // Indonesian Rupiah
  "Rs.": "INR",   // Indian Rupee (preferred form, period)
  "Rs": "INR",    // Indian Rupee (no period)
  "Kč": "CZK",    // Czech Koruna — Czech-specific glyph, unambiguous
  "₴": "UAH",
  "₸": "KZT",
  "₦": "NGN",
};

// Currencies whose conventional formatting uses comma as decimal separator.
const COMMA_DECIMAL_CURRENCIES = new Set([
  "EUR","BRL","RUB","TRY","SEK","NOK","DKK","PLN","CZK","HUF","RON",
  "ARS","COP","IDR","VND","UAH","KZT",
]);

// Currencies whose prices are conventionally written without fractional digits.
const ZERO_DECIMAL_CURRENCIES = new Set([
  "JPY","KRW","IDR","VND","CLP","HUF","ISK","TWD",
]);

// Page locale convention (used to disambiguate "1,234" vs "1.234").
function isCommaDecimalLocale() {
  const lang = (document.documentElement.lang || navigator.language || "en").toLowerCase();
  const commaLangs = [
    "de","fr","es","it","nl","pt","pl","ru","tr","cs","hu","ro","sv","no","nb","nn",
    "da","fi","el","uk","sk","sl","hr","bg","et","lv","lt","id","vi","af","is","ca",
  ];
  return commaLangs.some((l) => lang === l || lang.startsWith(l + "-"));
}
const PAGE_COMMA_DECIMAL = isCommaDecimalLocale();

// Order matters: longer/multi-char symbols first so they win the regex alternation.
const SYMBOLS_SORTED = Object.keys(SYMBOL_TO_CODE).sort((a, b) => b.length - a.length);

// 3-letter ISO codes we'll accept when written next to a number.
const ISO_CODES = new Set([
  "USD","EUR","GBP","JPY","CHF","CAD","AUD","NZD","CNY","HKD","SGD","INR",
  "KRW","BRL","MXN","ZAR","SEK","NOK","DKK","PLN","TRY","AED","SAR","ILS",
  "THB","IDR","PHP","MYR","VND","RUB","TWD","CZK","HUF","RON","ARS","CLP",
  "COP","PEN","EGP","NGN","PKR","BDT","LKR","KZT","UAH",
]);

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Build the master price regex once. Captures either a leading symbol or trailing/leading ISO code.
const SYMBOL_ALT = SYMBOLS_SORTED.map(escapeRe).join("|");
const ISO_ALT = [...ISO_CODES].join("|");
// Thousands separators: `.` `,` `'` (Swiss), `\s` (covers regular/NBSP/thin/narrow no-break spaces).
// Followed by groups of 3 digits, or 2-3 for Indian lakh/crore grouping.
const NUMBER = "\\d{1,3}(?:[.,'\\s]\\d{2,3})*(?:[.,]\\d+)?|\\d+(?:[.,]\\d+)?";

const PRICE_RE = new RegExp(
  // Leading symbol: $ 1,234.56
  `(?:(?<sym>${SYMBOL_ALT})\\s?(?<numA>${NUMBER}))` +
  // Trailing symbol or code: 1.234,56 € | 12.99 USD
  `|(?:(?<numB>${NUMBER})\\s?(?<code>${SYMBOL_ALT}|${ISO_ALT}))` +
  // Leading code: USD 12.99
  `|(?:(?<codeL>${ISO_ALT})\\s?(?<numC>${NUMBER}))`,
  "g"
);

let state = {
  enabled: true,
  target: "EUR",
  showOriginal: true,
  debug: false,
  rates: null,    // USD-based
  base: "USD",
  lastError: null,
};

const log = (...args) => { if (state.debug) console.log("[lc-converter]", ...args); };

function parseAmount(raw, currencyCode) {
  // Strip whitespace (regular, NBSP, narrow/thin no-break) and Swiss apostrophe.
  const s = raw.replace(/[\s']/g, "");
  if (!s) return NaN;

  const dotCount = (s.match(/\./g) || []).length;
  const commaCount = (s.match(/,/g) || []).length;

  // No separators -> plain integer.
  if (dotCount === 0 && commaCount === 0) return parseFloat(s);

  // Both kinds present -> the LAST occurrence is decimal, the other is thousands.
  if (dotCount > 0 && commaCount > 0) {
    const lastDot = s.lastIndexOf(".");
    const lastComma = s.lastIndexOf(",");
    return lastDot > lastComma
      ? parseFloat(s.replace(/,/g, ""))
      : parseFloat(s.replace(/\./g, "").replace(",", "."));
  }

  // Only one type of separator present.
  const sep = dotCount > 0 ? "." : ",";
  const count = dotCount + commaCount;
  const afterLast = s.length - s.lastIndexOf(sep) - 1;

  // Multiple of the same separator -> must be thousands (decimals can't repeat).
  if (count > 1) return parseFloat(s.split(sep).join(""));

  // Single separator. If not exactly 3 trailing digits, it's decimal (1, 2, or 4+).
  if (afterLast !== 3) {
    return parseFloat(sep === "," ? s.replace(",", ".") : s);
  }

  // Ambiguous: "1,234" or "1.234". Resolve with currency + page-locale heuristics.
  if (ZERO_DECIMAL_CURRENCIES.has(currencyCode)) {
    return parseFloat(s.split(sep).join(""));
  }
  const sepIsDecimal =
    (sep === "," && PAGE_COMMA_DECIMAL) || (sep === "." && !PAGE_COMMA_DECIMAL);
  if (sepIsDecimal) {
    return parseFloat(sep === "," ? s.replace(",", ".") : s);
  }
  return parseFloat(s.split(sep).join(""));
}


function detectCode(match) {
  const g = match.groups;
  const token = g.sym || g.code || g.codeL;
  if (!token) return null;
  if (ISO_CODES.has(token.toUpperCase())) return token.toUpperCase();
  return SYMBOL_TO_CODE[token] || null;
}

function convert(amount, fromCode) {
  if (!state.rates) return null;
  if (fromCode === state.target) return null;
  const fromRate = fromCode === state.base ? 1 : state.rates[fromCode];
  const toRate = state.target === state.base ? 1 : state.rates[state.target];
  if (!fromRate || !toRate) return null;
  // amount is in `fromCode`. Convert via base (USD).
  const inBase = amount / fromRate;
  return inBase * toRate;
}

function formatTarget(amount) {
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: state.target,
      maximumFractionDigits: amount >= 100 ? 0 : 2,
    }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${state.target}`;
  }
}

// Skip nodes inside these elements.
const SKIP_TAGS = new Set([
  "SCRIPT","STYLE","NOSCRIPT","TEXTAREA","INPUT","SELECT","OPTION",
  "CODE","PRE","KBD","SAMP","VAR",
]);

// Block-level elements: the inline-wrapper aggregator stops descending at these
// so we don't merge text from neighbouring layout regions into one "price".
const BLOCK_TAGS = new Set([
  "ADDRESS","ARTICLE","ASIDE","BLOCKQUOTE","CANVAS","DD","DETAILS","DIALOG",
  "DIV","DL","DT","FIELDSET","FIGCAPTION","FIGURE","FOOTER","FORM","H1","H2","H3",
  "H4","H5","H6","HEADER","HGROUP","HR","LI","MAIN","NAV","OL","P","SECTION",
  "TABLE","TBODY","TD","TFOOT","TH","THEAD","TR","UL","VIDEO",
]);

function shouldSkip(node) {
  let el = node.parentElement;
  while (el) {
    if (SKIP_TAGS.has(el.tagName)) return true;
    if (el.isContentEditable) return true;
    if (el.dataset && el.dataset.lcConverted === "1") return true;
    el = el.parentElement;
  }
  return false;
}

function processTextNode(node) {
  const text = node.nodeValue;
  if (!text || text.length < 2) return;
  if (!/\d/.test(text)) return;
  if (shouldSkip(node)) return;

  PRICE_RE.lastIndex = 0;
  let match;
  let lastIndex = 0;
  let frag = null;

  while ((match = PRICE_RE.exec(text)) !== null) {
    const raw = match.groups.numA || match.groups.numB || match.groups.numC;
    const fromCode = detectCode(match);
    if (!raw || !fromCode) continue;
    const amount = parseAmount(raw, fromCode);
    if (!Number.isFinite(amount)) continue;
    const converted = convert(amount, fromCode);
    if (converted == null) continue;

    if (!frag) frag = document.createDocumentFragment();
    if (match.index > lastIndex) {
      frag.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
    }
    const span = document.createElement("span");
    span.className = "lc-price";
    span.dataset.lcConverted = "1";
    span.dataset.lcOriginal = match[0];
    span.textContent = formatTarget(converted);
    if (state.showOriginal) {
      span.title = `Original: ${match[0]}`;
    }
    frag.appendChild(span);
    lastIndex = match.index + match[0].length;
  }

  if (frag) {
    if (lastIndex < text.length) {
      frag.appendChild(document.createTextNode(text.slice(lastIndex)));
    }
    node.parentNode.replaceChild(frag, node);
  }
}

function scanTextNodes(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      if (!n.nodeValue || !/\d/.test(n.nodeValue)) return NodeFilter.FILTER_REJECT;
      if (shouldSkip(n)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const nodes = [];
  let n;
  while ((n = walker.nextNode())) nodes.push(n);
  for (const node of nodes) processTextNode(node);
}

// Aggregate inline text under `el`, stopping at block / skipped / already-converted
// boundaries. Returns the combined string and a segment map back to text nodes.
function getInlineTextSegments(el) {
  const segments = [];
  let agg = "";
  function walk(node) {
    if (node.nodeType === Node.TEXT_NODE) {
      segments.push({ node, start: agg.length });
      agg += node.nodeValue;
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const tag = node.tagName;
    if (SKIP_TAGS.has(tag) || BLOCK_TAGS.has(tag)) return;
    if (node.dataset && node.dataset.lcConverted === "1") return;
    if (tag === "BR") { agg += "\n"; return; }
    for (const child of node.childNodes) walk(child);
  }
  for (const child of el.childNodes) walk(child);
  return { agg, segments };
}

function buildConvertedSpan(originalText, convertedText) {
  const span = document.createElement("span");
  span.className = "lc-price";
  span.dataset.lcConverted = "1";
  span.dataset.lcOriginal = originalText;
  span.textContent = convertedText;
  if (state.showOriginal) span.title = `Original: ${originalText}`;
  return span;
}

// Second-pass scan: handles prices split across multiple text nodes (Amazon's
// `<span>$</span><span>10</span>.<span>99</span>` and similar). Walks elements
// bottom-up so the innermost inline wrapper containing the full price wins.
function scanInlineWrappers(root) {
  if (root.nodeType !== Node.ELEMENT_NODE) return;
  // Process descendants bottom-up, then root itself last, so an innermost
  // inline wrapper always wins over an outer one with the same agg.
  const elements = [...Array.from(root.querySelectorAll("*")).reverse(), root];
  for (const el of elements) {
    if (SKIP_TAGS.has(el.tagName)) continue;
    if (el.dataset.lcConverted === "1") continue;
    if (el.childElementCount === 0) continue; // pure text — text-node pass handled it
    if (!el.isConnected) continue;            // may have been removed by an earlier replacement

    const tc = el.textContent;
    if (!tc || tc.length > 200 || !/\d/.test(tc)) continue;

    const { agg, segments } = getInlineTextSegments(el);
    if (!agg || segments.length < 2 || !/\d/.test(agg)) continue;

    PRICE_RE.lastIndex = 0;
    let m;
    while ((m = PRICE_RE.exec(agg)) !== null) {
      const raw = m.groups.numA || m.groups.numB || m.groups.numC;
      const fromCode = detectCode(m);
      if (!raw || !fromCode) continue;
      const amount = parseAmount(raw, fromCode);
      if (!Number.isFinite(amount)) continue;
      const converted = convert(amount, fromCode);
      if (converted == null) continue;

      const matchStart = m.index;
      const matchEnd = m.index + m[0].length;
      const overlap = segments.filter(
        (s) => s.start < matchEnd && s.start + s.node.nodeValue.length > matchStart
      );
      if (overlap.length < 2) continue; // single text node — leave to text-node pass

      const span = buildConvertedSpan(m[0], formatTarget(converted));
      const remaining = (agg.slice(0, matchStart) + agg.slice(matchEnd)).trim();

      if (remaining.length < 4) {
        // Element is essentially a price wrapper — replace its content entirely
        // (kills inner styling spans but produces a clean visible price).
        while (el.firstChild) el.removeChild(el.firstChild);
        const before = agg.slice(0, matchStart);
        const after = agg.slice(matchEnd);
        if (before) el.appendChild(document.createTextNode(before));
        el.appendChild(span);
        if (after) el.appendChild(document.createTextNode(after));
      } else {
        // Surrounding text matters — splice the span across the overlap nodes.
        const first = overlap[0];
        const last = overlap[overlap.length - 1];
        const firstBefore = first.node.nodeValue.slice(0, matchStart - first.start);
        const lastAfter = last.node.nodeValue.slice(matchEnd - last.start);
        first.node.nodeValue = firstBefore;
        first.node.parentNode.insertBefore(span, first.node.nextSibling);
        for (let i = 1; i < overlap.length - 1; i++) {
          overlap[i].node.nodeValue = "";
        }
        last.node.nodeValue = lastAfter;
      }
      break; // segments are now stale; outer iteration continues with other elements
    }
  }
}

function scan(root) {
  if (!state.enabled || !state.rates) return;
  // Wrapper pass first so it can collapse split prices before the text-node pass
  // (otherwise we'd waste work converting an offscreen copy then re-doing the visible parts).
  if (root.nodeType === Node.ELEMENT_NODE) scanInlineWrappers(root);
  scanTextNodes(root);
}

function revertAll() {
  for (const span of document.querySelectorAll("span.lc-price[data-lc-converted='1']")) {
    const original = span.dataset.lcOriginal ?? span.textContent;
    span.replaceWith(document.createTextNode(original));
  }
}

let observer = null;
let mutationFlushQueued = false;
const pendingElements = new Set();
const pendingTextNodes = new Set();

function flushMutations() {
  mutationFlushQueued = false;
  if (!state.enabled || !state.rates) {
    pendingElements.clear();
    pendingTextNodes.clear();
    return;
  }
  const els = Array.from(pendingElements);
  const texts = Array.from(pendingTextNodes);
  pendingElements.clear();
  pendingTextNodes.clear();
  for (const el of els) {
    if (el.isConnected) scan(el);
  }
  for (const tn of texts) {
    if (tn.isConnected) processTextNode(tn);
  }
}

function startObserver() {
  if (observer) return;
  observer = new MutationObserver((mutations) => {
    if (!state.enabled || !state.rates) return;
    for (const m of mutations) {
      if (m.type === "childList") {
        for (const node of m.addedNodes) {
          if (node.nodeType === Node.ELEMENT_NODE) {
            // Skip spans we just inserted — avoids a feedback loop where our
            // own DOM writes re-enter the scanner.
            if (node.dataset && node.dataset.lcConverted === "1") continue;
            pendingElements.add(node);
          } else if (node.nodeType === Node.TEXT_NODE) {
            pendingTextNodes.add(node);
          }
        }
      } else if (m.type === "characterData") {
        if (m.target.nodeType === Node.TEXT_NODE) pendingTextNodes.add(m.target);
      }
    }
    if (!mutationFlushQueued && (pendingElements.size || pendingTextNodes.size)) {
      mutationFlushQueued = true;
      // Coalesce bursts (e.g. a price ticker emitting many updates per frame).
      (window.requestIdleCallback || ((cb) => setTimeout(cb, 50)))(flushMutations);
    }
  });
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true,
  });
}

function stopObserver() {
  observer?.disconnect();
  observer = null;
}

async function loadSettings() {
  const sync = await chrome.storage.sync.get(["target", "enabled", "showOriginal", "debug"]);
  state.target = sync.target ?? "EUR";
  state.enabled = sync.enabled ?? true;
  state.showOriginal = sync.showOriginal ?? true;
  state.debug = !!sync.debug;
  log("settings loaded", { target: state.target, enabled: state.enabled, debug: state.debug });
}

async function loadRates() {
  try {
    const res = await chrome.runtime.sendMessage({ type: "GET_RATES" });
    if (res?.ok) {
      state.rates = res.rates;
      state.base = res.base;
      state.lastError = null;
      log("rates loaded", { base: state.base, sample: { EUR: res.rates.EUR, GBP: res.rates.GBP, JPY: res.rates.JPY } });
    } else {
      state.lastError = res?.error || "rates fetch failed";
      log("rates fetch failed", state.lastError);
    }
  } catch (e) {
    state.lastError = String(e?.message || e);
    log("rates fetch threw", state.lastError);
  }
}

function countConverted() {
  return document.querySelectorAll("span.lc-price[data-lc-converted='1']").length;
}

async function init() {
  await loadSettings();
  await loadRates();
  // Retry a few times with backoff if the service worker hasn't fetched rates yet
  // (cold start, slow network). Without this, the page silently never converts.
  let attempt = 0;
  while (state.enabled && !state.rates && attempt < 4) {
    attempt++;
    await new Promise((r) => setTimeout(r, 1000 * attempt));
    await loadRates();
  }
  if (state.enabled && state.rates) {
    scan(document.body);
    startObserver();
    log("initial scan done:", countConverted(), "prices converted; target =", state.target);
  } else {
    log("init skipped — enabled:", state.enabled, "rates:", !!state.rates, "lastError:", state.lastError);
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "SETTINGS_CHANGED") {
    (async () => {
      revertAll();
      stopObserver();
      await loadSettings();
      await loadRates();
      if (state.enabled && state.rates) {
        scan(document.body);
        startObserver();
      }
    })();
    return false;
  }
  if (msg?.type === "RESCAN") {
    (async () => {
      revertAll();
      stopObserver();
      await loadRates(); // pick up any newly fetched rates too
      if (state.enabled && state.rates) {
        scan(document.body);
        startObserver();
      }
      log("manual rescan complete:", countConverted(), "prices converted");
      sendResponse({ ok: true, converted: countConverted() });
    })();
    return true;
  }
  if (msg?.type === "GET_STATUS") {
    sendResponse({
      ok: true,
      enabled: state.enabled,
      target: state.target,
      base: state.base,
      ratesLoaded: !!state.rates,
      convertedCount: countConverted(),
      lastError: state.lastError,
      pageLocale: document.documentElement.lang || navigator.language || null,
      pageCommaDecimal: PAGE_COMMA_DECIMAL,
    });
    return false;
  }
  return false;
});

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init, { once: true });
} else {
  init();
}
