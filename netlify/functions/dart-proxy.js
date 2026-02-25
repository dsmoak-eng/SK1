const https = require("https");
const http = require("http");
const { URL } = require("url");

const API_KEY = "9775291c3b36cd68194e1d33e637f3783af7fcb0";

// ─── HTTP helper with proper redirect handling ────────────────────
function httpGet(urlStr, timeout = 9000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timeout after " + timeout + "ms")), timeout);

    const doReq = (u, redirects = 0) => {
      if (redirects > 5) {
        clearTimeout(timer);
        return reject(new Error("Too many redirects (last: " + u + ")"));
      }

      let parsed;
      try { parsed = new URL(u); } catch (e) {
        clearTimeout(timer);
        return reject(new Error("Invalid URL: " + u));
      }

      const lib = parsed.protocol === "https:" ? https : http;

      const req = lib.get(u, {
        timeout: timeout - 500,
        headers: { "User-Agent": "DartProxy/1.0", "Accept-Encoding": "identity" },
      }, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          res.resume(); // drain response body
          // Resolve relative redirects against the current URL
          const next = new URL(res.headers.location, u).toString();
          console.log(`[redirect] ${res.statusCode} -> ${next}`);
          return doReq(next, redirects + 1);
        }

        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          clearTimeout(timer);
          resolve({ code: res.statusCode, headers: res.headers, buf: Buffer.concat(chunks) });
        });
        res.on("error", (e) => { clearTimeout(timer); reject(e); });
      });

      req.on("error", (e) => { clearTimeout(timer); reject(new Error("Network: " + e.message)); });
      req.on("timeout", () => { req.destroy(); clearTimeout(timer); reject(new Error("Socket timeout")); });
    };
    doReq(urlStr);
  });
}

// ─── DART JSON call ───────────────────────────────────────────────
async function dartJson(params) {
  const qs = new URLSearchParams({ crtfc_key: API_KEY, ...params }).toString();
  const url = `https://opendart.fss.or.kr/api/list.json?${qs}`;
  console.log("[dart]", JSON.stringify(params));
  const r = await httpGet(url);
  const text = r.buf.toString("utf-8");
  try { return JSON.parse(text); }
  catch { return { _raw: text.slice(0, 500), _err: true, _code: r.code }; }
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
      try {
        const qs = new URLSearchParams({
          crtfc_key: API_KEY,
          corp_code: "00126380",
          bgn_de: "20250101",
          end_de: "20250201",
          page_count: "1",
        }).toString();
        const url = `https://opendart.fss.or.kr/api/list.json?${qs}`;
        const r = await httpGet(url, 7000);
        const text = r.buf.toString("utf-8");
        let dartOk = false;
        try { const j = JSON.parse(text); dartOk = j.status === "000" || j.status === "013"; } catch {}
        return ok(H, { status: "ok", ts: new Date().toISOString(), dart_reachable: dartOk, http_code: r.code });
      } catch (e) {
        return ok(H, { status: "ok", ts: new Date().toISOString(), dart_reachable: false, dart_error: e.message });
      }
    }

    // ── FILINGS: fetch for ONE company by corp_code ──
    if (p.action === "filings") {
      if (!p.corp_code || !p.bgn_de || !p.end_de) {
        return err(H, 400, "Need corp_code, bgn_de, end_de");
      }

      const r = await dartJson({
        corp_code: p.corp_code,
        bgn_de: p.bgn_de,
        end_de: p.end_de,
        page_count: "100",
        sort: "date",
        sort_mth: "desc",
      });

      if (r._err) {
        return ok(H, { status: "parse_error", corp_code: p.corp_code, raw: r._raw, http_code: r._code, total: 0, filings: [] });
      }
      if (r.status === "000" && r.list) {
        return ok(H, { status: "ok", corp_code: p.corp_code, total: r.list.length, filings: r.list });
      }
      if (r.status === "013") {
        return ok(H, { status: "ok", corp_code: p.corp_code, total: 0, filings: [] });
      }
      return ok(H, { status: "dart_error", corp_code: p.corp_code, dart_status: r.status, dart_message: r.message, total: 0, filings: [] });
    }

    // ── BATCH: fetch for multiple companies ──
    if (p.action === "batch") {
      const codes = (p.corp_codes || "").split(",").filter(Boolean);
      if (!p.bgn_de || !p.end_de || codes.length === 0) {
        return err(H, 400, "Need corp_codes, bgn_de, end_de");
      }

      const allFilings = [];
      const errors = [];
      const batchSize = 5;

      for (let i = 0; i < codes.length; i += batchSize) {
        const batch = codes.slice(i, i + batchSize);
        const results = await Promise.allSettled(
          batch.map(async (cc) => {
            const d = await dartJson({
              corp_code: cc, bgn_de: p.bgn_de, end_de: p.end_de, page_count: "100",
            });
            if (d._err) throw new Error("Parse error");
            if (d.status === "000" && d.list) return d.list;
            if (d.status === "013") return [];
            throw new Error(`DART ${d.status}: ${d.message || "unknown"}`);
          })
        );
        results.forEach((r, idx) => {
          if (r.status === "fulfilled") allFilings.push(...r.value);
          else errors.push(`${batch[idx]}: ${r.reason.message}`);
        });
      }

      allFilings.sort((a, b) => (b.rcept_dt || "").localeCompare(a.rcept_dt || ""));
      return ok(H, { status: "ok", total: allFilings.length, companies_queried: codes.length, errors: errors.length > 0 ? errors : undefined, filings: allFilings });
    }

    // ── RAW: debug endpoint ──
    if (p.action === "raw") {
      const path = p.path || "company.json";
      const params = { ...p }; delete params.action; delete params.path;
      const qs = new URLSearchParams({ crtfc_key: API_KEY, ...params }).toString();
      const url = `https://opendart.fss.or.kr/api/${path}?${qs}`;
      const r = await httpGet(url);
      const text = r.buf.toString("utf-8");
      let parsed; try { parsed = JSON.parse(text); } catch { parsed = { _raw: text.slice(0, 1000) }; }
      return ok(H, { http_code: r.code, dart_response: parsed });
    }

    return err(H, 400, "Use action=ping, filings, batch, or raw");

  } catch (e) {
    console.error("HANDLER ERROR:", e);
    return { statusCode: 500, headers: H, body: JSON.stringify({ error: e.message, stack: e.stack }) };
  }
};

function ok(H, d) { return { statusCode: 200, headers: H, body: JSON.stringify(d) }; }
function err(H, c, m) { return { statusCode: c, headers: H, body: JSON.stringify({ error: m }) }; }
