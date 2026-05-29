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
  // "Fr" deliberately omitted — too many false positives ("From 100", "Fr 5pm").
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
  rates: null,    // USD-based
  base: "USD",
};

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

function scan(root) {
  if (!state.enabled || !state.rates) return;
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

function revertAll() {
  for (const span of document.querySelectorAll("span.lc-price[data-lc-converted='1']")) {
    const original = span.dataset.lcOriginal ?? span.textContent;
    span.replaceWith(document.createTextNode(original));
  }
}

let observer = null;

function startObserver() {
  if (observer) return;
  observer = new MutationObserver((mutations) => {
    if (!state.enabled || !state.rates) return;
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (node.nodeType === Node.ELEMENT_NODE) scan(node);
        else if (node.nodeType === Node.TEXT_NODE) processTextNode(node);
      }
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
}

function stopObserver() {
  observer?.disconnect();
  observer = null;
}

async function loadSettings() {
  const sync = await chrome.storage.sync.get(["target", "enabled", "showOriginal"]);
  state.target = sync.target ?? "EUR";
  state.enabled = sync.enabled ?? true;
  state.showOriginal = sync.showOriginal ?? true;
}

async function loadRates() {
  const res = await chrome.runtime.sendMessage({ type: "GET_RATES" });
  if (res?.ok) {
    state.rates = res.rates;
    state.base = res.base;
  }
}

async function init() {
  await loadSettings();
  await loadRates();
  if (state.enabled && state.rates) {
    scan(document.body);
    startObserver();
  }
}

chrome.runtime.onMessage.addListener((msg) => {
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
  }
});

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init, { once: true });
} else {
  init();
}
