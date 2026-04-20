import https from "node:https";
import { URL } from "node:url";
import config from "./config.mjs";

const STRIP_REQUEST_HEADERS = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "te",
  "upgrade",
]);

const STRIP_RESPONSE_HEADERS = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
]);

function shouldStripRequestHeader(name) {
  const lower = name.toLowerCase();
  return STRIP_REQUEST_HEADERS.has(lower) || lower.startsWith("proxy-");
}

function shouldStripResponseHeader(name) {
  return STRIP_RESPONSE_HEADERS.has(name.toLowerCase());
}

function buildUpstreamHeaders(incomingHeaders, upstreamHostname) {
  const headers = {};
  for (const [key, value] of Object.entries(incomingHeaders)) {
    if (shouldStripRequestHeader(key)) continue;
    headers[key] = value;
  }
  headers["host"] = upstreamHostname;
  headers["accept-encoding"] = "identity";
  return headers;
}

function filterResponseHeaders(rawHeaders) {
  const headers = {};
  for (const [key, value] of Object.entries(rawHeaders)) {
    if (shouldStripResponseHeader(key)) continue;
    headers[key] = value;
  }
  return headers;
}

export function forwardRequest(clientReq, body, signal) {
  return new Promise((resolve, reject) => {
    const upstreamUrl = new URL(clientReq.url, config.upstream);

    const headers = buildUpstreamHeaders(clientReq.headers, upstreamUrl.hostname);
    if (body) {
      headers["content-length"] = Buffer.byteLength(body).toString();
    }

    const options = {
      hostname: upstreamUrl.hostname,
      port: upstreamUrl.port || 443,
      path: upstreamUrl.pathname + upstreamUrl.search,
      method: clientReq.method,
      headers,
      timeout: config.timeout,
    };

    const upstreamReq = https.request(options, (upstreamRes) => {
      const responseHeaders = filterResponseHeaders(upstreamRes.headers);
      resolve({ upstreamRes, responseHeaders, statusCode: upstreamRes.statusCode });
    });

    upstreamReq.on("error", reject);
    upstreamReq.on("timeout", () => {
      upstreamReq.destroy(new Error("Upstream timeout"));
    });

    if (signal) {
      signal.addEventListener("abort", () => {
        upstreamReq.destroy(new Error("Request aborted"));
      }, { once: true });
    }

    if (body) {
      upstreamReq.end(body);
    } else {
      upstreamReq.end();
    }
  });
}
