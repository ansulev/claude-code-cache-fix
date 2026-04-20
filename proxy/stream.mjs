export function createTelemetryRecord() {
  return {
    model: null,
    requestedModel: null,
    inputTokens: 0,
    outputTokens: 0,
    cacheRead: 0,
    cacheCreation: 0,
    stopReason: null,
  };
}

function tryParseSSEEvent(line, telemetry) {
  if (!line.startsWith("data: ")) return;
  const jsonStr = line.slice(6);
  if (jsonStr === "[DONE]") return;

  let event;
  try {
    event = JSON.parse(jsonStr);
  } catch {
    return;
  }

  if (event.type === "message_start" && event.message) {
    const msg = event.message;
    telemetry.model = msg.model || null;
    if (msg.usage) {
      telemetry.inputTokens = msg.usage.input_tokens || 0;
      telemetry.cacheRead = msg.usage.cache_read_input_tokens || 0;
      telemetry.cacheCreation = msg.usage.cache_creation_input_tokens || 0;
    }
  } else if (event.type === "message_delta") {
    if (event.usage) {
      telemetry.outputTokens = event.usage.output_tokens || 0;
    }
    telemetry.stopReason = event.delta?.stop_reason || null;
  }
}

export async function streamResponse(upstreamRes, clientRes, telemetry) {
  let buffer = "";

  for await (const chunk of upstreamRes) {
    const text = chunk.toString();
    buffer += text;

    const lines = buffer.split("\n");
    buffer = lines.pop();

    for (const line of lines) {
      tryParseSSEEvent(line, telemetry);
    }

    const ok = clientRes.write(chunk);
    if (!ok) {
      await new Promise((resolve) => clientRes.once("drain", resolve));
    }
  }

  if (buffer.length > 0) {
    tryParseSSEEvent(buffer, telemetry);
  }

  clientRes.end();
  return telemetry;
}
