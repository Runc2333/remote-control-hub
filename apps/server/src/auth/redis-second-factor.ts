import type { Redis } from "ioredis";
import type {
  SecondFactorChallenge,
  SecondFactorChallengeRepository,
} from "./second-factor.js";

const BEGIN_ATTEMPT_SCRIPT = `
local value = redis.call("GET", KEYS[1])
if not value then return nil end
local record = cjson.decode(value)
if record.busy or record.attempts <= 0 then return nil end
local ttl = redis.call("PTTL", KEYS[1])
if ttl <= 0 then return nil end
record.busy = true
record.attempts = record.attempts - 1
redis.call("SET", KEYS[1], cjson.encode(record), "PX", ttl, "XX")
return cjson.encode(record.challenge)
`;

const FINISH_ATTEMPT_SCRIPT = `
if ARGV[1] == "1" then
  return redis.call("DEL", KEYS[1])
end
local value = redis.call("GET", KEYS[1])
if not value then return 0 end
local record = cjson.decode(value)
if record.attempts <= 0 then
  return redis.call("DEL", KEYS[1])
end
local ttl = redis.call("PTTL", KEYS[1])
if ttl <= 0 then return 0 end
record.busy = false
redis.call("SET", KEYS[1], cjson.encode(record), "PX", ttl, "XX")
return 1
`;

const isSecondFactorChallenge = (
  value: unknown,
): value is SecondFactorChallenge => {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.userId !== "string" ||
    (record.role !== "admin" && record.role !== "user") ||
    typeof record.metadata !== "object" ||
    record.metadata === null
  ) {
    return false;
  }
  const metadata = record.metadata as Record<string, unknown>;
  return (
    typeof metadata.browser === "string" &&
    typeof metadata.deviceType === "string" &&
    typeof metadata.ipAddress === "string" &&
    typeof metadata.location === "string" &&
    typeof metadata.operatingSystem === "string"
  );
};

const parseChallenge = (value: unknown): SecondFactorChallenge | undefined => {
  if (typeof value !== "string") {
    return undefined;
  }
  const parsed: unknown = JSON.parse(value);
  if (!isSecondFactorChallenge(parsed)) {
    throw new Error("second_factor_challenge_invalid");
  }
  return parsed;
};

export class RedisSecondFactorChallengeRepository implements SecondFactorChallengeRepository {
  readonly #redis: Redis;

  public constructor(redis: Redis) {
    this.#redis = redis;
  }

  public async beginAttempt(
    tokenDigest: string,
  ): Promise<SecondFactorChallenge | undefined> {
    return parseChallenge(
      await this.#redis.eval(BEGIN_ATTEMPT_SCRIPT, 1, this.#key(tokenDigest)),
    );
  }

  public async create(
    tokenDigest: string,
    challenge: SecondFactorChallenge,
    ttlSeconds: number,
    attempts: number,
  ): Promise<void> {
    const result = await this.#redis.set(
      this.#key(tokenDigest),
      JSON.stringify({ attempts, busy: false, challenge }),
      "EX",
      ttlSeconds,
      "NX",
    );
    if (result !== "OK") {
      throw new Error("second_factor_challenge_conflict");
    }
  }

  public async finishAttempt(
    tokenDigest: string,
    succeeded: boolean,
  ): Promise<void> {
    await this.#redis.eval(
      FINISH_ATTEMPT_SCRIPT,
      1,
      this.#key(tokenDigest),
      succeeded ? "1" : "0",
    );
  }

  #key(tokenDigest: string): string {
    return `rch:second-factor:${tokenDigest}`;
  }
}
