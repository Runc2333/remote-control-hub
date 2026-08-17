import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Redis } from "ioredis";
import type { AuthStrength, UserRole } from "@remote-control-hub/contracts";

export type SessionMetadata = {
  browser: string;
  deviceType: string;
  ipAddress: string;
  location: string;
  operatingSystem: string;
};

export type StoredSession = SessionMetadata & {
  absoluteExpiresAt: string;
  authStrength: AuthStrength;
  createdAt: string;
  id: string;
  idleExpiresAt: string;
  lastActiveAt: string;
  role: UserRole;
  strongAuthenticatedAt?: string;
  userId: string;
  authenticatorId?: string;
};

export type SessionRepository = {
  create: (
    digest: string,
    session: StoredSession,
    ttlSeconds: number,
  ) => Promise<void>;
  find: (digest: string) => Promise<StoredSession | undefined>;
  list: (userId: string, nowMilliseconds: number) => Promise<StoredSession[]>;
  revoke: (digest: string, userId: string) => Promise<void>;
  revokeAll: (userId: string) => Promise<void>;
  revokeById: (userId: string, sessionId: string) => Promise<boolean>;
  revokeByAuthenticator: (
    userId: string,
    authenticatorId: string,
  ) => Promise<number>;
  revokeOthers: (userId: string, currentSessionId: string) => Promise<number>;
  update: (
    digest: string,
    session: StoredSession,
    ttlSeconds: number,
  ) => Promise<void>;
};

export type SessionManagerOptions = {
  absoluteTtlMilliseconds: number;
  activityWriteIntervalMilliseconds: number;
  idleTtlMilliseconds: number;
  now?: () => Date;
};

export type CreatedSession = {
  session: StoredSession;
  token: string;
};

const digestToken = (token: string): string =>
  createHash("sha256").update(token, "utf8").digest("hex");

const MAX_ACTIVE_BROWSER_SESSIONS = 200;

const remainingTtlSeconds = (session: StoredSession, now: Date): number => {
  const remainingMilliseconds = Math.min(
    Date.parse(session.absoluteExpiresAt) - now.getTime(),
    Date.parse(session.idleExpiresAt) - now.getTime(),
  );
  return Math.max(0, Math.ceil(remainingMilliseconds / 1000));
};

export class SessionManager {
  readonly #now: () => Date;
  readonly #options: Omit<SessionManagerOptions, "now">;
  readonly #repository: SessionRepository;

  public constructor(
    repository: SessionRepository,
    options: SessionManagerOptions,
  ) {
    if (
      options.absoluteTtlMilliseconds <= 0 ||
      options.activityWriteIntervalMilliseconds < 0 ||
      options.idleTtlMilliseconds <= 0 ||
      options.idleTtlMilliseconds > options.absoluteTtlMilliseconds
    ) {
      throw new Error("session_configuration_invalid");
    }
    this.#repository = repository;
    this.#now = options.now ?? (() => new Date());
    this.#options = {
      absoluteTtlMilliseconds: options.absoluteTtlMilliseconds,
      activityWriteIntervalMilliseconds:
        options.activityWriteIntervalMilliseconds,
      idleTtlMilliseconds: options.idleTtlMilliseconds,
    };
  }

  public async create(
    userId: string,
    role: UserRole,
    authStrength: AuthStrength,
    metadata: SessionMetadata,
    authenticatorId?: string,
  ): Promise<CreatedSession> {
    const now = this.#now();
    const token = randomBytes(32).toString("base64url");
    const session: StoredSession = {
      ...metadata,
      absoluteExpiresAt: new Date(
        now.getTime() + this.#options.absoluteTtlMilliseconds,
      ).toISOString(),
      authStrength,
      createdAt: now.toISOString(),
      id: randomUUID(),
      idleExpiresAt: new Date(
        now.getTime() + this.#options.idleTtlMilliseconds,
      ).toISOString(),
      lastActiveAt: now.toISOString(),
      role,
      ...(authStrength === "password_recovery"
        ? {}
        : { strongAuthenticatedAt: now.toISOString() }),
      userId,
      ...(authenticatorId === undefined ? {} : { authenticatorId }),
    };
    await this.#repository.create(
      digestToken(token),
      session,
      remainingTtlSeconds(session, now),
    );
    return { session, token };
  }

  public async authenticate(token: string): Promise<StoredSession | undefined> {
    const digest = digestToken(token);
    const session = await this.#repository.find(digest);
    if (session === undefined) {
      return undefined;
    }
    const now = this.#now();
    const ttlSeconds = remainingTtlSeconds(session, now);
    if (ttlSeconds === 0) {
      await this.#repository.revoke(digest, session.userId);
      return undefined;
    }
    if (
      now.getTime() - Date.parse(session.lastActiveAt) >=
      this.#options.activityWriteIntervalMilliseconds
    ) {
      const updated = {
        ...session,
        idleExpiresAt: new Date(
          Math.min(
            now.getTime() + this.#options.idleTtlMilliseconds,
            Date.parse(session.absoluteExpiresAt),
          ),
        ).toISOString(),
        lastActiveAt: now.toISOString(),
      };
      await this.#repository.update(
        digest,
        updated,
        remainingTtlSeconds(updated, now),
      );
      return updated;
    }
    return session;
  }

  public async list(userId: string): Promise<StoredSession[]> {
    const now = this.#now();
    return this.#repository.list(userId, now.getTime());
  }

  public async markStrongAuthenticated(
    token: string,
    userId: string,
  ): Promise<StoredSession> {
    const digest = digestToken(token);
    const session = await this.#repository.find(digest);
    const now = this.#now();
    if (
      session === undefined ||
      session.userId !== userId ||
      session.authStrength === "password_recovery" ||
      remainingTtlSeconds(session, now) === 0
    ) {
      throw new Error("step_up_invalid");
    }
    const updated = {
      ...session,
      strongAuthenticatedAt: now.toISOString(),
    };
    await this.#repository.update(
      digest,
      updated,
      remainingTtlSeconds(updated, now),
    );
    return updated;
  }

  public async revoke(token: string, userId: string): Promise<void> {
    await this.#repository.revoke(digestToken(token), userId);
  }

  public async revokeAll(userId: string): Promise<void> {
    await this.#repository.revokeAll(userId);
  }

  public async revokeById(userId: string, sessionId: string): Promise<boolean> {
    return this.#repository.revokeById(userId, sessionId);
  }

  public async revokeByAuthenticator(
    userId: string,
    authenticatorId: string,
  ): Promise<number> {
    return this.#repository.revokeByAuthenticator(userId, authenticatorId);
  }

  public async revokeOthers(
    userId: string,
    currentSessionId: string,
  ): Promise<number> {
    return this.#repository.revokeOthers(userId, currentSessionId);
  }
}

const CREATE_SCRIPT = `
redis.call("ZREMRANGEBYSCORE", KEYS[3], "-inf", ARGV[5])
if not redis.call("ZSCORE", KEYS[3], ARGV[4]) and redis.call("ZCARD", KEYS[3]) >= tonumber(ARGV[6]) then
  return 0
end
redis.call("SET", KEYS[1], ARGV[1], "EX", ARGV[2])
redis.call("ZADD", KEYS[2], ARGV[3], ARGV[4])
local latest = redis.call("ZRANGE", KEYS[2], -1, -1, "WITHSCORES")
if #latest == 2 then
  redis.call("PEXPIREAT", KEYS[2], latest[2])
end
redis.call("ZADD", KEYS[3], ARGV[3], ARGV[4])
return 1
`;

const REVOKE_SCRIPT = `
redis.call("DEL", KEYS[1])
redis.call("ZREM", KEYS[2], ARGV[1])
redis.call("ZREM", KEYS[3], ARGV[1])
return 1
`;

const REVOKE_ALL_SCRIPT = `
local digests = redis.call("ZRANGE", KEYS[1], 0, -1)
for _, digest in ipairs(digests) do
  redis.call("DEL", ARGV[1] .. digest)
  redis.call("ZREM", KEYS[2], digest)
end
redis.call("DEL", KEYS[1])
return #digests
`;

const REVOKE_BY_ID_SCRIPT = `
local digests = redis.call("ZRANGE", KEYS[1], 0, -1)
for _, digest in ipairs(digests) do
  local session_key = ARGV[1] .. digest
  local value = redis.call("GET", session_key)
  if value then
    local session = cjson.decode(value)
    if session.id == ARGV[2] then
      redis.call("DEL", session_key)
      redis.call("ZREM", KEYS[1], digest)
      redis.call("ZREM", KEYS[2], digest)
      return 1
    end
  else
    redis.call("ZREM", KEYS[1], digest)
    redis.call("ZREM", KEYS[2], digest)
  end
end
return 0
`;

const REVOKE_OTHERS_SCRIPT = `
local revoked = 0
local digests = redis.call("ZRANGE", KEYS[1], 0, -1)
for _, digest in ipairs(digests) do
  local session_key = ARGV[1] .. digest
  local value = redis.call("GET", session_key)
  if value then
    local session = cjson.decode(value)
    if session.id ~= ARGV[2] then
      redis.call("DEL", session_key)
      redis.call("ZREM", KEYS[1], digest)
      redis.call("ZREM", KEYS[2], digest)
      revoked = revoked + 1
    end
  else
    redis.call("ZREM", KEYS[1], digest)
    redis.call("ZREM", KEYS[2], digest)
  end
end
return revoked
`;

const REVOKE_BY_AUTHENTICATOR_SCRIPT = `
local revoked = 0
local digests = redis.call("ZRANGE", KEYS[1], 0, -1)
for _, digest in ipairs(digests) do
  local session_key = ARGV[1] .. digest
  local value = redis.call("GET", session_key)
  if value then
    local session = cjson.decode(value)
    if session.authenticatorId == ARGV[2] then
      redis.call("DEL", session_key)
      redis.call("ZREM", KEYS[1], digest)
      redis.call("ZREM", KEYS[2], digest)
      revoked = revoked + 1
    end
  else
    redis.call("ZREM", KEYS[1], digest)
    redis.call("ZREM", KEYS[2], digest)
  end
end
return revoked
`;

const isStoredSession = (value: unknown): value is StoredSession => {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.absoluteExpiresAt === "string" &&
    typeof record.authStrength === "string" &&
    typeof record.browser === "string" &&
    typeof record.createdAt === "string" &&
    typeof record.deviceType === "string" &&
    typeof record.id === "string" &&
    typeof record.idleExpiresAt === "string" &&
    typeof record.ipAddress === "string" &&
    typeof record.lastActiveAt === "string" &&
    typeof record.location === "string" &&
    typeof record.operatingSystem === "string" &&
    (record.role === "admin" || record.role === "user") &&
    (record.strongAuthenticatedAt === undefined ||
      typeof record.strongAuthenticatedAt === "string") &&
    typeof record.userId === "string" &&
    (record.authenticatorId === undefined ||
      typeof record.authenticatorId === "string")
  );
};

const parseStoredSession = (
  value: string | null,
): StoredSession | undefined => {
  if (value === null) {
    return undefined;
  }
  const parsed: unknown = JSON.parse(value);
  if (!isStoredSession(parsed)) {
    throw new Error("session_record_invalid");
  }
  return parsed;
};

export class RedisSessionRepository implements SessionRepository {
  readonly #redis: Redis;

  public constructor(redis: Redis) {
    this.#redis = redis;
  }

  public async create(
    digest: string,
    session: StoredSession,
    ttlSeconds: number,
  ): Promise<void> {
    const result = await this.#redis.eval(
      CREATE_SCRIPT,
      3,
      this.#sessionKey(digest),
      this.#userKey(session.userId),
      this.#globalKey(),
      JSON.stringify(session),
      ttlSeconds.toString(),
      Date.parse(session.idleExpiresAt).toString(),
      digest,
      Date.now().toString(),
      MAX_ACTIVE_BROWSER_SESSIONS.toString(),
    );
    if (result !== 1) {
      throw new Error("browser_session_capacity_exceeded");
    }
  }

  public async find(digest: string): Promise<StoredSession | undefined> {
    return parseStoredSession(await this.#redis.get(this.#sessionKey(digest)));
  }

  public async list(
    userId: string,
    nowMilliseconds: number,
  ): Promise<StoredSession[]> {
    const userKey = this.#userKey(userId);
    await this.#redis.zremrangebyscore(
      userKey,
      "-inf",
      nowMilliseconds.toString(),
    );
    await this.#redis.zremrangebyscore(
      this.#globalKey(),
      "-inf",
      nowMilliseconds.toString(),
    );
    const digests = await this.#redis.zrange(userKey, "0", "-1");
    if (digests.length === 0) {
      return [];
    }
    const values = await this.#redis.mget(
      digests.map((digest) => this.#sessionKey(digest)),
    );
    return values.flatMap((value) => {
      const session = parseStoredSession(value);
      return session === undefined ? [] : [session];
    });
  }

  public async revoke(digest: string, userId: string): Promise<void> {
    await this.#redis.eval(
      REVOKE_SCRIPT,
      3,
      this.#sessionKey(digest),
      this.#userKey(userId),
      this.#globalKey(),
      digest,
    );
  }

  public async revokeAll(userId: string): Promise<void> {
    await this.#redis.eval(
      REVOKE_ALL_SCRIPT,
      2,
      this.#userKey(userId),
      this.#globalKey(),
      this.#sessionKey(""),
    );
  }

  public async revokeById(userId: string, sessionId: string): Promise<boolean> {
    const result = await this.#redis.eval(
      REVOKE_BY_ID_SCRIPT,
      2,
      this.#userKey(userId),
      this.#globalKey(),
      this.#sessionKey(""),
      sessionId,
    );
    return result === 1;
  }

  public async revokeByAuthenticator(
    userId: string,
    authenticatorId: string,
  ): Promise<number> {
    const result = await this.#redis.eval(
      REVOKE_BY_AUTHENTICATOR_SCRIPT,
      2,
      this.#userKey(userId),
      this.#globalKey(),
      this.#sessionKey(""),
      authenticatorId,
    );
    if (typeof result !== "number") {
      throw new Error("session_revoke_result_invalid");
    }
    return result;
  }

  public async revokeOthers(
    userId: string,
    currentSessionId: string,
  ): Promise<number> {
    const result = await this.#redis.eval(
      REVOKE_OTHERS_SCRIPT,
      2,
      this.#userKey(userId),
      this.#globalKey(),
      this.#sessionKey(""),
      currentSessionId,
    );
    if (typeof result !== "number") {
      throw new Error("session_revoke_result_invalid");
    }
    return result;
  }

  public async update(
    digest: string,
    session: StoredSession,
    ttlSeconds: number,
  ): Promise<void> {
    await this.create(digest, session, ttlSeconds);
  }

  #sessionKey(digest: string): string {
    return `rch:session:${digest}`;
  }

  #userKey(userId: string): string {
    return `rch:user-sessions:${userId}`;
  }

  #globalKey(): string {
    return "rch:active-sessions";
  }
}
