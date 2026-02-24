netlify/functions/dart-proxy.js
// Netlify Function: DART API Proxy
// Solves CORS — browser calls this function, this function calls DART API server-side

exports.handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers, body: "" };
  }

  // Get query params from the request
  const params = event.queryStringParameters || {};
  const endpoint = params.endpoint || "list.json";
  delete params.endpoint;

  // Add API key server-side (keeps it out of browser code)
  params.crtfc_key = "9775291c3b36cd68194e1d33e637f3783af7fcb0";

  // Build URL
  const qs = new URLSearchParams(params).toString();
  const url = `https://opendart.fss.or.kr/api/${endpoint}?${qs}`;

  try {
    const response = await fetch(url);
    const data = await response.text();

    return {
      statusCode: 200,
      headers,
      body: data,
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
