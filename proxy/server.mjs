import http from "node:http";
import config from "./config.mjs";
import { forwardRequest } from "./upstream.mjs";
import { streamResponse, createTelemetryRecord } from "./stream.mjs";

function collectBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function handleMessages(clientReq, clientRes) {
  const abortController = new AbortController();

  clientReq.on("close", () => {
    if (!clientRes.writableEnded) {
      abortController.abort();
    }
  });

  const body = await collectBody(clientReq);

  let requestedModel = null;
  try {
    const parsed = JSON.parse(body);
    if (parsed.model) requestedModel = parsed.model;
  } catch {}

  let upstreamRes, responseHeaders, statusCode;

  try {
    ({ upstreamRes, responseHeaders, statusCode } = await forwardRequest(
      clientReq,
      body,
      abortController.signal
    ));
  } catch (err) {
    if (abortController.signal.aborted) return;
    clientRes.writeHead(502, { "content-type": "application/json" });
    clientRes.end(JSON.stringify({ error: "upstream_error", message: err.message }));
    return;
  }

  clientRes.writeHead(statusCode, responseHeaders);

  if (statusCode >= 400) {
    upstreamRes.pipe(clientRes);
    return;
  }

  const telemetry = createTelemetryRecord();
  telemetry.requestedModel = requestedModel;

  upstreamRes.on("error", (err) => {
    if (!clientRes.writableEnded) {
      clientRes.destroy(err);
    }
  });

  try {
    await streamResponse(upstreamRes, clientRes, telemetry);
  } catch (err) {
    if (!clientRes.writableEnded) {
      clientRes.destroy(err);
    }
  }
}

function handleHealth(_req, res) {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ status: "ok" }));
}

function handleNotFound(_req, res) {
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "not_found" }));
}

const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    return handleHealth(req, res);
  }
  if (req.method === "POST" && req.url?.startsWith("/v1/messages")) {
    return handleMessages(req, res);
  }
  handleNotFound(req, res);
});

function shutdown() {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

server.listen(config.port, config.bind, () => {
  const addr = server.address();
  process.stdout.write(`proxy listening on ${addr.address}:${addr.port}\n`);
});

export { server };
