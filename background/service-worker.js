// Background service worker: fetches and caches FX rates, serves them to the content script.

const RATES_URL = "https://open.er-api.com/v6/latest/USD";
const REFRESH_MS = 6 * 60 * 60 * 1000; // 6 hours

async function fetchRates() {
  const res = await fetch(RATES_URL, { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if (data.result !== "success" || !data.rates) {
    throw new Error("Invalid response");
  }
  const updatedAt = Date.now();
  await chrome.storage.local.set({
    rates: data.rates,        // base USD: { EUR: 0.92, GBP: 0.79, ... }
    base: data.base_code,     // "USD"
    ratesUpdatedAt: updatedAt,
  });
  return { rates: data.rates, base: data.base_code, updatedAt };
}

async function getRates({ force = false } = {}) {
  const { rates, base, ratesUpdatedAt } = await chrome.storage.local.get([
    "rates", "base", "ratesUpdatedAt",
  ]);
  const stale = !ratesUpdatedAt || Date.now() - ratesUpdatedAt > REFRESH_MS;
  if (force || stale || !rates) {
    return fetchRates();
  }
  return { rates, base, updatedAt: ratesUpdatedAt };
}

// Pick a sensible default target currency from the user's browser locale, so a
// Swiss user lands on CHF and a US user lands on USD without having to discover
// the popup. Falls back to USD for unknown regions.
function defaultTargetForLocale() {
  const lang = ((self.navigator && self.navigator.language) || "en-US").toLowerCase();
  const region = (lang.split("-")[1] || "").toLowerCase();
  const map = {
    us: "USD", gb: "GBP", uk: "GBP",
    ie: "EUR", de: "EUR", fr: "EUR", es: "EUR", it: "EUR", nl: "EUR", be: "EUR",
    pt: "EUR", at: "EUR", gr: "EUR", fi: "EUR", lu: "EUR", mt: "EUR", cy: "EUR",
    sk: "EUR", si: "EUR", ee: "EUR", lv: "EUR", lt: "EUR", hr: "EUR",
    ch: "CHF", li: "CHF",
    jp: "JPY", cn: "CNY", hk: "HKD", tw: "TWD", sg: "SGD",
    au: "AUD", nz: "NZD", ca: "CAD",
    in: "INR", br: "BRL", mx: "MXN", kr: "KRW", tr: "TRY", ru: "RUB",
    pl: "PLN", cz: "CZK", hu: "HUF", ro: "RON", bg: "BGN",
    se: "SEK", no: "NOK", dk: "DKK", is: "ISK",
    za: "ZAR", il: "ILS", ae: "AED", sa: "SAR",
    th: "THB", id: "IDR", ph: "PHP", my: "MYR", vn: "VND",
    ua: "UAH", ge: "GEL", kz: "KZT",
    ng: "NGN", eg: "EGP", ke: "KES", ma: "MAD",
    ar: "ARS", cl: "CLP", co: "COP", pe: "PEN",
  };
  return map[region] || "USD";
}

chrome.runtime.onInstalled.addListener(async () => {
  // Seed defaults; fire-and-forget rate fetch.
  const existing = await chrome.storage.sync.get(["target", "enabled", "showOriginal"]);
  await chrome.storage.sync.set({
    target: existing.target ?? defaultTargetForLocale(),
    enabled: existing.enabled ?? true,
    showOriginal: existing.showOriginal ?? true,
  });
  getRates().catch((e) => console.warn("Initial rates fetch failed", e));
  chrome.alarms.create("refreshRates", { periodInMinutes: 360 });
});

chrome.alarms?.onAlarm.addListener((alarm) => {
  if (alarm.name === "refreshRates") {
    getRates({ force: true }).catch((e) => console.warn("Scheduled refresh failed", e));
  }
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      if (msg?.type === "GET_RATES") {
        const r = await getRates();
        sendResponse({ ok: true, ...r });
      } else if (msg?.type === "REFRESH_RATES") {
        const r = await fetchRates();
        sendResponse({ ok: true, ...r });
      } else {
        sendResponse({ ok: false, error: "Unknown message" });
      }
    } catch (e) {
      sendResponse({ ok: false, error: String(e?.message ?? e) });
    }
  })();
  return true; // async response
});
