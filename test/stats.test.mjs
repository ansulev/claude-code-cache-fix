import { describe, it } from "node:test";
import assert from "node:assert/strict";

// Pure logic tests — no file I/O needed

const STATS_SCHEMA = {
  relocate: { applied: 0, skipped: 0, bugPresent: 0, resumeScanned: 0, lastApplied: null, lastScanned: null },
  fingerprint: { applied: 0, skipped: 0, safetyBlocked: 0, lastApplied: null },
  tool_sort: { applied: 0, skipped: 0, lastApplied: null },
  ttl: { applied: 0, skipped: 0, lastApplied: null },
  identity: { applied: 0, skipped: 0, lastApplied: null },
};

function createEmptyStats() {
  return {
    version: 1,
    created: new Date().toISOString(),
    lastUpdated: null,
    fixes: JSON.parse(JSON.stringify(STATS_SCHEMA)),
  };
}

function recordFixResult(stats, fixName, result) {
  if (!stats.fixes[fixName]) return stats;
  const now = new Date().toISOString();
  stats.lastUpdated = now;
  if (result === "applied") {
    stats.fixes[fixName].applied++;
    stats.fixes[fixName].lastApplied = now;
  } else if (result === "skipped") {
    stats.fixes[fixName].skipped++;
  } else if (result === "safety_blocked") {
    stats.fixes[fixName].safetyBlocked = (stats.fixes[fixName].safetyBlocked || 0) + 1;
  }
  return stats;
}

function recordRelocateScan(stats, bugFound) {
  const now = new Date().toISOString();
  stats.lastUpdated = now;
  stats.fixes.relocate.resumeScanned++;
  stats.fixes.relocate.lastScanned = now;
  if (bugFound) {
    stats.fixes.relocate.bugPresent++;
  }
  return stats;
}

function isDormant(stats, fixName, threshold) {
  const fix = stats.fixes[fixName];
  if (!fix) return false;
  if (fixName === "relocate") {
    return fix.resumeScanned >= threshold && fix.bugPresent === 0;
  }
  return fix.skipped >= threshold && fix.applied === 0;
}

describe("stats: createEmptyStats", () => {
  it("creates stats with all fix types", () => {
    const stats = createEmptyStats();
    assert.ok(stats.fixes.relocate);
    assert.ok(stats.fixes.fingerprint);
    assert.ok(stats.fixes.tool_sort);
    assert.ok(stats.fixes.ttl);
    assert.ok(stats.fixes.identity);
    assert.equal(stats.version, 1);
  });

  it("initializes all counters to 0", () => {
    const stats = createEmptyStats();
    assert.equal(stats.fixes.relocate.applied, 0);
    assert.equal(stats.fixes.relocate.skipped, 0);
    assert.equal(stats.fixes.relocate.bugPresent, 0);
    assert.equal(stats.fixes.relocate.resumeScanned, 0);
  });
});

describe("stats: recordFixResult", () => {
  it("increments applied counter and sets lastApplied", () => {
    const stats = createEmptyStats();
    recordFixResult(stats, "relocate", "applied");
    assert.equal(stats.fixes.relocate.applied, 1);
    assert.ok(stats.fixes.relocate.lastApplied);
  });

  it("increments skipped counter", () => {
    const stats = createEmptyStats();
    recordFixResult(stats, "fingerprint", "skipped");
    assert.equal(stats.fixes.fingerprint.skipped, 1);
  });

  it("increments safety_blocked counter", () => {
    const stats = createEmptyStats();
    recordFixResult(stats, "fingerprint", "safety_blocked");
    assert.equal(stats.fixes.fingerprint.safetyBlocked, 1);
  });

  it("ignores unknown fix names", () => {
    const stats = createEmptyStats();
    recordFixResult(stats, "unknown_fix", "applied");
    assert.ok(!stats.fixes.unknown_fix);
  });
});

describe("stats: recordRelocateScan", () => {
  it("tracks resume sessions scanned", () => {
    const stats = createEmptyStats();
    recordRelocateScan(stats, false);
    assert.equal(stats.fixes.relocate.resumeScanned, 1);
    assert.equal(stats.fixes.relocate.bugPresent, 0);
  });

  it("tracks bug-present detections", () => {
    const stats = createEmptyStats();
    recordRelocateScan(stats, true);
    assert.equal(stats.fixes.relocate.resumeScanned, 1);
    assert.equal(stats.fixes.relocate.bugPresent, 1);
  });
});

describe("stats: isDormant", () => {
  it("relocate dormant after N clean resume scans", () => {
    const stats = createEmptyStats();
    for (let i = 0; i < 5; i++) recordRelocateScan(stats, false);
    assert.equal(isDormant(stats, "relocate", 5), true);
  });

  it("relocate NOT dormant if any bug detected", () => {
    const stats = createEmptyStats();
    for (let i = 0; i < 4; i++) recordRelocateScan(stats, false);
    recordRelocateScan(stats, true);
    assert.equal(isDormant(stats, "relocate", 5), false);
  });

  it("relocate NOT dormant if not enough scans", () => {
    const stats = createEmptyStats();
    for (let i = 0; i < 3; i++) recordRelocateScan(stats, false);
    assert.equal(isDormant(stats, "relocate", 5), false);
  });

  it("other fixes dormant after N skips with 0 applies", () => {
    const stats = createEmptyStats();
    for (let i = 0; i < 5; i++) recordFixResult(stats, "tool_sort", "skipped");
    assert.equal(isDormant(stats, "tool_sort", 5), true);
  });

  it("other fixes NOT dormant if ever applied", () => {
    const stats = createEmptyStats();
    recordFixResult(stats, "tool_sort", "applied");
    for (let i = 0; i < 10; i++) recordFixResult(stats, "tool_sort", "skipped");
    assert.equal(isDormant(stats, "tool_sort", 5), false);
  });
});
