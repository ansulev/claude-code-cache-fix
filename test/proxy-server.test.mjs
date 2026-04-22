import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

let server;
let proxyPort;

async function startProxy() {
  const testPort = 19801 + Math.floor(Math.random() * 1000);
  process.env.CACHE_FIX_PROXY_PORT = String(testPort);
  process.env.CACHE_FIX_PROXY_BIND = "127.0.0.1";
  const mod = await import("../proxy/server.mjs");
  server = mod.server;
  await new Promise((resolve) => {
    if (server.listening) resolve();
    else server.on("listening", resolve);
  });
  proxyPort = server.address().port;
}

function request(method, path, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: "127.0.0.1", port: proxyPort, method, path },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() });
        });
      }
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

describe("proxy server", () => {
  before(async () => {
    await startProxy();
  });

  after((_, done) => {
    server.close(done);
  });

  it("GET /health returns 200 with status ok", async () => {
    const res = await request("GET", "/health");
    assert.equal(res.status, 200);
    const parsed = JSON.parse(res.body);
    assert.equal(parsed.status, "ok");
  });

  it("GET /unknown returns 404", async () => {
    const res = await request("GET", "/unknown");
    assert.equal(res.status, 404);
    const parsed = JSON.parse(res.body);
    assert.equal(parsed.error, "not_found");
  });

  it("POST to non-messages path returns 404", async () => {
    const res = await request("POST", "/v1/completions", "{}");
    assert.equal(res.status, 404);
  });

  it("POST /v1/messages routes to upstream (may get auth error or 502)", async () => {
    const res = await request("POST", "/v1/messages", JSON.stringify({ model: "test", messages: [] }));
    // Without valid auth we expect either 401 from upstream or 502 if unreachable
    assert.ok([401, 502].includes(res.status));
  });
});
