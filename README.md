# DART Filing Alerts Dashboard

Real-time Korean FSS (DART) filing alerts for a curated watchlist of 30 companies.

## How It Works

1. **Hardcoded corp_codes**: Each watchlist company has its 8-digit DART `corp_code` embedded in the dashboard. These were extracted from DART's CORPCODE.xml on 2026-02-25.

2. **Per-company batch queries**: The Netlify proxy sends one API request per company using `corp_code`, running 5 in parallel. This is reliable and fast — no scanning/filtering needed.

3. **Proxy architecture**: Browser → Netlify Function → DART API. The proxy adds the API key and handles CORS.

## Files

- `index.html` — Dashboard (login, filing list, detail panel, watchlist sidebar)
- `netlify/functions/dart-proxy.js` — Serverless proxy with batch endpoint
- `netlify.toml` — Netlify config (26s function timeout)

## Deploy

1. Push to GitHub
2. Connect to Netlify
3. Deploy (no build command needed)
4. Password: `dart2026`

## Proxy Endpoints

- `?action=ping` — Health check (tests Samsung lookup)
- `?action=batch&corp_codes=CODE1,CODE2&bgn_de=YYYYMMDD&end_de=YYYYMMDD` — Fetch filings for multiple companies

## Updating the Watchlist

To add/remove companies, you need to:
1. Find the company's `stock_code` (6-digit exchange symbol)
2. Look up the `corp_code` (8-digit DART ID) from CORPCODE.xml
3. Add/remove the entry in the WATCHLIST array in `index.html`
