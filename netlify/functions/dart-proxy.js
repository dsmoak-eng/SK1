const https = require("https");

const API_KEY = "9775291c3b36cd68194e1d33e637f3783af7fcb0";

function dartRequest(params) {
  return new Promise((resolve, reject) => {
    const qs = new URLSearchParams({ crtfc_key: API_KEY, ...params }).toString();
    const url = `https://opendart.fss.or.kr/api/list.json?${qs}`;
    console.log("Requesting:", url.replace(API_KEY, "***"));

    https.get(url, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error("Failed to parse DART response: " + data.slice(0, 200)));
        }
      });
    }).on("error", (e) => {
      reject(new Error("HTTPS request failed: " + e.message));
    });
  });
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

    if (p.action === "scan") {
      const codes = (p.stock_codes || "").split(",").filter(Boolean);
      const bgnDe = p.bgn_de;
      const endDe = p.end_de;

      if (!bgnDe || !endDe || codes.length === 0) {
        return { statusCode: 400, headers: H, body: JSON.stringify({ error: "Need stock_codes, bgn_de, end_de" }) };
      }

      const codeSet = new Set(codes.map(c => c.padStart(6, "0")));
      const matched = [];
      let page = 1;
      let totalPages = 1;

      // Scan up to 10 pages (1000 filings)
      while (page <= totalPages && page <= 10) {
        console.log("Fetching page " + page);
        const data = await dartRequest({
          bgn_de: bgnDe,
          end_de: endDe,
          page_no: String(page),
          page_count: "100",
        });

        if (data.status === "000" && data.list) {
          totalPages = data.total_page || 1;
          for (const f of data.list) {
            const sc = (f.stock_code || "").trim();
            if (sc && codeSet.has(sc)) {
              matched.push(f);
            }
          }
          console.log("Page " + page + ": found " + matched.length + " matches so far");
        } else if (data.status === "013") {
          console.log("No data for this range");
          break;
        } else {
          console.log("DART status: " + data.status + " " + (data.message || ""));
          break;
        }
        page++;
      }

      matched.sort((a, b) => (b.rcept_dt || "").localeCompare(a.rcept_dt || ""));

      return {
        statusCode: 200,
        headers: H,
        body: JSON.stringify({
          status: "ok",
          pages_scanned: page - 1,
          total_pages: totalPages,
          total: matched.length,
          filings: matched,
        }),
      };
    }

    // Simple health check
    if (p.action === "ping") {
      return { statusCode: 200, headers: H, body: JSON.stringify({ status: "ok", message: "Proxy is running" }) };
    }

    return { statusCode: 400, headers: H, body: JSON.stringify({ error: "Use action=scan or action=ping" }) };

  } catch (err) {
    console.error("Proxy error:", err);
    return { statusCode: 500, headers: H, body: JSON.stringify({ error: err.message, stack: err.stack }) };
  }
};
