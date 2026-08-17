import { randomBytes } from "node:crypto";
import * as OTPAuth from "otpauth";
import { describe, expect, it } from "vitest";
import {
  TotpEnrollmentService,
  type TotpEnrollmentChallenge,
  type TotpEnrollmentChallengeRepository,
  type TotpEnrollmentCredentialRepository,
  type TotpStatus,
} from "./totp-enrollment.js";
import { TotpKeyring } from "./totp.js";

const NOW = new Date("2026-08-17T00:00:00.000Z");

class MemoryChallenges implements TotpEnrollmentChallengeRepository {
  record:
    | { attempts: number; busy: boolean; challenge: TotpEnrollmentChallenge }
    | undefined;

  public async beginAttempt(): Promise<TotpEnrollmentChallenge | undefined> {
    if (
      this.record === undefined ||
      this.record.busy ||
      this.record.attempts === 0
    ) {
      return undefined;
    }
    this.record.busy = true;
    this.record.attempts -= 1;
    return this.record.challenge;
  }

  public async create(
    _userId: string,
    challenge: TotpEnrollmentChallenge,
    _ttlSeconds: number,
    attempts: number,
  ): Promise<void> {
    this.record = { attempts, busy: false, challenge };
  }

  public async finishAttempt(
    _userId: string,
    succeeded: boolean,
  ): Promise<void> {
    if (succeeded || this.record?.attempts === 0) {
      this.record = undefined;
    } else if (this.record !== undefined) {
      this.record.busy = false;
    }
  }
}

class MemoryCredentials implements TotpEnrollmentCredentialRepository {
  enabledInput:
    Parameters<TotpEnrollmentCredentialRepository["enable"]>[0] | undefined;
  status: TotpStatus = { enabled: false, remainingRecoveryCodes: 0 };

  public async disable(): Promise<boolean> {
    if (!this.status.enabled) {
      return false;
    }
    this.status = { enabled: false, remainingRecoveryCodes: 0 };
    return true;
  }

  public async enable(
    input: Parameters<TotpEnrollmentCredentialRepository["enable"]>[0],
  ): Promise<void> {
    this.enabledInput = input;
    this.status = {
      enabled: true,
      remainingRecoveryCodes: input.recoveryCodeDigests.length,
    };
  }

  public async getStatus(): Promise<TotpStatus> {
    return this.status;
  }

  public async replaceRecoveryCodes(
    input: Parameters<
      TotpEnrollmentCredentialRepository["replaceRecoveryCodes"]
    >[0],
  ): Promise<boolean> {
    if (!this.status.enabled) {
      return false;
    }
    this.status = {
      enabled: true,
      remainingRecoveryCodes: input.recoveryCodeDigests.length,
    };
    return true;
  }
}

describe("TOTP enrollment service", () => {
  it("persists only an encrypted secret after confirmation", async () => {
    const challenges = new MemoryChallenges();
    const credentials = new MemoryCredentials();
    const keyring = new TotpKeyring(new Map([[1, randomBytes(32)]]), 1);
    const service = new TotpEnrollmentService(
      challenges,
      credentials,
      keyring,
      { attempts: 5, now: () => NOW, ttlSeconds: 300 },
    );
    const enrollment = await service.begin("user-1", "user@example.com");
    const generator = new OTPAuth.TOTP({
      algorithm: "SHA1",
      digits: 6,
      issuer: "Remote Control Hub",
      label: "user@example.com",
      period: 30,
      secret: enrollment.secret,
    });

    const result = await service.confirm(
      "user-1",
      generator.generate({ timestamp: NOW.getTime() }),
    );

    const persisted = credentials.enabledInput;
    expect(persisted).toBeDefined();
    if (persisted === undefined) {
      throw new Error("totp_not_persisted");
    }
    expect(result.recoveryCodes).toHaveLength(10);
    expect(persisted.recoveryCodeDigests).toHaveLength(10);
    expect(
      keyring.decrypt("user-1", persisted.authenticatorId, persisted.envelope),
    ).toBe(enrollment.secret);
    expect(challenges.record).toBeUndefined();
  });

  it("does not start another enrollment when TOTP is enabled", async () => {
    const credentials = new MemoryCredentials();
    credentials.status = { enabled: true, remainingRecoveryCodes: 8 };
    const service = new TotpEnrollmentService(
      new MemoryChallenges(),
      credentials,
      new TotpKeyring(new Map([[1, randomBytes(32)]]), 1),
      { attempts: 5, now: () => NOW, ttlSeconds: 300 },
    );

    await expect(service.begin("user-1", "user@example.com")).rejects.toThrow(
      "totp_already_enabled",
    );
  });

  it("requires a configured keyring", async () => {
    const service = new TotpEnrollmentService(
      new MemoryChallenges(),
      new MemoryCredentials(),
      undefined,
      { attempts: 5, now: () => NOW, ttlSeconds: 300 },
    );

    await expect(service.begin("user-1", "user@example.com")).rejects.toThrow(
      "totp_unavailable",
    );
  });

  it("regenerates recovery codes and disables the authenticator", async () => {
    const credentials = new MemoryCredentials();
    credentials.status = { enabled: true, remainingRecoveryCodes: 2 };
    const service = new TotpEnrollmentService(
      new MemoryChallenges(),
      credentials,
      new TotpKeyring(new Map([[1, randomBytes(32)]]), 1),
      { attempts: 5, now: () => NOW, ttlSeconds: 300 },
    );

    const regenerated = await service.regenerateRecoveryCodes("user-1");
    expect(regenerated.recoveryCodes).toHaveLength(10);
    expect(credentials.status.remainingRecoveryCodes).toBe(10);

    await service.disable("user-1");
    expect(credentials.status).toEqual({
      enabled: false,
      remainingRecoveryCodes: 0,
    });
    await expect(service.disable("user-1")).rejects.toThrow("totp_not_enabled");
  });
});
