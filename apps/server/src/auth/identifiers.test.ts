import { describe, expect, it } from "vitest";
import { normalizeIdentifier } from "./identifiers.js";

describe("normalizeIdentifier", () => {
  it("normalizes email without provider-specific rewriting", () => {
    expect(
      normalizeIdentifier("email", "  Alice.Example+tag@EXAMPLE.COM "),
    ).toBe("alice.example+tag@example.com");
  });

  it("normalizes international phone numbers to E.164", () => {
    expect(normalizeIdentifier("phone", "138 0013 8000", "CN")).toBe(
      "+8613800138000",
    );
  });

  it("rejects invalid identifiers", () => {
    expect(() => normalizeIdentifier("email", "missing-domain")).toThrow(
      "identifier_invalid",
    );
  });
});
