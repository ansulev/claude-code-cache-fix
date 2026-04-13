import { describe, it } from "node:test";
import assert from "node:assert/strict";

function formatTimeSince(isoString) {
  if (!isoString) return "never";
  const ms = Date.now() - new Date(isoString).getTime();
  const hours = Math.floor(ms / (1000 * 60 * 60));
  const days = Math.floor(hours / 24);
  if (days > 0) return `${days}d ago`;
  if (hours > 0) return `${hours}h ago`;
  const mins = Math.floor(ms / (1000 * 60));
  return `${mins}m ago`;
}

function formatFixStatus(fixName, fixStats, dormantThreshold = 5) {
  if (fixName === "relocate") {
    if (fixStats.resumeScanned >= dormantThreshold && fixStats.bugPresent === 0) {
      return `dormant(${fixStats.resumeScanned} clean sessions)`;
    }
  } else {
    if (fixStats.skipped >= dormantThreshold && fixStats.applied === 0) {
      return `dormant(${fixStats.skipped} skips)`;
    }
  }
  if (fixStats.safetyBlocked > 0) return `safety-blocked(${fixStats.safetyBlocked}x)`;
  if (fixStats.lastApplied) return `active(${formatTimeSince(fixStats.lastApplied)})`;
  return "waiting";
}

function generateHealthLine(stats) {
  const parts = [];
  for (const [name, fixStats] of Object.entries(stats.fixes)) {
    parts.push(`${name}=${formatFixStatus(name, fixStats)}`);
  }
  return `cache-fix health: ${parts.join(" ")}`;
}

describe("health line: formatTimeSince", () => {
  it("formats hours", () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    assert.equal(formatTimeSince(twoHoursAgo), "2h ago");
  });

  it("formats days", () => {
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
    assert.equal(formatTimeSince(threeDaysAgo), "3d ago");
  });

  it("formats minutes", () => {
    const fiveMinsAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    assert.equal(formatTimeSince(fiveMinsAgo), "5m ago");
  });

  it("handles null", () => {
    assert.equal(formatTimeSince(null), "never");
  });
});

describe("health line: formatFixStatus", () => {
  it("shows dormant for relocate with clean scans", () => {
    const fix = { applied: 0, skipped: 0, bugPresent: 0, resumeScanned: 5, lastApplied: null, lastScanned: new Date().toISOString() };
    assert.match(formatFixStatus("relocate", fix), /^dormant/);
  });

  it("shows active with timestamp", () => {
    const fix = { applied: 3, skipped: 10, lastApplied: new Date(Date.now() - 60000).toISOString() };
    assert.match(formatFixStatus("tool_sort", fix), /^active/);
  });

  it("shows safety-blocked for fingerprint", () => {
    const fix = { applied: 0, skipped: 3, safetyBlocked: 2, lastApplied: null };
    assert.match(formatFixStatus("fingerprint", fix), /^safety-blocked/);
  });

  it("shows waiting when never triggered", () => {
    const fix = { applied: 0, skipped: 0, lastApplied: null };
    assert.equal(formatFixStatus("ttl", fix), "waiting");
  });
});

describe("health line: generateHealthLine", () => {
  it("produces a single line with all fixes", () => {
    const stats = {
      fixes: {
        relocate: { applied: 5, skipped: 10, bugPresent: 2, resumeScanned: 3, lastApplied: new Date().toISOString(), lastScanned: new Date().toISOString() },
        fingerprint: { applied: 0, skipped: 20, safetyBlocked: 0, lastApplied: null },
        tool_sort: { applied: 1, skipped: 15, lastApplied: new Date().toISOString() },
        ttl: { applied: 8, skipped: 0, lastApplied: new Date().toISOString() },
        identity: { applied: 0, skipped: 0, lastApplied: null },
      },
    };
    const line = generateHealthLine(stats);
    assert.ok(line.startsWith("cache-fix health:"));
    assert.ok(line.includes("relocate="));
    assert.ok(line.includes("fingerprint="));
    assert.ok(line.includes("tool_sort="));
    assert.ok(line.includes("ttl="));
    assert.ok(line.includes("identity="));
  });
});
