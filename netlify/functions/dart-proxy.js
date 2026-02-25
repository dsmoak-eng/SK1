const https = require("https");
const http = require("http");

const API_KEY = "9775291c3b36cd68194e1d33e637f3783af7fcb0";

function httpGet(urlStr, timeout = 9000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timeout")), timeout);
    const doReq = (u, redirects = 0) => {
      if (redirects > 5) { clearTimeout(timer); return reject(new Error("Too many redirects")); }
      let parsed;
      try { parsed = new URL(u); } catch(e) { clearTimeout(timer); return reject(e); }
      const lib = parsed.protocol === "https:" ? https : http;
      lib.get(u, { timeout: 8000 }, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          res.resume();
          const next = new URL(res.headers.location, u).toString();
          return doReq(next, redirects + 1);
        }
        let data = "";
        res.on("data", (chunk) => { data += chunk; });
        res.on("end", () => { clearTimeout(timer); resolve(data); });
        res.on("error", (e) => { clearTimeout(timer); reject(e); });
      }).on("error", (e) => { clearTimeout(timer); reject(e); });
    };
    doReq(urlStr);
  });
}

async function fetchForCorp(corpCode, bgnDe, endDe) {
  const qs = new URLSearchParams({
    crtfc_key: API_KEY,
    corp_code: corpCode,
    bgn_de: bgnDe,
    end_de: endDe,
    page_no: "1",
    page_count: "100",
  }).toString();
  const url = `https://opendart.fss.or.kr/api/list.json?${qs}`;
  const raw = await httpGet(url);
  return JSON.parse(raw);
}

exports.handler = async (event) => {
  const H = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers: H, body: "" };
  }

  try {
    const p = event.queryStringParameters || {};

    if (p.action === "ping") {
      try {
        const data = await fetchForCorp("00126380", "20250101", "20250201");
        return {
          statusCode: 200, headers: H,
          body: JSON.stringify({
            status: "ok",
            dart_status: data.status,
            sample_count: (data.list || []).length,
          }),
        };
      } catch (e) {
        return { statusCode: 200, headers: H, body: JSON.stringify({ status: "ok", dart_error: e.message }) };
      }
    }

    if (p.action === "batch") {
      const codes = (p.corp_codes || "").split(",").filter(Boolean);
      const bgnDe = p.bgn_de;
      const endDe = p.end_de;

      if (!bgnDe || !endDe || codes.length === 0) {
        return { statusCode: 400, headers: H, body: JSON.stringify({ error: "Need corp_codes, bgn_de, end_de" }) };
      }

      const allFilings = [];
      const errors = [];
      const batchSize = 5;

      for (let i = 0; i < codes.length; i += batchSize) {
        const batch = codes.slice(i, i + batchSize);
        const results = await Promise.allSettled(
          batch.map(cc => fetchForCorp(cc, bgnDe, endDe))
        );
        results.forEach((r, idx) => {
          const cc = batch[idx];
          if (r.status === "fulfilled") {
            const d = r.value;
            if (d.status === "000" && d.list) {
              allFilings.push(...d.list);
            } else if (d.status !== "013") {
              errors.push(`${cc}: ${d.message || d.status}`);
            }
          } else {
            errors.push(`${cc}: ${r.reason.message}`);
          }
        });
      }

      allFilings.sort((a, b) => (b.rcept_dt || "").localeCompare(a.rcept_dt || ""));

      return {
        statusCode: 200, headers: H,
        body: JSON.stringify({
          status: "ok",
          total: allFilings.length,
          companies_queried: codes.length,
          errors: errors.length > 0 ? errors : undefined,
          filings: allFilings,
        }),
      };
    }

    return { statusCode: 400, headers: H, body: JSON.stringify({ error: "Use action=ping or action=batch" }) };

  } catch (err) {
    console.error("Proxy error:", err);
    return { statusCode: 500, headers: H, body: JSON.stringify({ error: err.message }) };
  }
};

