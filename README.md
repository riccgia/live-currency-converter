# Live Currency Converter

A Chrome extension (Manifest V3) that scans any webpage for prices and rewrites them in your preferred currency using live exchange rates.

## Features

- Detects common currency symbols (`$`, `€`, `£`, `¥`, `₹`, `₩`, `₽`, `R$`, `A$`, `C$`, `HK$`, etc.) and ISO codes (`USD`, `EUR`, `GBP`, ...).
- Handles both `1,234.56` and `1.234,56` number formats.
- Picks up dynamically-loaded prices via `MutationObserver`.
- Hover any converted price to see the original.
- Cached FX rates refresh every 6 hours (open.er-api.com, no API key needed).

## Install (local development)

1. Open `chrome://extensions`.
2. Enable **Developer mode** (top right).
3. Click **Load unpacked** and select this folder.
4. Open the popup, pick your target currency, and browse.

## Project layout

```
manifest.json            MV3 manifest
background/
  service-worker.js      Fetches and caches FX rates
content/
  content.js             Scans DOM, rewrites prices
  content.css            Styles for converted prices
popup/
  popup.html / .css / .js  User settings UI
```

## Notes

- Ambiguous symbols default to the most common currency: `$` → USD, `¥` → JPY, `kr` → SEK.
- The extension reverts and re-scans the page whenever you change settings in the popup.
- Rates source: [open.er-api.com](https://open.er-api.com).
