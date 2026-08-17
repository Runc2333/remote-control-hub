import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

describe("server configuration", () => {
  it("accepts only explicit trusted proxy IP addresses and CIDRs", () => {
    const config = loadConfig({
      TRUSTED_PROXIES: JSON.stringify(["127.0.0.1", "10.0.0.0/8", "::1/128"]),
    });

    expect(config.trustedProxies).toEqual([
      "127.0.0.1",
      "10.0.0.0/8",
      "::1/128",
    ]);
    expect(() =>
      loadConfig({ TRUSTED_PROXIES: JSON.stringify(["all"]) }),
    ).toThrow("TRUSTED_PROXIES entries must be IP addresses or CIDRs");
    expect(() =>
      loadConfig({ TRUSTED_PROXIES: JSON.stringify(["10.0.0.0/99"]) }),
    ).toThrow("TRUSTED_PROXIES entries must be IP addresses or CIDRs");
  });
});
