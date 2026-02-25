const https = require("https");
const http = require("http");
const { URL } = require("url");
const zlib = require("zlib");

// ─── CONFIG ───────────────────────────────────────────────────────
const API_KEY = "9775291c3b36cd68194e1d33e637f3783af7fcb0";

// DART API base URLs
const DART_API = "https://opendart.fss.or.kr/api";
const DART_ENG_API = "https://engopendart.fss.or.kr/engapi";

// Cache the corp_code map in memory (persists across warm invocations)
let corpCodeCache = null;
let corpCodeCacheTime = 0;
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours

// ─── HTTP HELPERS ─────────────────────────────────────────────────

/**
 * Generic HTTPS GET that follows redirects and returns a Buffer
 */
function fetchBuffer(urlString) {
  return new Promise((resolve, reject) => {
    const doRequest = (url, redirects = 0) => {
      if (redirects > 5) return reject(new Error("Too many redirects"));
      const parsedUrl = new URL(url);
      const lib = parsedUrl.protocol === "https:" ? https : http;

      lib.get(url, { headers: { "Accept-Encoding": "identity" } }, (res) => {
        // Follow redirects
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          const redirectUrl = new URL(res.headers.location, url).toString();
          return doRequest(redirectUrl, redirects + 1);
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode} from ${url}`));
        }

        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => resolve(Buffer.concat(chunks)));
        res.on("error", reject);
      }).on("error", reject);
    };
    doRequest(urlString);
  });
}

/**
 * Fetch JSON from DART API
 */
async function dartJsonRequest(baseUrl, params) {
  const qs = new URLSearchParams({ crtfc_key: API_KEY, ...params }).toString();
  const url = `${baseUrl}?${qs}`;
  console.log("DART request:", url.replace(API_KEY, "***"));

  const buf = await fetchBuffer(url);
  const text = buf.toString("utf-8");

  try {
    return JSON.parse(text);
  } catch (e) {
    console.error("Failed to parse JSON:", text.slice(0, 500));
    throw new Error("Failed to parse DART response: " + text.slice(0, 200));
  }
}

// ─── CORP CODE RESOLUTION ─────────────────────────────────────────

/**
 * Download and parse CORPCODE.xml from DART.
 * Returns a Map: stock_code (6-digit) → corp_code (8-digit)
 *
 * The endpoint returns a ZIP file containing CORPCODE.xml with entries like:
 * <list>
 *   <corp_code>00126380</corp_code>
 *   <corp_name>삼성전자</corp_name>
 *   <stock_code>005930</stock_code>
 *   <modify_date>20231215</modify_date>
 * </list>
 */
async function getCorpCodeMap() {
  const now = Date.now();
  if (corpCodeCache && (now - corpCodeCacheTime) < CACHE_TTL) {
    console.log(`Using cached corp_code map (${corpCodeCache.size} entries)`);
    return corpCodeCache;
  }

  console.log("Downloading CORPCODE.xml ZIP from DART...");
  const zipUrl = `${DART_API}/corpCode.xml?crtfc_key=${API_KEY}`;
  const zipBuf = await fetchBuffer(zipUrl);
  console.log(`Downloaded ZIP: ${zipBuf.length} bytes`);

  // The response is a ZIP file. We need to extract CORPCODE.xml from it.
  // Using a minimal ZIP parser since we can't rely on npm packages in Netlify Functions
  // without a build step. The ZIP contains a single XML file.
  const xmlContent = extractFirstFileFromZip(zipBuf);
  console.log(`Extracted XML: ${xmlContent.length} characters`);

  // Parse the XML to build stock_code → corp_code map
  const map = new Map();
  // Match each <list>...</list> block
  const listRegex = /<list>([\s\S]*?)<\/list>/g;
  let match;
  let total = 0;
  let withStock = 0;

  while ((match = listRegex.exec(xmlContent)) !== null) {
    total++;
    const block = match[1];
    const corpCode = extractXmlTag(block, "corp_code");
    const stockCode = extractXmlTag(block, "stock_code");
    const corpName = extractXmlTag(block, "corp_name");

    // Only map entries that have a stock_code (listed companies)
    if (stockCode && stockCode.trim() && corpCode) {
      const sc = stockCode.trim().padStart(6, "0");
      map.set(sc, { corp_code: corpCode.trim(), corp_name: corpName || "" });
      withStock++;
    }
  }

  console.log(`Parsed ${total} companies, ${withStock} with stock codes`);
  corpCodeCache = map;
  corpCodeCacheTime = now;
  return map;
}

function extractXmlTag(xml, tag) {
  const re = new RegExp(`<${tag}>([^<]*)</${tag}>`);
  const m = xml.match(re);
  return m ? m[1] : null;
}

/**
 * Minimal ZIP extractor - extracts the first file's content as a UTF-8 string.
 * ZIP local file header format:
 *   0-3:   PK\x03\x04 signature
 *   4-5:   version needed
 *   6-7:   flags
 *   8-9:   compression method (0=stored, 8=deflate)
 *   10-13: mod time/date
 *   14-17: CRC-32
 *   18-21: compressed size
 *   22-25: uncompressed size
 *   26-27: filename length
 *   28-29: extra field length
 *   30+:   filename, then extra field, then data
 */
function extractFirstFileFromZip(buf) {
  // Find PK signature
  const sig = buf.readUInt32LE(0);
  if (sig !== 0x04034b50) {
    // Maybe the response is actually JSON (error message)?
    const text = buf.toString("utf-8", 0, Math.min(500, buf.length));
    if (text.includes('"status"') || text.includes('"message"')) {
      throw new Error("DART returned error instead of ZIP: " + text.slice(0, 300));
    }
    throw new Error("Not a valid ZIP file (signature: 0x" + sig.toString(16) + ")");
  }

  const compression = buf.readUInt16LE(8);
  const compressedSize = buf.readUInt32LE(18);
  const filenameLen = buf.readUInt16LE(26);
  const extraLen = buf.readUInt16LE(28);
  const dataOffset = 30 + filenameLen + extraLen;
  const filename = buf.toString("utf-8", 30, 30 + filenameLen);
  console.log(`ZIP entry: ${filename}, compression: ${compression}, size: ${compressedSize}`);

  const compressedData = buf.slice(dataOffset, dataOffset + compressedSize);

  if (compression === 0) {
    // Stored (no compression)
    return compressedData.toString("utf-8");
  } else if (compression === 8) {
    // Deflate
    const inflated = zlib.inflateRawSync(compressedData);
    return inflated.toString("utf-8");
  } else {
    throw new Error(`Unsupported ZIP compression method: ${compression}`);
  }
}

// ─── FILING FETCHERS ──────────────────────────────────────────────

/**
 * Fetch filings for a single company using corp_code.
 * Uses the KOREAN DART API (opendart.fss.or.kr) which is the primary/reliable one.
 */
async function fetchCompanyFilings(corpCode, bgnDe, endDe) {
  const result = await dartJsonRequest(`${DART_API}/list.json`, {
    corp_code: corpCode,
    bgn_de: bgnDe,
    end_de: endDe,
    page_count: "100",
    sort: "date",
    sort_mth: "desc",
  });

  if (result.status === "000" && result.list) {
    return result.list;
  } else if (result.status === "013") {
    // No data
    return [];
  } else {
    console.log(`DART status ${result.status} for corp_code ${corpCode}: ${result.message || ""}`);
    return [];
  }
}

// ─── MAIN HANDLER ─────────────────────────────────────────────────

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

    // ── PING ──
    if (p.action === "ping") {
      return {
        statusCode: 200,
        headers: H,
        body: JSON.stringify({ status: "ok", message: "Proxy is running", timestamp: new Date().toISOString() }),
      };
    }

    // ── BATCH: resolve stock codes and fetch per-company ──
    if (p.action === "batch") {
      const stockCodes = (p.stock_codes || "").split(",").filter(Boolean);
      const bgnDe = p.bgn_de;
      const endDe = p.end_de;

      if (!bgnDe || !endDe || stockCodes.length === 0) {
        return {
          statusCode: 400,
          headers: H,
          body: JSON.stringify({ error: "Need stock_codes, bgn_de, end_de" }),
        };
      }

      // Step 1: Get stock_code → corp_code map
      console.log(`Resolving ${stockCodes.length} stock codes...`);
      const corpMap = await getCorpCodeMap();

      // Step 2: Resolve each stock code
      const resolved = [];
      const unresolved = [];

      for (const rawCode of stockCodes) {
        const sc = rawCode.trim().padStart(6, "0");
        const entry = corpMap.get(sc);
        if (entry) {
          resolved.push({ stock_code: sc, corp_code: entry.corp_code, corp_name: entry.corp_name });
        } else {
          unresolved.push(sc);
        }
      }

      console.log(`Resolved: ${resolved.length}, Unresolved: ${unresolved.length}`);
      if (unresolved.length > 0) {
        console.log("Unresolved stock codes:", unresolved.join(", "));
      }

      // Step 3: Fetch filings for each resolved company (in parallel, batched)
      const BATCH_SIZE = 5; // Don't hammer the API too hard
      let allFilings = [];

      for (let i = 0; i < resolved.length; i += BATCH_SIZE) {
        const batch = resolved.slice(i, i + BATCH_SIZE);
        const results = await Promise.all(
          batch.map(async (company) => {
            try {
              const filings = await fetchCompanyFilings(company.corp_code, bgnDe, endDe);
              console.log(`  ${company.corp_name} (${company.stock_code} → ${company.corp_code}): ${filings.length} filings`);
              return filings;
            } catch (err) {
              console.error(`  Error fetching ${company.corp_name}: ${err.message}`);
              return [];
            }
          })
        );
        allFilings = allFilings.concat(results.flat());
      }

      // Step 4: Sort by date descending
      allFilings.sort((a, b) => (b.rcept_dt || "").localeCompare(a.rcept_dt || ""));

      console.log(`Total filings: ${allFilings.length}`);

      return {
        statusCode: 200,
        headers: H,
        body: JSON.stringify({
          status: "ok",
          resolved_count: resolved.length,
          unresolved_count: unresolved.length,
          unresolved_codes: unresolved,
          total: allFilings.length,
          filings: allFilings,
        }),
      };
    }

    // ── RESOLVE: just show the corp_code mapping (debug endpoint) ──
    if (p.action === "resolve") {
      const stockCodes = (p.stock_codes || "").split(",").filter(Boolean);
      const corpMap = await getCorpCodeMap();

      const results = stockCodes.map((raw) => {
        const sc = raw.trim().padStart(6, "0");
        const entry = corpMap.get(sc);
        return {
          stock_code: sc,
          corp_code: entry ? entry.corp_code : null,
          corp_name: entry ? entry.corp_name : null,
          resolved: !!entry,
        };
      });

      return {
        statusCode: 200,
        headers: H,
        body: JSON.stringify({ status: "ok", map_size: corpMap.size, results }),
      };
    }

    return {
      statusCode: 400,
      headers: H,
      body: JSON.stringify({
        error: "Unknown action. Use action=batch, action=resolve, or action=ping",
      }),
    };
  } catch (err) {
    console.error("Proxy error:", err);
    return {
      statusCode: 500,
      headers: H,
      body: JSON.stringify({ error: err.message, stack: err.stack }),
    };
  }
};
