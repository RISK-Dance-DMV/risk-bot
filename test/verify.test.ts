import { describe, expect, it } from "vitest";
import { diagnoseSecret, secretsMatch } from "../src/discord/verify";

describe("secretsMatch", () => {
  it("matches identical secrets", () => {
    expect(secretsMatch("s3cr3t", "s3cr3t")).toBe(true);
  });

  it("ignores a trailing newline, the classic invisible 401", () => {
    expect(secretsMatch("s3cr3t\n", "s3cr3t")).toBe(true);
    expect(secretsMatch("  s3cr3t  ", "s3cr3t")).toBe(true);
  });

  it("still rejects a genuinely different secret", () => {
    expect(secretsMatch("s3cr3t", "s3cr3u")).toBe(false);
    expect(secretsMatch("s3cr3t", "s3cr3tt")).toBe(false);
  });

  it("rejects empties rather than matching them to each other", () => {
    expect(secretsMatch("", "")).toBe(false);
    expect(secretsMatch("   ", "s3cr3t")).toBe(false);
  });
});

describe("diagnoseSecret", () => {
  it("passes a good secret", () => {
    expect(diagnoseSecret("s3cr3t", "s3cr3t")).toBeNull();
    expect(diagnoseSecret("s3cr3t\n", "s3cr3t")).toBeNull();
  });

  it("distinguishes a missing header from a wrong value", () => {
    expect(diagnoseSecret("", "s3cr3t")).toContain("no X-RISK-Secret header");
    expect(diagnoseSecret("nope12", "s3cr3t")).toContain("right length");
  });

  it("points at a length difference separately", () => {
    expect(diagnoseSecret("short", "s3cr3t")).toContain("different length");
  });

  it("names an unconfigured Worker rather than blaming the caller", () => {
    expect(diagnoseSecret("s3cr3t", "")).toContain("Worker has no INBOUND_SECRET");
  });

  it("never echoes either secret", () => {
    const message = diagnoseSecret("hunter2", "s3cr3t") ?? "";
    expect(message).not.toContain("hunter2");
    expect(message).not.toContain("s3cr3t");
  });
});
