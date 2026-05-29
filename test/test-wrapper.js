// Quick fixture test for the split-text-node (wrapper) scan path.
// Mounts the content script into jsdom, stubs chrome.* APIs, and verifies
// that the rewriter handles common real-world price markups.

const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const html = `<!doctype html><html lang="en"><body>
  <div id="case-single"><span>$10.99</span></div>
  <div id="case-amazon"><span class="a-price">
    <span class="a-offscreen">$10.99</span>
    <span aria-hidden="true">
      <span class="a-price-symbol">$</span><span class="a-price-whole">10</span><span class="a-price-decimal">.</span><span class="a-price-fraction">99</span>
    </span>
  </span></div>
  <div id="case-google-shopping"><span>$<span>24</span>.<span>99</span></span></div>
  <div id="case-with-surround"><span>You pay <span>$</span><span>10.99</span> today</span></div>
  <div id="case-eu"><span>1.234,56&nbsp;€</span></div>
  <div id="case-jpy">¥1,000</div>
  <div id="case-chf-iso">CHF 24.90</div>
  <div id="case-chf-fr">Fr. 24.90</div>
  <div id="case-chf-fr-nbsp">Fr.&nbsp;24.90</div>
  <div id="case-fr-false-positive">From 100 friends online</div>
  <div id="case-myr"><span class="lmQWe" aria-label="Current price: RM&nbsp;20.65. ">RM&nbsp;20.65</span></div>
  <div id="case-idr">Rp 50.000</div>
  <div id="case-inr">Rs. 1,500</div>

  <!-- Microdata: visible text has no symbol, currency comes from a sibling -->
  <div id="case-microdata" itemscope itemtype="https://schema.org/Product">
    <meta itemprop="priceCurrency" content="CHF">
    <span itemprop="price" content="49.90">49.90</span>
  </div>

  <!-- Aria-label cleanly holds the price even though visible text is fragmented -->
  <div id="case-aria">
    <span aria-label="Current price: $24.99"><i class="ico"></i>24.99</span>
  </div>

  <!-- JSON-LD declares the page's currency hint (CHF), then a bare number -->
  <script type="application/ld+json">
    {"@context":"https://schema.org","@type":"Product","offers":{"@type":"Offer","price":"79.00","priceCurrency":"CHF"}}
  </script>
  <div id="case-jsonld" itemscope itemtype="https://schema.org/Product">
    <span itemprop="price" content="79.00">79.00</span>
  </div>
</body></html>`;

const dom = new JSDOM(html, { url: "https://example.com/" });
const { window } = dom;

// Pre-populate stubs that the content script reads from at import-time.
// Target GBP so every fixture below exercises a real conversion
// (an EUR-source price with target=EUR would correctly be a no-op).
const fakeStorageSync = { target: "GBP", enabled: true, showOriginal: true };
const fakeStorageLocal = {
  rates: { EUR: 0.9, USD: 1, JPY: 150, GBP: 0.8, CHF: 0.88, MYR: 4.7, IDR: 16000, INR: 85 },
  base: "USD",
};

global.window = window;
global.document = window.document;
global.navigator = window.navigator;
global.Node = window.Node;
global.NodeFilter = window.NodeFilter;
global.MutationObserver = window.MutationObserver;
global.HTMLElement = window.HTMLElement;
global.Intl = Intl;

global.chrome = {
  storage: {
    sync: { get: (_keys) => Promise.resolve(fakeStorageSync) },
    local: { get: (_keys) => Promise.resolve(fakeStorageLocal) },
  },
  runtime: {
    sendMessage: (msg) => {
      if (msg.type === "GET_RATES") {
        return Promise.resolve({ ok: true, rates: fakeStorageLocal.rates, base: "USD" });
      }
      return Promise.resolve({ ok: false });
    },
    onMessage: { addListener: () => {} },
  },
};

// Load the content script source.
const srcPath = path.join(__dirname, "..", "content", "content.js");
const src = fs.readFileSync(srcPath, "utf8");
// Strip the bottom auto-init block so we can drive init manually.
const stripped = src.replace(/if \(document\.readyState[\s\S]*$/m, "");
// Expose internals for testing.
const wrapped =
  stripped +
  "\nmodule.exports = { init, scan, PRICE_RE, scanInlineWrappers, scanTextNodes };\n";

// Evaluate as CommonJS module
const Module = require("module");
const m = new Module(srcPath);
m._compile(wrapped, srcPath);
const api = m.exports;

(async () => {
  await api.init();

  const cases = [
    {
      id: "case-single",
      label: "single text node `<span>$10.99</span>`",
      expectConverted: true,
    },
    {
      id: "case-amazon",
      label: "Amazon split markup",
      expectConverted: true,
    },
    {
      id: "case-google-shopping",
      label: "Google Shopping split: `$<span>24</span>.<span>99</span>`",
      expectConverted: true,
    },
    {
      id: "case-with-surround",
      label: "split price with surrounding text",
      expectConverted: true,
      expectSurround: true,
    },
    {
      id: "case-eu",
      label: "EU format `1.234,56 €`",
      expectConverted: true,
    },
    {
      id: "case-jpy",
      label: "JPY `¥1,000`",
      expectConverted: true,
    },
    {
      id: "case-chf-iso",
      label: "Swiss `CHF 24.90`",
      expectConverted: true,
    },
    {
      id: "case-chf-fr",
      label: "Swiss `Fr. 24.90`",
      expectConverted: true,
    },
    {
      id: "case-chf-fr-nbsp",
      label: "Swiss `Fr.\\u00A024.90`",
      expectConverted: true,
    },
    {
      id: "case-fr-false-positive",
      label: "`From 100 friends` (should NOT convert)",
      expectConverted: false,
    },
    {
      id: "case-myr",
      label: "Malaysian `RM\\u00A020.65` (Google Shopping markup)",
      expectConverted: true,
    },
    {
      id: "case-idr",
      label: "Indonesian `Rp 50.000`",
      expectConverted: true,
    },
    {
      id: "case-inr",
      label: "Indian `Rs. 1,500`",
      expectConverted: true,
    },
    {
      id: "case-microdata",
      label: "Microdata itemprop=\"price\" (no symbol in DOM text)",
      expectConverted: true,
    },
    {
      id: "case-aria",
      label: "Price taken from aria-label",
      expectConverted: true,
    },
    {
      id: "case-jsonld",
      label: "JSON-LD declares CHF; bare 79.00 number converts",
      expectConverted: true,
    },
  ];

  let pass = 0, fail = 0;
  for (const c of cases) {
    const el = document.getElementById(c.id);
    const hasConverted = !!el.querySelector("span.lc-price[data-lc-converted='1']");
    let ok = hasConverted === c.expectConverted;
    let detail = "";

    if (ok && c.expectSurround) {
      const text = el.textContent;
      ok = text.includes("You pay") && text.includes("today");
      if (!ok) detail = ` (surrounding text lost: "${text}")`;
    }

    if (ok && hasConverted) {
      const conv = el.querySelector("span.lc-price").textContent;
      detail += ` -> "${conv}"`;
    }

    console.log((ok ? "PASS" : "FAIL").padEnd(5), c.label.padEnd(48), detail);
    ok ? pass++ : fail++;
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
