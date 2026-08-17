import { randomUUID } from "node:crypto";
import * as OTPAuth from "otpauth";
import type { EncryptedTotpSecret, TotpKeyring } from "./totp.js";
import { generateRecoveryCodes, hashRecoveryCode } from "./totp.js";

export type TotpEnrollmentChallenge = {
  authenticatorId: string;
  label: string;
  secret: string;
};

export type TotpEnrollmentChallengeRepository = {
  beginAttempt: (
    userId: string,
  ) => Promise<TotpEnrollmentChallenge | undefined>;
  create: (
    userId: string,
    challenge: TotpEnrollmentChallenge,
    ttlSeconds: number,
    attempts: number,
  ) => Promise<void>;
  finishAttempt: (userId: string, succeeded: boolean) => Promise<void>;
};

export type TotpStatus = {
  enabled: boolean;
  lastUsedAt?: string;
  remainingRecoveryCodes: number;
};

export type TotpEnrollmentCredentialRepository = {
  disable: (userId: string) => Promise<boolean>;
  enable: (input: {
    authenticatorId: string;
    createdAt: Date;
    envelope: EncryptedTotpSecret;
    recoveryCodeDigests: readonly Uint8Array[];
    userId: string;
  }) => Promise<void>;
  getStatus: (userId: string) => Promise<TotpStatus>;
  replaceRecoveryCodes: (input: {
    createdAt: Date;
    recoveryCodeDigests: readonly Uint8Array[];
    userId: string;
  }) => Promise<boolean>;
};

type TotpEnrollmentOptions = {
  attempts: number;
  now?: () => Date;
  ttlSeconds: number;
};

export class TotpEnrollmentService {
  readonly #challenges: TotpEnrollmentChallengeRepository;
  readonly #credentials: TotpEnrollmentCredentialRepository;
  readonly #keyring: TotpKeyring | undefined;
  readonly #now: () => Date;
  readonly #options: Omit<TotpEnrollmentOptions, "now">;

  public constructor(
    challenges: TotpEnrollmentChallengeRepository,
    credentials: TotpEnrollmentCredentialRepository,
    keyring: TotpKeyring | undefined,
    options: TotpEnrollmentOptions,
  ) {
    if (options.attempts < 1 || options.ttlSeconds < 1) {
      throw new Error("totp_enrollment_configuration_invalid");
    }
    this.#challenges = challenges;
    this.#credentials = credentials;
    this.#keyring = keyring;
    this.#now = options.now ?? (() => new Date());
    this.#options = {
      attempts: options.attempts,
      ttlSeconds: options.ttlSeconds,
    };
  }

  public async begin(
    userId: string,
    label: string,
  ): Promise<{ expiresAt: string; otpauthUri: string; secret: string }> {
    if (this.#keyring === undefined) {
      throw new Error("totp_unavailable");
    }
    if ((await this.#credentials.getStatus(userId)).enabled) {
      throw new Error("totp_already_enabled");
    }
    const secret = new OTPAuth.Secret({ size: 20 });
    const challenge = {
      authenticatorId: randomUUID(),
      label,
      secret: secret.base32,
    };
    await this.#challenges.create(
      userId,
      challenge,
      this.#options.ttlSeconds,
      this.#options.attempts,
    );
    const totp = new OTPAuth.TOTP({
      algorithm: "SHA1",
      digits: 6,
      issuer: "Remote Control Hub",
      label,
      period: 30,
      secret,
    });
    return {
      expiresAt: new Date(
        this.#now().getTime() + this.#options.ttlSeconds * 1_000,
      ).toISOString(),
      otpauthUri: totp.toString(),
      secret: secret.base32,
    };
  }

  public async confirm(
    userId: string,
    code: string,
  ): Promise<{ recoveryCodes: string[] }> {
    const challenge = await this.#challenges.beginAttempt(userId);
    if (challenge === undefined || this.#keyring === undefined) {
      throw new Error("totp_enrollment_invalid");
    }
    let succeeded = false;
    try {
      const now = this.#now();
      const totp = new OTPAuth.TOTP({
        algorithm: "SHA1",
        digits: 6,
        issuer: "Remote Control Hub",
        label: challenge.label,
        period: 30,
        secret: challenge.secret,
      });
      if (
        totp.validate({ timestamp: now.getTime(), token: code, window: 1 }) ===
        null
      ) {
        throw new Error("totp_enrollment_invalid");
      }
      const recoveryCodes = generateRecoveryCodes();
      await this.#credentials.enable({
        authenticatorId: challenge.authenticatorId,
        createdAt: now,
        envelope: this.#keyring.encrypt(
          userId,
          challenge.authenticatorId,
          challenge.secret,
        ),
        recoveryCodeDigests: recoveryCodes.map(hashRecoveryCode),
        userId,
      });
      succeeded = true;
      return { recoveryCodes };
    } finally {
      await this.#challenges.finishAttempt(userId, succeeded);
    }
  }

  public getStatus(userId: string): Promise<TotpStatus> {
    return this.#credentials.getStatus(userId);
  }

  public async disable(userId: string): Promise<void> {
    if (!(await this.#credentials.disable(userId))) {
      throw new Error("totp_not_enabled");
    }
  }

  public async regenerateRecoveryCodes(
    userId: string,
  ): Promise<{ recoveryCodes: string[] }> {
    const recoveryCodes = generateRecoveryCodes();
    if (
      !(await this.#credentials.replaceRecoveryCodes({
        createdAt: this.#now(),
        recoveryCodeDigests: recoveryCodes.map(hashRecoveryCode),
        userId,
      }))
    ) {
      throw new Error("totp_not_enabled");
    }
    return { recoveryCodes };
  }
}
