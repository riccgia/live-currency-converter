const CURRENCIES = [
  ["USD", "US Dollar"], ["EUR", "Euro"], ["GBP", "British Pound"],
  ["JPY", "Japanese Yen"], ["CHF", "Swiss Franc"], ["CAD", "Canadian Dollar"],
  ["AUD", "Australian Dollar"], ["NZD", "New Zealand Dollar"], ["CNY", "Chinese Yuan"],
  ["HKD", "Hong Kong Dollar"], ["SGD", "Singapore Dollar"], ["INR", "Indian Rupee"],
  ["KRW", "South Korean Won"], ["BRL", "Brazilian Real"], ["MXN", "Mexican Peso"],
  ["ZAR", "South African Rand"], ["SEK", "Swedish Krona"], ["NOK", "Norwegian Krone"],
  ["DKK", "Danish Krone"], ["PLN", "Polish Zloty"], ["TRY", "Turkish Lira"],
  ["AED", "UAE Dirham"], ["SAR", "Saudi Riyal"], ["ILS", "Israeli Shekel"],
  ["THB", "Thai Baht"], ["IDR", "Indonesian Rupiah"], ["PHP", "Philippine Peso"],
  ["MYR", "Malaysian Ringgit"], ["VND", "Vietnamese Dong"], ["RUB", "Russian Ruble"],
];

const $ = (id) => document.getElementById(id);

function populate() {
  const sel = $("target");
  for (const [code, name] of CURRENCIES) {
    const opt = document.createElement("option");
    opt.value = code;
    opt.textContent = `${code} — ${name}`;
    sel.appendChild(opt);
  }
}

async function load() {
  const { target = "EUR", enabled = true, showOriginal = true } =
    await chrome.storage.sync.get(["target", "enabled", "showOriginal"]);
  $("target").value = target;
  $("enabled").checked = enabled;
  $("showOriginal").checked = showOriginal;

  const { ratesUpdatedAt } = await chrome.storage.local.get("ratesUpdatedAt");
  $("status").textContent = ratesUpdatedAt
    ? `Updated ${new Date(ratesUpdatedAt).toLocaleString()}`
    : "No rates yet";
}

async function save() {
  await chrome.storage.sync.set({
    target: $("target").value,
    enabled: $("enabled").checked,
    showOriginal: $("showOriginal").checked,
  });
  notifyActiveTab();
}

async function notifyActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { type: "SETTINGS_CHANGED" });
  } catch {
    // content script may not be injected on this page (chrome://, etc.) — ignore
  }
}

async function refresh() {
  $("status").textContent = "Refreshing…";
  const res = await chrome.runtime.sendMessage({ type: "REFRESH_RATES" });
  if (res?.ok) {
    $("status").textContent = `Updated ${new Date(res.updatedAt).toLocaleString()}`;
    notifyActiveTab();
  } else {
    $("status").textContent = `Error: ${res?.error ?? "unknown"}`;
  }
}

document.addEventListener("DOMContentLoaded", () => {
  populate();
  load();
  $("target").addEventListener("change", save);
  $("enabled").addEventListener("change", save);
  $("showOriginal").addEventListener("change", save);
  $("refresh").addEventListener("click", refresh);
});
