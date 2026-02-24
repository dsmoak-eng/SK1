const API_KEY = "9775291c3b36cd68194e1d33e637f3783af7fcb0";
const DART = "https://opendart.fss.or.kr/api";

async function dartGet(endpoint, params) {
  const qs = new URLSearchParams({ crtfc_key: API_KEY, ...params }).toString();
  const url = `${DART}/${endpoint}?${qs}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(endpoint + " returned " + r.status);
  return r.json();
}

exports.handler = async (event) => {
  const H = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: H, body: "" };

  try {
    const p = event.queryStringParameters || {};

    // ── ACTION: scan ──
    // Fetches ALL filings in date range, filters to only watchlist stock_codes
    // This avoids needing corp_codes entirely
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
      const maxPages = 20; // safety limit

      while (page <= totalPages && page <= maxPages) {
        console.log(`Fetching page ${page}/${totalPages}...`);
        const data = await dartGet("list.json", {
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
        } else if (data.status === "013") {
          // No data
          break;
        } else {
          console.log("DART returned status: " + data.status + " " + (data.message || ""));
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

    // ── ACTION: company ──
    // Look up a single company by corp_code
    if (p.action === "company" && p.corp_code) {
      const data = await dartGet("list.json", {
        corp_code: p.corp_code,
        bgn_de: p.bgn_de || "",
        end_de: p.end_de || "",
        page_count: "100",
      });
      return { statusCode: 200, headers: H, body: JSON.stringify(data) };
    }

    return { statusCode: 400, headers: H, body: JSON.stringify({ error: "Use action=scan" }) };

  } catch (err) {
    console.error("Error:", err);
    return { statusCode: 500, headers: H, body: JSON.stringify({ error: err.message }) };
  }
};
