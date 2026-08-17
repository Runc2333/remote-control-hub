import { createHash, randomBytes } from "node:crypto";
import type { Redis } from "ioredis";
import type { UserRole } from "@remote-control-hub/contracts";

export type TemporaryPasswordRecord = {
  role: UserRole;
  userId: string;
};

export type TemporaryPasswordRepository = {
  consume: (digest: string) => Promise<TemporaryPasswordRecord | undefined>;
  create: (
    digest: string,
    record: TemporaryPasswordRecord,
    ttlSeconds: number,
  ) => Promise<void>;
};

const digestToken = (token: string): string =>
  createHash("sha256").update(token, "utf8").digest("hex");

const isTemporaryPasswordRecord = (
  value: unknown,
): value is TemporaryPasswordRecord => {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    (record.role === "admin" || record.role === "user") &&
    typeof record.userId === "string"
  );
};

const CONSUME_SCRIPT = `
local value = redis.call("GET", KEYS[1])
if value then
  redis.call("DEL", KEYS[1])
end
return value
`;

export class TemporaryPasswordManager {
  readonly #repository: TemporaryPasswordRepository;
  readonly #ttlSeconds: number;

  public constructor(
    repository: TemporaryPasswordRepository,
    ttlSeconds = 5 * 60,
  ) {
    if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds <= 0) {
      throw new Error("temporary_password_ttl_invalid");
    }
    this.#repository = repository;
    this.#ttlSeconds = ttlSeconds;
  }

  public async create(record: TemporaryPasswordRecord): Promise<string> {
    const token = randomBytes(32).toString("base64url");
    await this.#repository.create(digestToken(token), record, this.#ttlSeconds);
    return token;
  }

  public consume(token: string): Promise<TemporaryPasswordRecord | undefined> {
    return this.#repository.consume(digestToken(token));
  }
}

export class RedisTemporaryPasswordRepository implements TemporaryPasswordRepository {
  readonly #redis: Redis;

  public constructor(redis: Redis) {
    this.#redis = redis;
  }

  public async consume(
    digest: string,
  ): Promise<TemporaryPasswordRecord | undefined> {
    const value = await this.#redis.eval(CONSUME_SCRIPT, 1, this.#key(digest));
    if (value === null) {
      return undefined;
    }
    if (typeof value !== "string") {
      throw new Error("temporary_password_record_invalid");
    }
    const parsed: unknown = JSON.parse(value);
    if (!isTemporaryPasswordRecord(parsed)) {
      throw new Error("temporary_password_record_invalid");
    }
    return parsed;
  }

  public async create(
    digest: string,
    record: TemporaryPasswordRecord,
    ttlSeconds: number,
  ): Promise<void> {
    await this.#redis.set(
      this.#key(digest),
      JSON.stringify(record),
      "EX",
      ttlSeconds,
    );
  }

  #key(digest: string): string {
    return `rch:temporary-password:${digest}`;
  }
}
