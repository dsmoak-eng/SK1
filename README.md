# DART Filing Alerts — v3

## Architecture

The previous versions failed because they either tried to download a 25MB ZIP file (timeout) or scan thousands of pages of bulk filings (unreliable).

**v3 takes a completely different approach:**

1. Each watchlist company has a **hardcoded `corp_code`** (DART's 8-digit internal ID) in `index.html`
2. The Netlify function is a **thin proxy** — one call = one DART API request for one company
3. The **frontend calls the proxy 30 times in parallel** (browser handles this efficiently)
4. Each proxy call takes ~1-2 seconds, well within Netlify's 10-second function timeout

```
Browser loads → For each of 30 companies:
  fetch(/.netlify/functions/dart-proxy?action=filings&corp_code=00425898&bgn_de=...&end_de=...)
    → Proxy calls https://opendart.fss.or.kr/api/list.json?corp_code=00425898&...
    → Returns JSON filings for that one company
Browser collects all 30 responses → Merges, sorts, displays
```

## Files

```
index.html                          ← Dashboard + watchlist config
netlify.toml                        ← Netlify config
netlify/functions/dart-proxy.js     ← Simple DART API proxy
```

## Deployment

1. Replace ALL files in your GitHub repo with these
2. For `dart-proxy.js`: Use GitHub's "Create new file" and type `netlify/functions/dart-proxy.js` as the filename (GitHub creates folders automatically)
3. Netlify auto-deploys on push

## Config

- **Password**: Edit `ACCESS_PASSWORD` in `index.html` (default: `dart2026`)
- **API Key**: Edit `API_KEY` in `netlify/functions/dart-proxy.js`
- **Watchlist**: Edit the `WATCHLIST` array in `index.html`

### Finding corp_codes for new companies

If you add a company to the watchlist, you need its DART corp_code. You can look this up by downloading CORPCODE.xml from DART, or by searching on the DART website. The corp_code is an 8-digit number (e.g., `00126380` for Samsung Electronics).

If a corp_code is wrong, the log will show a DART error for that company.

## Troubleshooting

- Click **"Log"** to see per-company fetch results
- Open browser console (F12) for network errors
- Check Netlify Functions tab for server-side logs
- If a company shows "DART error", its corp_code may be wrong
