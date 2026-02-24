# DART Filing Alerts — Rebuilt v2

## What Changed
This is a complete rebuild of the data layer. The previous version was showing incorrect data because:
1. DART API blocks browser requests (CORS) → all API calls silently failed → dashboard showed random demo data
2. The old approach tried to scan bulk filings and match by stock code — unreliable

### New Architecture
- **Proxy downloads CORPCODE.xml** (ZIP file with ALL 90,000+ company codes) from DART
- **Resolves stock_code → corp_code** using the official mapping (e.g., 005930 → 00126380)
- **Fetches filings per company** using the correct corp_code parameter
- **One batch call** from the dashboard does everything

### How It Works
```
Browser → /.netlify/functions/dart-proxy?action=batch&stock_codes=039420,066620,...&bgn_de=20250124&end_de=20260224
                ↓
Proxy downloads CORPCODE.xml ZIP from DART (cached 24h)
                ↓  
Parses XML → builds stock_code → corp_code map
                ↓
For each company: calls /api/list.json?corp_code=XXXXXXXX&bgn_de=...&end_de=...
                ↓
Returns combined, sorted results to browser
```

## Deployment

### 1. Replace ALL files in your GitHub repo
Delete the old files and upload these three:
```
index.html
netlify.toml
netlify/functions/dart-proxy.js
```

### 2. For the function file
Since GitHub's web uploader can't create folders, use "Create new file" and type:
`netlify/functions/dart-proxy.js`
(GitHub auto-creates folders when you type slashes)

### 3. Netlify will auto-deploy
After pushing to GitHub, Netlify will automatically rebuild. The first load may take 5-10 seconds as the proxy downloads and caches the corp code file.

## Debug
- Click the **"Log"** button in the header to see detailed fetch logs
- Open browser console (F12) for additional error details
- The proxy logs to Netlify Functions console (check Netlify dashboard → Functions tab)

## Config
- **Password**: Edit `ACCESS_PASSWORD` in index.html (default: `dart2026`)  
- **API Key**: Edit `API_KEY` in `netlify/functions/dart-proxy.js`
- **Watchlist**: Edit the `WATCHLIST` array in index.html
