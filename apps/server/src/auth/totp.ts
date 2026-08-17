import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import * as OTPAuth from "otpauth";

export type EncryptedTotpSecret = {
  algorithm: "aes-256-gcm";
  ciphertext: Uint8Array;
  keyVersion: number;
  nonce: Uint8Array;
};

export class TotpKeyring {
  readonly #currentVersion: number;
  readonly #keys: ReadonlyMap<number, Uint8Array>;

  public constructor(
    keys: ReadonlyMap<number, Uint8Array>,
    currentVersion: number,
  ) {
    const currentKey = keys.get(currentVersion);
    if (currentKey === undefined || currentKey.byteLength !== 32) {
      throw new Error("totp_keyring_invalid");
    }
    for (const key of keys.values()) {
      if (key.byteLength !== 32) {
        throw new Error("totp_keyring_invalid");
      }
    }
    this.#keys = keys;
    this.#currentVersion = currentVersion;
  }

  public encrypt(
    userId: string,
    authenticatorId: string,
    secret: string,
  ): EncryptedTotpSecret {
    const nonce = randomBytes(12);
    const key = this.#keys.get(this.#currentVersion);
    if (key === undefined) {
      throw new Error("totp_current_key_missing");
    }
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    cipher.setAAD(this.#aad(userId, authenticatorId, this.#currentVersion));
    const ciphertext = Buffer.concat([
      cipher.update(secret, "utf8"),
      cipher.final(),
      cipher.getAuthTag(),
    ]);
    return {
      algorithm: "aes-256-gcm",
      ciphertext,
      keyVersion: this.#currentVersion,
      nonce,
    };
  }

  public decrypt(
    userId: string,
    authenticatorId: string,
    envelope: EncryptedTotpSecret,
  ): string {
    const key = this.#keys.get(envelope.keyVersion);
    if (key === undefined) {
      throw new Error("totp_key_missing");
    }
    const ciphertext = Buffer.from(envelope.ciphertext);
    if (ciphertext.byteLength < 17) {
      throw new Error("totp_ciphertext_invalid");
    }
    const body = ciphertext.subarray(0, -16);
    const tag = ciphertext.subarray(-16);
    const decipher = createDecipheriv("aes-256-gcm", key, envelope.nonce);
    decipher.setAAD(this.#aad(userId, authenticatorId, envelope.keyVersion));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]).toString(
      "utf8",
    );
  }

  #aad(userId: string, authenticatorId: string, version: number): Buffer {
    return Buffer.from(
      `${userId}\u0000${authenticatorId}\u0000${version}`,
      "utf8",
    );
  }
}

export class TotpReplayGuard {
  #lastSuccessfulCounter: number | undefined;
  readonly #totp: OTPAuth.TOTP;

  public constructor(secret: string, label: string) {
    this.#totp = new OTPAuth.TOTP({
      algorithm: "SHA1",
      digits: 6,
      issuer: "Remote Control Hub",
      label,
      period: 30,
      secret,
    });
  }

  public verify(token: string, timestamp = Date.now()): boolean {
    const delta = this.#totp.validate({ timestamp, token, window: 1 });
    if (delta === null) {
      return false;
    }
    const counter = this.#totp.counter({ timestamp }) + delta;
    if (
      this.#lastSuccessfulCounter !== undefined &&
      counter <= this.#lastSuccessfulCounter
    ) {
      return false;
    }
    this.#lastSuccessfulCounter = counter;
    return true;
  }
}

export const generateRecoveryCodes = (count = 10): string[] =>
  Array.from({ length: count }, () =>
    randomBytes(10).toString("hex").toUpperCase(),
  );

export const hashRecoveryCode = (code: string): Buffer =>
  createHash("sha256").update(code, "utf8").digest();

export const verifyRecoveryCode = (
  digest: Uint8Array,
  code: string,
): boolean => {
  const candidate = hashRecoveryCode(code);
  return (
    digest.byteLength === candidate.byteLength &&
    timingSafeEqual(digest, candidate)
  );
};
