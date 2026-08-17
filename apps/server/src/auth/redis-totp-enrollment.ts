import type { Redis } from "ioredis";
import type {
  TotpEnrollmentChallenge,
  TotpEnrollmentChallengeRepository,
} from "./totp-enrollment.js";

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

const parseChallenge = (
  value: unknown,
): TotpEnrollmentChallenge | undefined => {
  if (typeof value !== "string") {
    return undefined;
  }
  const parsed: unknown = JSON.parse(value);
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("totp_enrollment_record_invalid");
  }
  const record = parsed as Record<string, unknown>;
  if (
    typeof record.authenticatorId !== "string" ||
    typeof record.label !== "string" ||
    typeof record.secret !== "string"
  ) {
    throw new Error("totp_enrollment_record_invalid");
  }
  return {
    authenticatorId: record.authenticatorId,
    label: record.label,
    secret: record.secret,
  };
};

export class RedisTotpEnrollmentChallengeRepository implements TotpEnrollmentChallengeRepository {
  readonly #redis: Redis;

  public constructor(redis: Redis) {
    this.#redis = redis;
  }

  public async beginAttempt(
    userId: string,
  ): Promise<TotpEnrollmentChallenge | undefined> {
    return parseChallenge(
      await this.#redis.eval(BEGIN_ATTEMPT_SCRIPT, 1, this.#key(userId)),
    );
  }

  public async create(
    userId: string,
    challenge: TotpEnrollmentChallenge,
    ttlSeconds: number,
    attempts: number,
  ): Promise<void> {
    const result = await this.#redis.set(
      this.#key(userId),
      JSON.stringify({ attempts, busy: false, challenge }),
      "EX",
      ttlSeconds,
    );
    if (result !== "OK") {
      throw new Error("totp_enrollment_unavailable");
    }
  }

  public async finishAttempt(
    userId: string,
    succeeded: boolean,
  ): Promise<void> {
    await this.#redis.eval(
      FINISH_ATTEMPT_SCRIPT,
      1,
      this.#key(userId),
      succeeded ? "1" : "0",
    );
  }

  #key(userId: string): string {
    return `rch:totp-enrollment:${userId}`;
  }
}
