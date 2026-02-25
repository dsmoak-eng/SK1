const https = require("https");

// ─── CONFIG ───────────────────────────────────────────────────────
const API_KEY = "9775291c3b36cd68194e1d33e637f3783af7fcb0";

// ─── HELPERS ──────────────────────────────────────────────────────

function dartGet(path, params) {
  return new Promise((resolve, reject) => {
    const qs = new URLSearchParams({ crtfc_key: API_KEY, ...params }).toString();
    const url = `https://opendart.fss.or.kr/api/${path}?${qs}`;
    console.log("DART →", url.replace(API_KEY, "KEY"));

    const req = https.get(url, { timeout: 8000 }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          console.error("Non-JSON response:", data.slice(0, 300));
          reject(new Error("DART returned non-JSON: " + data.slice(0, 200)));
        }
      });
    });
    req.on("error", (e) => reject(new Error("Request failed: " + e.message)));
    req.on("timeout", () => { req.destroy(); reject(new Error("Request timed out")); });
  });
}

// ─── HANDLER ──────────────────────────────────────────────────────

exports.handler = async (event) => {
  const H = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers: H, body: "" };
  }

  const p = event.queryStringParameters || {};

  try {
    // ── PING ──
    if (p.action === "ping") {
      return {
        statusCode: 200, headers: H,
        body: JSON.stringify({ status: "ok", ts: new Date().toISOString() }),
      };
    }

    // ── FILINGS: fetch for ONE company by corp_code ──
    if (p.action === "filings") {
      const corpCode = p.corp_code;
      const bgnDe = p.bgn_de;
      const endDe = p.end_de;

      if (!corpCode || !bgnDe || !endDe) {
        return {
          statusCode: 400, headers: H,
          body: JSON.stringify({ error: "Need corp_code, bgn_de, end_de" }),
        };
      }

      const result = await dartGet("list.json", {
        corp_code: corpCode,
        bgn_de: bgnDe,
        end_de: endDe,
        page_count: "100",
        sort: "date",
        sort_mth: "desc",
      });

      if (result.status === "000" && result.list) {
        return {
          statusCode: 200, headers: H,
          body: JSON.stringify({
            status: "ok",
            corp_code: corpCode,
            total: result.list.length,
            filings: result.list,
          }),
        };
      } else if (result.status === "013") {
        return {
          statusCode: 200, headers: H,
          body: JSON.stringify({ status: "ok", corp_code: corpCode, total: 0, filings: [] }),
        };
      } else {
        return {
          statusCode: 200, headers: H,
          body: JSON.stringify({
            status: "dart_error",
            corp_code: corpCode,
            dart_status: result.status,
            dart_message: result.message || "Unknown DART error",
            total: 0,
            filings: [],
          }),
        };
      }
    }

    // ── COMPANY INFO (debug) ──
    if (p.action === "company") {
      const corpCode = p.corp_code;
      if (!corpCode) {
        return { statusCode: 400, headers: H, body: JSON.stringify({ error: "Need corp_code" }) };
      }
      const result = await dartGet("company.json", { corp_code: corpCode });
      return { statusCode: 200, headers: H, body: JSON.stringify(result) };
    }

    return {
      statusCode: 400, headers: H,
      body: JSON.stringify({ error: "Use action=filings, action=company, or action=ping" }),
    };

  } catch (err) {
    console.error("Proxy error:", err);
    return {
      statusCode: 500, headers: H,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
