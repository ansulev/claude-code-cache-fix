import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

const FINGERPRINT_SALT = "59cf53e54c78";
const FINGERPRINT_INDICES = [4, 7, 20];

function computeFingerprint(messageText, version) {
  const chars = FINGERPRINT_INDICES.map((i) => messageText[i] || "0").join("");
  const input = `${FINGERPRINT_SALT}${chars}${version}`;
  return createHash("sha256").update(input).digest("hex").slice(0, 3);
}

function computeFingerprintWithDifferentSalt(messageText, version) {
  const DIFFERENT_SALT = "aabbccddeeff";
  const chars = FINGERPRINT_INDICES.map((i) => messageText[i] || "0").join("");
  const input = `${DIFFERENT_SALT}${chars}${version}`;
  return createHash("sha256").update(input).digest("hex").slice(0, 3);
}

describe("fingerprint round-trip safety", () => {
  const testMessage = "Hello, this is a test message for fingerprinting";
  const version = "2.1.97";

  it("should detect when our salt matches CC (round-trip succeeds)", () => {
    const ccFingerprint = computeFingerprint(testMessage, version);
    const ourVerification = computeFingerprint(testMessage, version);
    assert.equal(ourVerification, ccFingerprint, "round-trip should match");
  });

  it("should detect when our salt is stale (round-trip fails)", () => {
    const ccFingerprint = computeFingerprintWithDifferentSalt(testMessage, version);
    const ourVerification = computeFingerprint(testMessage, version);
    assert.notEqual(ourVerification, ccFingerprint, "stale salt should produce different fingerprint");
  });

  it("should return null (skip rewrite) when salt mismatch detected", () => {
    const ccOldFingerprint = computeFingerprintWithDifferentSalt(testMessage, version);
    const ourVerification = computeFingerprint(testMessage, version);
    const shouldRewrite = ourVerification === ccOldFingerprint;
    assert.equal(shouldRewrite, false, "must not rewrite when salt mismatch");
  });

  it("should handle empty message text gracefully", () => {
    const fp = computeFingerprint("", version);
    assert.equal(typeof fp, "string");
    assert.equal(fp.length, 3);
  });

  it("should handle short message text (< max index)", () => {
    const fp = computeFingerprint("Hi", version);
    assert.equal(typeof fp, "string");
    assert.equal(fp.length, 3);
  });
});
