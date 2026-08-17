import { randomBytes } from "node:crypto";
import * as OTPAuth from "otpauth";
import { describe, expect, it } from "vitest";
import type { SessionMetadata } from "./session-store.js";
import {
  SecondFactorService,
  type SecondFactorChallenge,
  type SecondFactorChallengeRepository,
  type SecondFactorCredentialRepository,
  type StoredTotpAuthenticator,
} from "./second-factor.js";
import { TotpKeyring, hashRecoveryCode } from "./totp.js";

const NOW = new Date("2026-08-17T00:00:00.000Z");
const METADATA: SessionMetadata = {
  browser: "test",
  deviceType: "desktop",
  ipAddress: "127.0.0.1",
  location: "local",
  operatingSystem: "test",
};

class MemoryChallenges implements SecondFactorChallengeRepository {
  readonly records = new Map<
    string,
    { attempts: number; busy: boolean; challenge: SecondFactorChallenge }
  >();

  public async beginAttempt(
    tokenDigest: string,
  ): Promise<SecondFactorChallenge | undefined> {
    const record = this.records.get(tokenDigest);
    if (record === undefined || record.busy || record.attempts === 0) {
      return undefined;
    }
    record.busy = true;
    record.attempts -= 1;
    return record.challenge;
  }

  public async create(
    tokenDigest: string,
    challenge: SecondFactorChallenge,
    _ttlSeconds: number,
    attempts: number,
  ): Promise<void> {
    this.records.set(tokenDigest, { attempts, busy: false, challenge });
  }

  public async finishAttempt(
    tokenDigest: string,
    succeeded: boolean,
  ): Promise<void> {
    const record = this.records.get(tokenDigest);
    if (succeeded || record?.attempts === 0) {
      this.records.delete(tokenDigest);
    } else if (record !== undefined) {
      record.busy = false;
    }
  }
}

class MemoryCredentials implements SecondFactorCredentialRepository {
  recoveryDigest: Uint8Array | undefined;
  recoveryUsed = false;
  totp: StoredTotpAuthenticator | undefined;

  public async consumeRecoveryCode(
    _userId: string,
    codeDigest: Uint8Array,
  ): Promise<boolean> {
    if (
      this.recoveryUsed ||
      this.recoveryDigest === undefined ||
      Buffer.compare(
        Buffer.from(codeDigest),
        Buffer.from(this.recoveryDigest),
      ) !== 0
    ) {
      return false;
    }
    this.recoveryUsed = true;
    return true;
  }

  public async findTotp(): Promise<StoredTotpAuthenticator | undefined> {
    return this.totp;
  }

  public async recordTotpCounter(
    _authenticatorId: string,
    counter: number,
  ): Promise<boolean> {
    if (
      this.totp === undefined ||
      (this.totp.lastSuccessfulCounter !== undefined &&
        counter <= this.totp.lastSuccessfulCounter)
    ) {
      return false;
    }
    this.totp.lastSuccessfulCounter = counter;
    return true;
  }
}

const createSessions = () => ({
  create: async (
    userId: string,
    role: "admin" | "user",
    authStrength: "password_totp" | "password_recovery",
    metadata: SessionMetadata,
  ) => ({
    session: {
      ...metadata,
      absoluteExpiresAt: NOW.toISOString(),
      authStrength,
      createdAt: NOW.toISOString(),
      id: "session-1",
      idleExpiresAt: NOW.toISOString(),
      lastActiveAt: NOW.toISOString(),
      role,
      userId,
    },
    token: "session-token",
  }),
});

describe("second factor service", () => {
  it("creates a session after TOTP and rejects replay", async () => {
    const secret = new OTPAuth.Secret({ size: 20 });
    const keyring = new TotpKeyring(new Map([[1, randomBytes(32)]]), 1);
    const credentials = new MemoryCredentials();
    credentials.totp = {
      envelope: keyring.encrypt("user-1", "totp-1", secret.base32),
      id: "totp-1",
      label: "user@example.com",
    };
    const service = new SecondFactorService(
      new MemoryChallenges(),
      credentials,
      createSessions(),
      keyring,
      { attempts: 5, now: () => NOW, ttlSeconds: 300 },
    );
    const token = await service.begin({
      metadata: METADATA,
      role: "user",
      userId: "user-1",
    });
    const generator = new OTPAuth.TOTP({
      algorithm: "SHA1",
      digits: 6,
      issuer: "Remote Control Hub",
      label: "user@example.com",
      period: 30,
      secret,
    });
    const code = generator.generate({ timestamp: NOW.getTime() });

    const created = await service.complete(token, { code, type: "totp" });

    expect(created.session.authStrength).toBe("password_totp");
    await expect(
      service.complete(token, { code, type: "totp" }),
    ).rejects.toThrow("second_factor_invalid");
  });

  it("consumes a recovery code once and marks the session strength", async () => {
    const credentials = new MemoryCredentials();
    credentials.recoveryDigest = hashRecoveryCode("RECOVERY-CODE-1234");
    const service = new SecondFactorService(
      new MemoryChallenges(),
      credentials,
      createSessions(),
      undefined,
      { attempts: 5, now: () => NOW, ttlSeconds: 300 },
    );
    const token = await service.begin({
      metadata: METADATA,
      role: "admin",
      userId: "user-1",
    });

    const created = await service.complete(token, {
      recoveryCode: "recovery-code-1234",
      type: "recovery_code",
    });

    expect(created.session.authStrength).toBe("password_recovery");
    expect(credentials.recoveryUsed).toBe(true);
  });

  it("invalidates the challenge after the configured failed attempts", async () => {
    const service = new SecondFactorService(
      new MemoryChallenges(),
      new MemoryCredentials(),
      createSessions(),
      undefined,
      { attempts: 2, now: () => NOW, ttlSeconds: 300 },
    );
    const token = await service.begin({
      metadata: METADATA,
      role: "user",
      userId: "user-1",
    });

    await expect(
      service.complete(token, { code: "000000", type: "totp" }),
    ).rejects.toThrow("second_factor_invalid");
    await expect(
      service.complete(token, { code: "000000", type: "totp" }),
    ).rejects.toThrow("second_factor_invalid");
    await expect(
      service.complete(token, { code: "000000", type: "totp" }),
    ).rejects.toThrow("second_factor_invalid");
  });
});
