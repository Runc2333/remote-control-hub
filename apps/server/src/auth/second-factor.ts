import { createHash, randomBytes } from "node:crypto";
import * as OTPAuth from "otpauth";
import type { AuthStrength, UserRole } from "@remote-control-hub/contracts";
import type {
  CreatedSession,
  SessionManager,
  SessionMetadata,
} from "./session-store.js";
import type { EncryptedTotpSecret, TotpKeyring } from "./totp.js";
import { hashRecoveryCode } from "./totp.js";

export type SecondFactorChallenge = {
  metadata: SessionMetadata;
  role: UserRole;
  userId: string;
};

export type SecondFactorChallengeRepository = {
  beginAttempt: (
    tokenDigest: string,
  ) => Promise<SecondFactorChallenge | undefined>;
  create: (
    tokenDigest: string,
    challenge: SecondFactorChallenge,
    ttlSeconds: number,
    attempts: number,
  ) => Promise<void>;
  finishAttempt: (tokenDigest: string, succeeded: boolean) => Promise<void>;
};

export type StoredTotpAuthenticator = {
  envelope: EncryptedTotpSecret;
  id: string;
  label: string;
  lastSuccessfulCounter?: number;
};

export type SecondFactorCredentialRepository = {
  consumeRecoveryCode: (
    userId: string,
    codeDigest: Uint8Array,
    usedAt: Date,
  ) => Promise<boolean>;
  findTotp: (userId: string) => Promise<StoredTotpAuthenticator | undefined>;
  recordTotpCounter: (
    authenticatorId: string,
    counter: number,
    usedAt: Date,
  ) => Promise<boolean>;
};

export type SecondFactorCredential =
  | { recoveryCode: string; type: "recovery_code" }
  | { code: string; type: "totp" };

type SecondFactorOptions = {
  attempts: number;
  now?: () => Date;
  ttlSeconds: number;
};

const digestToken = (token: string): string =>
  createHash("sha256").update(token, "utf8").digest("hex");

const counterForToken = (
  secret: string,
  label: string,
  token: string,
  timestamp: number,
): number | undefined => {
  const totp = new OTPAuth.TOTP({
    algorithm: "SHA1",
    digits: 6,
    issuer: "Remote Control Hub",
    label,
    period: 30,
    secret,
  });
  const delta = totp.validate({ timestamp, token, window: 1 });
  return delta === null ? undefined : totp.counter({ timestamp }) + delta;
};

export class SecondFactorService {
  readonly #challenges: SecondFactorChallengeRepository;
  readonly #credentials: SecondFactorCredentialRepository;
  readonly #keyring: TotpKeyring | undefined;
  readonly #now: () => Date;
  readonly #options: Omit<SecondFactorOptions, "now">;
  readonly #sessions: Pick<SessionManager, "create">;

  public constructor(
    challenges: SecondFactorChallengeRepository,
    credentials: SecondFactorCredentialRepository,
    sessions: Pick<SessionManager, "create">,
    keyring: TotpKeyring | undefined,
    options: SecondFactorOptions,
  ) {
    if (options.attempts < 1 || options.ttlSeconds < 1) {
      throw new Error("second_factor_configuration_invalid");
    }
    this.#challenges = challenges;
    this.#credentials = credentials;
    this.#sessions = sessions;
    this.#keyring = keyring;
    this.#now = options.now ?? (() => new Date());
    this.#options = {
      attempts: options.attempts,
      ttlSeconds: options.ttlSeconds,
    };
  }

  public async begin(challenge: SecondFactorChallenge): Promise<string> {
    const token = randomBytes(32).toString("base64url");
    await this.#challenges.create(
      digestToken(token),
      challenge,
      this.#options.ttlSeconds,
      this.#options.attempts,
    );
    return token;
  }

  public async complete(
    token: string,
    credential: SecondFactorCredential,
  ): Promise<CreatedSession> {
    const tokenDigest = digestToken(token);
    const challenge = await this.#challenges.beginAttempt(tokenDigest);
    if (challenge === undefined) {
      throw new Error("second_factor_invalid");
    }
    let succeeded = false;
    try {
      const authStrength = await this.#verify(challenge.userId, credential);
      if (authStrength === undefined) {
        throw new Error("second_factor_invalid");
      }
      succeeded = true;
      return await this.#sessions.create(
        challenge.userId,
        challenge.role,
        authStrength,
        challenge.metadata,
      );
    } finally {
      await this.#challenges.finishAttempt(tokenDigest, succeeded);
    }
  }

  public async verifyTotp(userId: string, code: string): Promise<boolean> {
    return (await this.#verify(userId, { code, type: "totp" })) !== undefined;
  }

  async #verify(
    userId: string,
    credential: SecondFactorCredential,
  ): Promise<AuthStrength | undefined> {
    const now = this.#now();
    if (credential.type === "recovery_code") {
      const consumed = await this.#credentials.consumeRecoveryCode(
        userId,
        hashRecoveryCode(credential.recoveryCode.trim().toUpperCase()),
        now,
      );
      return consumed ? "password_recovery" : undefined;
    }
    if (!/^\d{6}$/u.test(credential.code) || this.#keyring === undefined) {
      return undefined;
    }
    const authenticator = await this.#credentials.findTotp(userId);
    if (authenticator === undefined) {
      return undefined;
    }
    const secret = this.#keyring.decrypt(
      userId,
      authenticator.id,
      authenticator.envelope,
    );
    const counter = counterForToken(
      secret,
      authenticator.label,
      credential.code,
      now.getTime(),
    );
    if (
      counter === undefined ||
      (authenticator.lastSuccessfulCounter !== undefined &&
        counter <= authenticator.lastSuccessfulCounter)
    ) {
      return undefined;
    }
    return (await this.#credentials.recordTotpCounter(
      authenticator.id,
      counter,
      now,
    ))
      ? "password_totp"
      : undefined;
  }
}
