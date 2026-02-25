const https = require("https");
const http = require("http");
const { URL } = require("url");
const zlib = require("zlib");

const API_KEY = "9775291c3b36cd68194e1d33e637f3783af7fcb0";

let cachedMap = null;
let cacheTime = 0;
const CACHE_TTL = 24 * 60 * 60 * 1000;

// ─── HTTP helper with proper redirect handling ────────────────────
function httpGet(urlStr, timeout = 9000) {
  return new Promise((resolve, reject) => {
    const doReq = (u, redirects = 0) => {
      if (redirects > 5) return reject(new Error("Too many redirects from: " + u));

      let parsed;
      try { parsed = new URL(u); } catch (e) { return reject(new Error("Invalid URL: " + u)); }

      const lib = parsed.protocol === "https:" ? https : http;
      const opts = {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname + parsed.search,
        timeout,
        headers: { "User-Agent": "DartProxy/1.0" },
      };

      console.log(`[req] ${parsed.protocol}//${parsed.hostname}${parsed.pathname}${parsed.search ? "?" + parsed.search.slice(1, 40) + "..." : ""} (redirect #${redirects})`);

      const req = lib.get(opts, (res) => {
        console.log(`[res] ${res.statusCode} ${res.headers.location ? "→ " + res.headers.location : ""}`);

        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          res.resume(); // drain the response
          // Resolve relative redirects against the current URL
          const next = new URL(res.headers.location, u).toString();
          return doReq(next, redirects + 1);
        }

        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({
          code: res.statusCode,
          headers: res.headers,
          buf: Buffer.concat(chunks),
        }));
      });

      req.on("error", (e) => reject(new Error("Network error: " + e.message)));
      req.on("timeout", () => { req.destroy(); reject(new Error("Timeout after " + timeout + "ms")); });
    };
    doReq(urlStr);
  });
}

// ─── DART JSON call ───────────────────────────────────────────────
async function dartJson(path, params) {
  const qs = new URLSearchParams({ crtfc_key: API_KEY, ...params }).toString();
  const url = `https://opendart.fss.or.kr/api/${path}?${qs}`;
  console.log("[dart]", path, JSON.stringify(params));
  const r = await httpGet(url);
  const text = r.buf.toString("utf-8");
  try { return JSON.parse(text); }
  catch { return { _raw: text.slice(0, 500), _err: true, _code: r.code }; }
}

// ─── Corp code map ────────────────────────────────────────────────
async function getCorpMap() {
  if (cachedMap && (Date.now() - cacheTime) < CACHE_TTL) {
    console.log("[cache] Using cached map:", cachedMap.size);
    return cachedMap;
  }

  console.log("[corpcode] Downloading ZIP...");
  const r = await httpGet(
    `https://opendart.fss.or.kr/api/corpCode.xml?crtfc_key=${API_KEY}`,
    8500
  );
  const buf = r.buf;
  console.log("[corpcode] Response:", buf.length, "bytes, HTTP", r.code);

  if (buf.length < 100 || buf[0] !== 0x50 || buf[1] !== 0x4B) {
    const text = buf.toString("utf-8", 0, Math.min(300, buf.length));
    throw new Error("Not a ZIP (HTTP " + r.code + "): " + text);
  }

  const xml = extractZip(buf);
  console.log("[corpcode] XML:", xml.length, "chars");

  const map = new Map();
  const re = /<corp_code>([^<]+)<\/corp_code>[\s\S]*?<corp_name>([^<]*)<\/corp_name>[\s\S]*?<stock_code>([^<]*)<\/stock_code>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const sc = (m[3] || "").trim();
    if (sc) map.set(sc.padStart(6, "0"), { corp_code: m[1].trim(), corp_name: m[2].trim() });
  }
  console.log("[corpcode] Map size:", map.size);
  cachedMap = map;
  cacheTime = Date.now();
  return map;
}

function extractZip(buf) {
  if (buf.readUInt32LE(0) !== 0x04034b50) throw new Error("Bad ZIP signature");
  const method = buf.readUInt16LE(8);
  const cSize = buf.readUInt32LE(18);
  const fnLen = buf.readUInt16LE(26);
  const exLen = buf.readUInt16LE(28);
  const off = 30 + fnLen + exLen;
  const data = buf.slice(off, off + cSize);
  if (method === 0) return data.toString("utf-8");
  if (method === 8) return zlib.inflateRawSync(data).toString("utf-8");
  throw new Error("Unsupported ZIP method: " + method);
}

// ─── HANDLER ──────────────────────────────────────────────────────
exports.handler = async (event) => {
  const H = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: H, body: "" };

  const p = event.queryStringParameters || {};

  try {
    if (p.action === "ping") {
      return ok(H, { status: "ok", ts: new Date().toISOString() });
    }

    // Debug: see exactly what DART returns for any endpoint
    if (p.action === "raw") {
      const path = p.path || "company.json";
      const params = { ...p };
      delete params.action; delete params.path;
      const result = await dartJson(path, params);
      return ok(H, { dart_response: result });
    }

    // Lookup: resolve stock_codes → corp_codes via CORPCODE.xml
    if (p.action === "lookup") {
      const codes = (p.stock_codes || "").split(",").filter(Boolean);
      if (!codes.length) return err(H, 400, "Need stock_codes");
      const map = await getCorpMap();
      const results = {};
      for (const raw of codes) {
        const sc = raw.trim().padStart(6, "0");
        const entry = map.get(sc);
        if (entry) results[sc] = entry;
      }
      return ok(H, { status: "ok", map_total: map.size, searched: codes.length, found: Object.keys(results).length, results });
    }

    // Filings: fetch for one company
    if (p.action === "filings") {
      if (!p.corp_code || !p.bgn_de || !p.end_de) return err(H, 400, "Need corp_code, bgn_de, end_de");
      const r = await dartJson("list.json", {
        corp_code: p.corp_code, bgn_de: p.bgn_de, end_de: p.end_de, page_count: "100",
      });
      if (r._err) return ok(H, { status: "parse_error", raw: r._raw, http_code: r._code, filings: [] });
      if (r.status === "000") return ok(H, { status: "ok", total: r.list.length, filings: r.list });
      if (r.status === "013") return ok(H, { status: "ok", total: 0, filings: [] });
      return ok(H, { status: "dart_error", dart_status: r.status, dart_message: r.message, filings: [] });
    }

    return err(H, 400, "Use action=ping, lookup, filings, or raw");

  } catch (e) {
    console.error("HANDLER ERROR:", e);
    return { statusCode: 500, headers: H, body: JSON.stringify({ error: e.message, stack: e.stack }) };
  }
};

function ok(H, d) { return { statusCode: 200, headers: H, body: JSON.stringify(d) }; }
function err(H, c, m) { return { statusCode: c, headers: H, body: JSON.stringify({ error: m }) }; }
