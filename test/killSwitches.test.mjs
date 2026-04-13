import { describe, it } from "node:test";
import assert from "node:assert/strict";

describe("shouldApplyFix() helper", () => {
  function shouldApplyFix(fixName, env = {}) {
    if (env.CACHE_FIX_DISABLED === "1") return false;
    const skipKey = `CACHE_FIX_SKIP_${fixName.toUpperCase()}`;
    if (env[skipKey] === "1") return false;
    return true;
  }

  it("allows fix when no env vars set", () => {
    assert.equal(shouldApplyFix("relocate", {}), true);
  });

  it("blocks all fixes when DISABLED=1", () => {
    const env = { CACHE_FIX_DISABLED: "1" };
    assert.equal(shouldApplyFix("relocate", env), false);
    assert.equal(shouldApplyFix("fingerprint", env), false);
    assert.equal(shouldApplyFix("tool_sort", env), false);
    assert.equal(shouldApplyFix("ttl", env), false);
  });

  it("blocks individual fix when SKIP_*=1", () => {
    const env = { CACHE_FIX_SKIP_RELOCATE: "1" };
    assert.equal(shouldApplyFix("relocate", env), false);
    assert.equal(shouldApplyFix("fingerprint", env), true);
  });

  it("DISABLED takes precedence over individual SKIP", () => {
    const env = { CACHE_FIX_DISABLED: "1", CACHE_FIX_SKIP_RELOCATE: "0" };
    assert.equal(shouldApplyFix("relocate", env), false);
  });

  it("handles identity fix name", () => {
    const env = { CACHE_FIX_SKIP_IDENTITY: "1" };
    assert.equal(shouldApplyFix("identity", env), false);
    assert.equal(shouldApplyFix("relocate", env), true);
  });
});
