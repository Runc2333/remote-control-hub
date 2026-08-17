import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Redis } from "ioredis";

export type ActionConfirmation = {
  action: string;
  actorId: string;
  payloadDigest: string;
  sessionId: string;
  targetId: string;
};

export type ActionConfirmationRepository = {
  consume: (tokenDigest: string) => Promise<ActionConfirmation | undefined>;
  create: (
    tokenDigest: string,
    confirmation: ActionConfirmation,
    ttlSeconds: number,
  ) => Promise<void>;
};

const canonicalize = (value: unknown): string => {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("confirmation_payload_invalid");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`)
      .join(",")}}`;
  }
  throw new Error("confirmation_payload_invalid");
};

const digest = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");

const digestPayload = (payload: unknown): string =>
  digest(canonicalize(payload));
const digestToken = (token: string): string => digest(token);

const equalDigest = (left: string, right: string): boolean => {
  const leftBuffer = Buffer.from(left, "hex");
  const rightBuffer = Buffer.from(right, "hex");
  return (
    leftBuffer.byteLength === rightBuffer.byteLength &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
};

const parseConfirmation = (
  value: string | null,
): ActionConfirmation | undefined => {
  if (value === null) {
    return undefined;
  }
  const parsed: unknown = JSON.parse(value);
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("confirmation_record_invalid");
  }
  const record = parsed as Record<string, unknown>;
  if (
    typeof record.action !== "string" ||
    typeof record.actorId !== "string" ||
    typeof record.payloadDigest !== "string" ||
    typeof record.sessionId !== "string" ||
    typeof record.targetId !== "string"
  ) {
    throw new Error("confirmation_record_invalid");
  }
  return {
    action: record.action,
    actorId: record.actorId,
    payloadDigest: record.payloadDigest,
    sessionId: record.sessionId,
    targetId: record.targetId,
  };
};

export class ActionConfirmationManager {
  readonly #repository: ActionConfirmationRepository;
  readonly #ttlSeconds: number;

  public constructor(
    repository: ActionConfirmationRepository,
    ttlSeconds: number,
  ) {
    if (ttlSeconds < 1) {
      throw new Error("confirmation_configuration_invalid");
    }
    this.#repository = repository;
    this.#ttlSeconds = ttlSeconds;
  }

  public async issue(input: {
    action: string;
    actorId: string;
    payload: unknown;
    sessionId: string;
    targetId: string;
  }): Promise<{ expiresAt: string; token: string }> {
    const token = randomBytes(32).toString("base64url");
    await this.#repository.create(
      digestToken(token),
      {
        action: input.action,
        actorId: input.actorId,
        payloadDigest: digestPayload(input.payload),
        sessionId: input.sessionId,
        targetId: input.targetId,
      },
      this.#ttlSeconds,
    );
    return {
      expiresAt: new Date(Date.now() + this.#ttlSeconds * 1_000).toISOString(),
      token,
    };
  }

  public async consume(input: {
    action: string;
    actorId: string;
    payload: unknown;
    sessionId: string;
    targetId: string;
    token: string;
  }): Promise<void> {
    const confirmation = await this.#repository.consume(
      digestToken(input.token),
    );
    if (
      confirmation === undefined ||
      confirmation.action !== input.action ||
      confirmation.actorId !== input.actorId ||
      confirmation.sessionId !== input.sessionId ||
      confirmation.targetId !== input.targetId ||
      !equalDigest(confirmation.payloadDigest, digestPayload(input.payload))
    ) {
      throw new Error("confirmation_invalid");
    }
  }
}

export class RedisActionConfirmationRepository implements ActionConfirmationRepository {
  readonly #redis: Redis;

  public constructor(redis: Redis) {
    this.#redis = redis;
  }

  public async consume(
    tokenDigest: string,
  ): Promise<ActionConfirmation | undefined> {
    return parseConfirmation(await this.#redis.getdel(this.#key(tokenDigest)));
  }

  public async create(
    tokenDigest: string,
    confirmation: ActionConfirmation,
    ttlSeconds: number,
  ): Promise<void> {
    const result = await this.#redis.set(
      this.#key(tokenDigest),
      JSON.stringify(confirmation),
      "EX",
      ttlSeconds,
      "NX",
    );
    if (result !== "OK") {
      throw new Error("confirmation_conflict");
    }
  }

  #key(tokenDigest: string): string {
    return `rch:action-confirmation:${tokenDigest}`;
  }
}
