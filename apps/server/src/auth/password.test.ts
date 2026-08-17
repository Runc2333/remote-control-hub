import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "./password.js";

describe("password hashing", () => {
  it("uses Argon2id and verifies without exposing the password", async () => {
    const digest = await hashPassword("correct horse battery staple");

    expect(digest).toMatch(/^\$argon2id\$/u);
    await expect(
      verifyPassword(digest, "correct horse battery staple"),
    ).resolves.toBe(true);
    await expect(verifyPassword(digest, "incorrect password")).resolves.toBe(
      false,
    );
  });
});
