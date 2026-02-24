
const API_KEY = "9775291c3b36cd68194e1d33e637f3783af7fcb0";
const DART_BASE = "https://opendart.fss.or.kr/api";

let corpCodeCache = null;
let cacheTime = 0;
const CACHE_TTL = 24 * 60 * 60 * 1000;

async function buildCorpCodeMap() {
  if (corpCodeCache && (Date.now() - cacheTime) < CACHE_TTL) {
    return corpCodeCache;
  }
  console.log("Downloading CORPCODE.xml from DART...");
  const url = `${DART_BASE}/corpCode.xml?crtfc_key=${API_KEY}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error("corpCode.xml fetch failed: " + response.status);
  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  const zipSig = buffer.readUInt32LE(0);
  if (zipSig !== 0x04034b50) throw new Error("Not a valid ZIP file");
  const fnameLen = buffer.readUInt16LE(26);
  const extraLen = buffer.readUInt16LE(28);
  const compressedSize = buffer.readUInt32LE(18);
  const compressionMethod = buffer.readUInt16LE(8);
  const dataOffset = 30 + fnameLen + extraLen;
  let xmlString;
  if (compressionMethod === 0) {
    xmlString = buffer.slice(dataOffset, dataOffset + compressedSize).toString("utf-8");
  } else if (compressionMethod === 8) {
    const zlib = require("zlib");
    const compressed = buffer.slice(dataOffset, dataOffset + compressedSize);
    xmlString = zlib.inflateRawSync(compressed).toString("utf-8");
  } else {
    throw new Error("Unsupported ZIP compression: " + compressionMethod);
  }
  const map = {};
  const regex = /<list>\s*<corp_code>(\d+)<\/corp_code>\s*<corp_name>([^<]*)<\/corp_name>\s*<stock_code>\s*(\d*)\s*<\/stock_code>/g;
  let match;
  while ((match = regex.exec(xmlString)) !== null) {
    const [, corpCode, corpName, stockCode] = match;
    if (stockCode && stockCode.trim()) {
      map[stockCode.trim()] = { corp_code: corpCode, corp_name: corpName };
    }
  }
  console.log("Built corp_code map: " + Object.keys(map).length + " entries");
  corpCodeCache = map;
  cacheTime = Date.now();
  return map;
}

async function fetchFilingsForCompany(corpCode, bgnDe, endDe) {
  const url = `${DART_BASE}/list.json?crtfc_key=${API_KEY}&corp_code=${corpCode}&bgn_de=${bgnDe}&end_de=${endDe}&page_count=100`;
  const response = await fetch(url);
  if (!response.ok) return [];
  const data = await response.json();
  if (data.status === "000" && data.list) return data.list;
  return [];
}

exports.handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers, body: "" };
  }
  try {
    const params = event.queryStringParameters || {};
    const action = params.action;

    if (action === "batch") {
      const stockCodes = (params.stock_codes || "").split(",").filter(Boolean);
      const bgnDe = params.bgn_de || "";
      const endDe = params.end_de || "";
      if (!bgnDe || !endDe || stockCodes.length === 0) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: "stock_codes, bgn_de, end_de required" }) };
      }
      const map = await buildCorpCodeMap();
      const resolved = {};
      const corpCodes = [];
      for (const sc of stockCodes) {
        const padded = sc.padStart(6, "0");
        if (map[padded]) {
          resolved[padded] = map[padded];
          corpCodes.push(map[padded].corp_code);
        }
      }
      console.log("Resolved " + corpCodes.length + "/" + stockCodes.length + " stock codes");
      const allFilings = [];
      for (let i = 0; i < corpCodes.length; i += 5) {
        const batch = corpCodes.slice(i, i + 5);
        const results = await Promise.all(batch.map(cc => fetchFilingsForCompany(cc, bgnDe, endDe)));
        results.forEach(filings => allFilings.push(...filings));
      }
      allFilings.sort((a, b) => (b.rcept_dt || "").localeCompare(a.rcept_dt || ""));
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ status: "ok", resolved, total: allFilings.length, filings: allFilings }),
      };
    }

    if (action === "resolve") {
      const stockCodes = (params.stock_codes || "").split(",").filter(Boolean);
      const map = await buildCorpCodeMap();
      const result = {};
      for (const sc of stockCodes) {
        const padded = sc.padStart(6, "0");
        if (map[padded]) result[padded] = map[padded];
      }
      return { statusCode: 200, headers, body: JSON.stringify({ status: "ok", resolved: result }) };
    }

    return { statusCode: 400, headers, body: JSON.stringify({ error: "Use action=batch or action=resolve" }) };
  } catch (err) {
    console.error("Proxy error:", err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
