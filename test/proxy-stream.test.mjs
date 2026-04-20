import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Readable, Writable } from "node:stream";
import { streamResponse, createTelemetryRecord } from "../proxy/stream.mjs";

function sseChunks(events) {
  return events.map((e) => `data: ${JSON.stringify(e)}\n\n`);
}

function mockUpstream(chunks) {
  return Readable.from(chunks.map((c) => Buffer.from(c)));
}

function mockClientRes() {
  const written = [];
  let ended = false;
  const res = new Writable({
    write(chunk, _enc, cb) {
      written.push(chunk);
      cb();
    },
    final(cb) {
      ended = true;
      cb();
    },
  });
  res.writeHead = () => {};
  return { res, written: () => Buffer.concat(written).toString(), ended: () => ended };
}

describe("stream.mjs", () => {
  it("extracts telemetry from message_start", async () => {
    const telemetry = createTelemetryRecord();
    const events = [
      {
        type: "message_start",
        message: {
          model: "claude-sonnet-4-20250514",
          usage: { input_tokens: 100, cache_read_input_tokens: 80, cache_creation_input_tokens: 20 },
        },
      },
    ];
    const upstream = mockUpstream(sseChunks(events));
    const client = mockClientRes();
    await streamResponse(upstream, client.res, telemetry);
    assert.equal(telemetry.model, "claude-sonnet-4-20250514");
    assert.equal(telemetry.inputTokens, 100);
    assert.equal(telemetry.cacheRead, 80);
    assert.equal(telemetry.cacheCreation, 20);
  });

  it("extracts telemetry from message_delta", async () => {
    const telemetry = createTelemetryRecord();
    const events = [
      { type: "message_start", message: { model: "test", usage: { input_tokens: 10 } } },
      { type: "message_delta", usage: { output_tokens: 50 }, delta: { stop_reason: "end_turn" } },
    ];
    const upstream = mockUpstream(sseChunks(events));
    const client = mockClientRes();
    await streamResponse(upstream, client.res, telemetry);
    assert.equal(telemetry.outputTokens, 50);
    assert.equal(telemetry.stopReason, "end_turn");
  });

  it("forwards all bytes to client", async () => {
    const raw = "data: {\"type\":\"content_block_delta\"}\n\ndata: [DONE]\n\n";
    const upstream = mockUpstream([raw]);
    const client = mockClientRes();
    const telemetry = createTelemetryRecord();
    await streamResponse(upstream, client.res, telemetry);
    assert.equal(client.written(), raw);
    assert.ok(client.ended());
  });

  it("handles chunks split across SSE boundaries", async () => {
    const telemetry = createTelemetryRecord();
    const part1 = 'data: {"type":"message_start","message":{"model":"test","usa';
    const part2 = 'ge":{"input_tokens":42}}}\n\n';
    const upstream = mockUpstream([part1, part2]);
    const client = mockClientRes();
    await streamResponse(upstream, client.res, telemetry);
    assert.equal(telemetry.inputTokens, 42);
  });

  it("handles backpressure via drain", async () => {
    const telemetry = createTelemetryRecord();
    let drainCalled = false;
    const upstream = mockUpstream(["data: {\"type\":\"ping\"}\n\n"]);
    const res = new Writable({
      write(chunk, _enc, cb) {
        cb();
      },
      final(cb) { cb(); },
    });
    // Simulate backpressure by overriding write to return false once
    const origWrite = res.write.bind(res);
    let firstWrite = true;
    res.write = (chunk) => {
      if (firstWrite) {
        firstWrite = false;
        process.nextTick(() => {
          drainCalled = true;
          res.emit("drain");
        });
        return false;
      }
      return origWrite(chunk);
    };
    await streamResponse(upstream, res, telemetry);
    assert.ok(drainCalled);
  });
});
