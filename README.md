# DART Filing Alerts — Deployment Guide

## Project Structure
```
dart-site/
├── index.html                          ← Dashboard (the entire frontend)
├── netlify.toml                        ← Netlify config
└── netlify/functions/
    └── dart-proxy.js                   ← Serverless proxy (solves CORS, hides API key)
```

## Why This Structure?

The DART API (opendart.fss.or.kr) does **not** send CORS headers, so browsers block 
direct API calls from your website. The `dart-proxy.js` Netlify Function acts as a 
server-side proxy: your dashboard calls the proxy, the proxy calls DART, and returns 
the result. This also keeps your API key hidden from the browser.

## Deploying to Netlify

### Option A: Drag & Drop (simplest)
You **cannot** drag & drop for this project because Netlify Functions require a Git 
deploy. Use Option B.

### Option B: GitHub + Netlify (recommended)
1. Create a new GitHub repository
2. Push the entire `dart-site/` folder contents to the repo root:
   ```
   git init
   git add .
   git commit -m "DART Filing Alerts"
   git remote add origin https://github.com/YOUR_USER/YOUR_REPO.git
   git push -u origin main
   ```
3. In Netlify: **Add new site → Import from Git → pick your repo**
4. Build settings: leave everything blank (no build command needed)
5. Click **Deploy site**

Netlify automatically detects `netlify/functions/` and deploys the serverless function.

## Changing the Password
Edit `index.html`, find this line near the top of the `<script>`:
```js
const ACCESS_PASSWORD = "dart2026";
```
Change it and push to GitHub. Netlify auto-deploys.

## Changing the API Key
Edit `netlify/functions/dart-proxy.js`, find:
```js
params.crtfc_key = "YOUR_KEY_HERE";
```
Change it and push. The key never appears in the browser.
