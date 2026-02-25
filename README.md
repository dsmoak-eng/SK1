# DART Filing Alerts — v3 (Fixed)

## What Was Wrong (v2)
The previous version had several critical issues:

1. **No corp_code resolution**: The DART API's `/api/list.json` endpoint works best when queried **per-company** using `corp_code` (an 8-digit internal ID). Without it, the search period is limited to 3 months and returns filings for ALL ~90,000 companies. The old code tried to scan through bulk results filtering by `stock_code`, but with thousands of pages this was unreliable and most watchlist companies were missed.

2. **Wrong approach**: Scanning 10 pages (1,000 filings) out of potentially hundreds of thousands meant the dashboard would randomly show some filings and miss others entirely.

3. **README described architecture that wasn't implemented**: The README mentioned downloading CORPCODE.xml for stock→corp code mapping, but the actual proxy code never did this.

## How v3 Works

```
Browser → /.netlify/functions/dart-proxy?action=batch&stock_codes=039420,066620,...&bgn_de=20250101&end_de=20260225
                ↓
Step 1: Proxy downloads CORPCODE.xml ZIP from DART (cached 24h in memory)
                ↓
Step 2: Parses XML → builds stock_code → corp_code map
        e.g. 005930 → 00126380 (Samsung Electronics)
                ↓
Step 3: For EACH watchlist company, calls:
        /api/list.json?corp_code=XXXXXXXX&bgn_de=...&end_de=...
        (5 companies in parallel to avoid rate limits)
                ↓
Step 4: Combines all results, sorts by date, returns to browser
```

### Key Differences from v2
- **Per-company queries** using resolved `corp_code` → accurate, complete results
- **ZIP download + XML parsing** built into the proxy with no external dependencies
- **Parallel fetching** with batching (5 at a time) for speed without API abuse
- **Debug endpoint**: `?action=resolve&stock_codes=...` to verify corp_code mapping

## Deployment

### 1. Replace ALL files in your GitHub repo

Your repo should contain exactly:
```
index.html
netlify.toml
netlify/functions/dart-proxy.js
```

### 2. Creating the function file on GitHub

Since GitHub's web uploader can't create folders, use **"Create new file"** and type:
```
netlify/functions/dart-proxy.js
```
GitHub auto-creates the `netlify/functions/` folders when you type slashes.

### 3. Netlify will auto-deploy

After pushing to GitHub, Netlify will automatically rebuild. The **first load may take 10-15 seconds** as the proxy downloads the corp code file (~25MB ZIP). Subsequent loads will be faster as the corp code map is cached in memory for 24 hours.

## API Endpoints

### `?action=ping`
Health check. Returns `{ status: "ok" }`.

### `?action=batch&stock_codes=...&bgn_de=...&end_de=...`
Main endpoint. Resolves stock codes, fetches filings per-company, returns combined results.

### `?action=resolve&stock_codes=...`
Debug endpoint. Shows how stock codes map to corp codes without fetching filings.

## Debug
- Click the **"Log"** button in the header to see detailed fetch logs
- Open browser console (F12) for additional error details
- Check Netlify dashboard → Functions tab for server-side logs
- Use `?action=resolve` to verify corp code mapping for your watchlist

## Config
- **Password**: Edit `ACCESS_PASSWORD` in index.html (default: `dart2026`)
- **API Key**: Edit `API_KEY` in `netlify/functions/dart-proxy.js`
- **Watchlist**: Edit the `WATCHLIST` array in index.html

## Troubleshooting

### "Proxy not reachable"
- Make sure `netlify/functions/dart-proxy.js` exists at the correct path in your repo
- Check Netlify deploy logs for build errors

### "Failed to parse DART response" or ZIP errors
- Your API key may be invalid or expired. Get a new one from https://opendart.fss.or.kr
- DART may be temporarily down

### Some companies show 0 filings
- They may genuinely have no filings in the selected date range
- Use `?action=resolve` to check if their stock code maps correctly
- Some very small companies may not file frequently

### Function timeout
- With 30 companies, the batch fetch can take 10-20 seconds
- Netlify free tier has a 10-second timeout; if this is an issue, consider upgrading or reducing the watchlist
- The corp code map is cached after first download, so subsequent calls are faster
