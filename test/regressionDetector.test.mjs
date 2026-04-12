import { describe, it } from "node:test";
import assert from "node:assert/strict";

function computeCacheRatio(usage) {
  if (!usage) return null;
  const read = usage.cache_read_input_tokens || 0;
  const creation = usage.cache_creation_input_tokens || 0;
  const input = usage.input_tokens || 0;
  const total = read + creation + input;
  if (total === 0) return null;
  return read / total;
}

function checkCacheRegression(history, minCalls, minRatio) {
  if (history.length < minCalls) return null;
  const recent = history.slice(-minCalls);
  const allLow = recent.every((h) => h.ratio < minRatio);
  if (allLow) {
    const avgRatio = recent.reduce((sum, h) => sum + h.ratio, 0) / recent.length;
    return {
      warning: true,
      avgRatio: Math.round(avgRatio * 100),
      calls: recent.length,
    };
  }
  return null;
}

describe("regression detector: computeCacheRatio", () => {
  it("computes ratio correctly", () => {
    const ratio = computeCacheRatio({
      cache_read_input_tokens: 80000,
      cache_creation_input_tokens: 10000,
      input_tokens: 10000,
    });
    assert.equal(ratio, 0.8);
  });

  it("returns null for missing usage", () => {
    assert.equal(computeCacheRatio(null), null);
    assert.equal(computeCacheRatio({}), null);
  });

  it("returns 0 when no cache reads", () => {
    const ratio = computeCacheRatio({
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 50000,
      input_tokens: 10000,
    });
    assert.equal(ratio, 0);
  });
});

describe("regression detector: checkCacheRegression", () => {
  it("returns null when not enough history", () => {
    const history = [{ ratio: 0.1 }, { ratio: 0.1 }];
    assert.equal(checkCacheRegression(history, 5, 0.5), null);
  });

  it("detects regression when all recent calls have low ratio", () => {
    const history = [
      { ratio: 0.9 },
      { ratio: 0.1 }, { ratio: 0.05 }, { ratio: 0.0 }, { ratio: 0.1 }, { ratio: 0.02 },
    ];
    const result = checkCacheRegression(history, 5, 0.5);
    assert.ok(result);
    assert.equal(result.warning, true);
  });

  it("no regression when some calls have good ratio", () => {
    const history = [
      { ratio: 0.1 }, { ratio: 0.9 }, { ratio: 0.1 }, { ratio: 0.8 }, { ratio: 0.1 },
    ];
    const result = checkCacheRegression(history, 5, 0.5);
    assert.equal(result, null);
  });
});
