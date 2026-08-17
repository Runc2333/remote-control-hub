import { randomBytes } from "node:crypto";
import * as OTPAuth from "otpauth";
import { describe, expect, it } from "vitest";
import {
  TotpKeyring,
  TotpReplayGuard,
  generateRecoveryCodes,
  hashRecoveryCode,
  verifyRecoveryCode,
} from "./totp.js";

describe("TOTP security", () => {
  it("binds encrypted secrets to the user, authenticator and key version", () => {
    const keyring = new TotpKeyring(new Map([[1, randomBytes(32)]]), 1);
    const encrypted = keyring.encrypt("user-1", "authenticator-1", "SECRET");

    expect(keyring.decrypt("user-1", "authenticator-1", encrypted)).toBe(
      "SECRET",
    );
    expect(() =>
      keyring.decrypt("user-2", "authenticator-1", encrypted),
    ).toThrow();
  });

  it("rejects a repeated successful time step", () => {
    const timestamp = Date.UTC(2026, 7, 17, 0, 0, 0);
    const secret = new OTPAuth.Secret({ size: 20 });
    const generator = new OTPAuth.TOTP({
      algorithm: "SHA1",
      digits: 6,
      issuer: "Remote Control Hub",
      label: "user@example.com",
      period: 30,
      secret,
    });
    const guard = new TotpReplayGuard(secret.base32, "user@example.com");
    const token = generator.generate({ timestamp });

    expect(guard.verify(token, timestamp)).toBe(true);
    expect(guard.verify(token, timestamp)).toBe(false);
  });

  it("stores recovery codes as constant-length digests", () => {
    const [code] = generateRecoveryCodes(1);
    if (code === undefined) {
      throw new Error("recovery_code_missing");
    }
    const digest = hashRecoveryCode(code);

    expect(digest).toHaveLength(32);
    expect(verifyRecoveryCode(digest, code)).toBe(true);
    expect(verifyRecoveryCode(digest, `${code}0`)).toBe(false);
  });
});
