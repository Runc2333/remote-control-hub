import { createHash, randomBytes } from "node:crypto";
import type { Redis } from "ioredis";

export type WebauthnChallenge =
  | { challenge: string; kind: "authentication" }
  | { challenge: string; kind: "registration"; userId: string }
  | { challenge: string; kind: "step_up"; userId: string };

export type WebauthnChallengeRepository = {
  consume: (tokenDigest: string) => Promise<WebauthnChallenge | undefined>;
  create: (
    tokenDigest: string,
    challenge: WebauthnChallenge,
    ttlSeconds: number,
  ) => Promise<void>;
};

const digestToken = (token: string): string =>
  createHash("sha256").update(token, "utf8").digest("hex");

const parseChallenge = (
  value: string | null,
): WebauthnChallenge | undefined => {
  if (value === null) {
    return undefined;
  }
  const parsed: unknown = JSON.parse(value);
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("webauthn_challenge_invalid");
  }
  const record = parsed as Record<string, unknown>;
  if (typeof record.challenge !== "string") {
    throw new Error("webauthn_challenge_invalid");
  }
  if (record.kind === "authentication") {
    return { challenge: record.challenge, kind: "authentication" };
  }
  if (record.kind === "registration" && typeof record.userId === "string") {
    return {
      challenge: record.challenge,
      kind: "registration",
      userId: record.userId,
    };
  }
  if (record.kind === "step_up" && typeof record.userId === "string") {
    return {
      challenge: record.challenge,
      kind: "step_up",
      userId: record.userId,
    };
  }
  throw new Error("webauthn_challenge_invalid");
};

export class WebauthnChallengeManager {
  readonly #repository: WebauthnChallengeRepository;
  readonly #ttlSeconds: number;

  public constructor(
    repository: WebauthnChallengeRepository,
    ttlSeconds: number,
  ) {
    if (ttlSeconds < 1) {
      throw new Error("webauthn_challenge_configuration_invalid");
    }
    this.#repository = repository;
    this.#ttlSeconds = ttlSeconds;
  }

  public async create(challenge: WebauthnChallenge): Promise<string> {
    const token = randomBytes(32).toString("base64url");
    await this.#repository.create(
      digestToken(token),
      challenge,
      this.#ttlSeconds,
    );
    return token;
  }

  public consume(token: string): Promise<WebauthnChallenge | undefined> {
    return this.#repository.consume(digestToken(token));
  }
}

export class RedisWebauthnChallengeRepository implements WebauthnChallengeRepository {
  readonly #redis: Redis;

  public constructor(redis: Redis) {
    this.#redis = redis;
  }

  public async consume(
    tokenDigest: string,
  ): Promise<WebauthnChallenge | undefined> {
    return parseChallenge(await this.#redis.getdel(this.#key(tokenDigest)));
  }

  public async create(
    tokenDigest: string,
    challenge: WebauthnChallenge,
    ttlSeconds: number,
  ): Promise<void> {
    const result = await this.#redis.set(
      this.#key(tokenDigest),
      JSON.stringify(challenge),
      "EX",
      ttlSeconds,
      "NX",
    );
    if (result !== "OK") {
      throw new Error("webauthn_challenge_conflict");
    }
  }

  #key(tokenDigest: string): string {
    return `rch:webauthn:${tokenDigest}`;
  }
}
