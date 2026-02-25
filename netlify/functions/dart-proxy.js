const https = require("https");
const zlib = require("zlib");

const API_KEY = "9775291c3b36cd68194e1d33e637f3783af7fcb0";

// In-memory cache for corp_code map (survives across warm invocations)
let cachedMap = null;
let cacheTime = 0;
const CACHE_TTL = 24 * 60 * 60 * 1000;

// ─── HTTP helper ──────────────────────────────────────────────────
function httpsGet(url, timeout = 9000) {
  return new Promise((resolve, reject) => {
    const doReq = (u, redirects = 0) => {
      if (redirects > 5) return reject(new Error("Too many redirects"));
      const req = https.get(u, { timeout }, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          return doReq(res.headers.location, redirects + 1);
        }
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ code: res.statusCode, headers: res.headers, buf: Buffer.concat(chunks) }));
      });
      req.on("error", reject);
      req.on("timeout", () => { req.destroy(); reject(new Error("Timeout")); });
    };
    doReq(url);
  });
}

// ─── DART JSON call ───────────────────────────────────────────────
async function dartJson(path, params) {
  const qs = new URLSearchParams({ crtfc_key: API_KEY, ...params }).toString();
  const url = `https://opendart.fss.or.kr/api/${path}?${qs}`;
  console.log("→", path, JSON.stringify(params));
  const r = await httpsGet(url);
  const text = r.buf.toString("utf-8");
  try { return JSON.parse(text); }
  catch { return { _raw: text.slice(0, 500), _err: true }; }
}

// ─── Corp code map (download + parse CORPCODE.xml ZIP) ────────────
async function getCorpMap() {
  if (cachedMap && (Date.now() - cacheTime) < CACHE_TTL) {
    console.log("Using cached map:", cachedMap.size);
    return cachedMap;
  }

  console.log("Downloading CORPCODE.xml ZIP...");
  const r = await httpsGet(`https://opendart.fss.or.kr/api/corpCode.xml?crtfc_key=${API_KEY}`, 8000);
  const buf = r.buf;
  console.log("ZIP bytes:", buf.length);

  // Verify ZIP signature
  if (buf.length < 100 || buf[0] !== 0x50 || buf[1] !== 0x4B) {
    throw new Error("Not a ZIP. Got: " + buf.toString("utf-8", 0, Math.min(300, buf.length)));
  }

  // Find all local file entries and extract the first one
  const xml = extractZip(buf);
  console.log("XML length:", xml.length);

  // Parse: extract corp_code, corp_name, stock_code from each <list> block
  const map = new Map();
  // Use a simpler, more forgiving regex
  const re = /<corp_code>([^<]+)<\/corp_code>[\s\S]*?<corp_name>([^<]*)<\/corp_name>[\s\S]*?<stock_code>([^<]*)<\/stock_code>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const sc = (m[3] || "").trim();
    if (sc) map.set(sc.padStart(6, "0"), { corp_code: m[1].trim(), corp_name: m[2].trim() });
  }

  console.log("Map size:", map.size);
  cachedMap = map;
  cacheTime = Date.now();
  return map;
}

function extractZip(buf) {
  // Read local file header at offset 0
  const sig = buf.readUInt32LE(0);
  if (sig !== 0x04034b50) throw new Error("Bad ZIP local header");
  const method = buf.readUInt16LE(8);
  const cSize = buf.readUInt32LE(18);
  const fnLen = buf.readUInt16LE(26);
  const exLen = buf.readUInt16LE(28);
  const dataStart = 30 + fnLen + exLen;
  const data = buf.slice(dataStart, dataStart + cSize);
  if (method === 0) return data.toString("utf-8");
  if (method === 8) return zlib.inflateRawSync(data).toString("utf-8");
  throw new Error("Unsupported compression: " + method);
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
    // ── PING ──
    if (p.action === "ping") {
      return ok(H, { status: "ok", ts: new Date().toISOString() });
    }

    // ── LOOKUP: resolve stock_codes to corp_codes ──
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

    // ── FILINGS: fetch for ONE company by corp_code ──
    if (p.action === "filings") {
      if (!p.corp_code || !p.bgn_de || !p.end_de) return err(H, 400, "Need corp_code, bgn_de, end_de");
      const r = await dartJson("list.json", { corp_code: p.corp_code, bgn_de: p.bgn_de, end_de: p.end_de, page_count: "100" });
      if (r._err) return ok(H, { status: "parse_error", raw: r._raw, filings: [] });
      if (r.status === "000") return ok(H, { status: "ok", total: r.list.length, filings: r.list });
      if (r.status === "013") return ok(H, { status: "ok", total: 0, filings: [] });
      return ok(H, { status: "dart_error", dart_status: r.status, dart_message: r.message, filings: [] });
    }

    // ── RAW: debug endpoint ──
    if (p.action === "raw") {
      const path = p.path || "company.json";
      const params = { ...p }; delete params.action; delete params.path;
      const r = await dartJson(path, params);
      return ok(H, { dart_response: r });
    }

    return err(H, 400, "Use action=ping, action=lookup, action=filings, or action=raw");

  } catch (e) {
    console.error("ERROR:", e);
    return { statusCode: 500, headers: H, body: JSON.stringify({ error: e.message, stack: e.stack }) };
  }
};

function ok(H, data) { return { statusCode: 200, headers: H, body: JSON.stringify(data) }; }
function err(H, code, msg) { return { statusCode: code, headers: H, body: JSON.stringify({ error: msg }) }; }
