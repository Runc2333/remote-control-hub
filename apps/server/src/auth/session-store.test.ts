import { describe, expect, it } from "vitest";
import type { Redis } from "ioredis";
import {
  RedisSessionRepository,
  SessionManager,
  type SessionRepository,
  type StoredSession,
} from "./session-store.js";

class MemorySessionRepository implements SessionRepository {
  readonly records = new Map<string, StoredSession>();
  readonly userDigests = new Map<string, Set<string>>();
  updates = 0;

  public async create(digest: string, session: StoredSession): Promise<void> {
    this.records.set(digest, session);
    const digests = this.userDigests.get(session.userId) ?? new Set<string>();
    digests.add(digest);
    this.userDigests.set(session.userId, digests);
  }

  public async find(digest: string): Promise<StoredSession | undefined> {
    return this.records.get(digest);
  }

  public async list(userId: string): Promise<StoredSession[]> {
    return [...(this.userDigests.get(userId) ?? [])].flatMap((digest) => {
      const session = this.records.get(digest);
      return session === undefined ? [] : [session];
    });
  }

  public async revoke(digest: string, userId: string): Promise<void> {
    this.records.delete(digest);
    this.userDigests.get(userId)?.delete(digest);
  }

  public async revokeAll(userId: string): Promise<void> {
    for (const digest of this.userDigests.get(userId) ?? []) {
      this.records.delete(digest);
    }
    this.userDigests.delete(userId);
  }

  public async revokeById(userId: string, sessionId: string): Promise<boolean> {
    for (const digest of this.userDigests.get(userId) ?? []) {
      if (this.records.get(digest)?.id === sessionId) {
        await this.revoke(digest, userId);
        return true;
      }
    }
    return false;
  }

  public async revokeByAuthenticator(
    userId: string,
    authenticatorId: string,
  ): Promise<number> {
    let revoked = 0;
    for (const digest of [...(this.userDigests.get(userId) ?? [])]) {
      if (this.records.get(digest)?.authenticatorId === authenticatorId) {
        await this.revoke(digest, userId);
        revoked += 1;
      }
    }
    return revoked;
  }

  public async revokeOthers(
    userId: string,
    currentSessionId: string,
  ): Promise<number> {
    let revoked = 0;
    for (const digest of [...(this.userDigests.get(userId) ?? [])]) {
      if (this.records.get(digest)?.id !== currentSessionId) {
        await this.revoke(digest, userId);
        revoked += 1;
      }
    }
    return revoked;
  }

  public async update(digest: string, session: StoredSession): Promise<void> {
    this.updates += 1;
    await this.create(digest, session);
  }
}

const METADATA = {
  browser: "Browser",
  deviceType: "desktop",
  ipAddress: "127.0.0.1",
  location: "private",
  operatingSystem: "Windows",
};

describe("session manager", () => {
  it("stores only a digest and enforces absolute expiry", async () => {
    const repository = new MemorySessionRepository();
    let now = new Date("2026-08-17T00:00:00.000+08:00");
    const manager = new SessionManager(repository, {
      absoluteTtlMilliseconds: 2_000,
      activityWriteIntervalMilliseconds: 500,
      idleTtlMilliseconds: 1_000,
      now: () => now,
    });

    const created = await manager.create(
      "user-1",
      "user",
      "password",
      METADATA,
    );

    expect(created.token).toHaveLength(43);
    expect([...repository.records.keys()][0]).not.toBe(created.token);
    now = new Date("2026-08-16T16:00:00.750Z");
    const active = await manager.authenticate(created.token);
    expect(active?.lastActiveAt).toBe(now.toISOString());
    expect(repository.updates).toBe(1);
    now = new Date("2026-08-16T16:00:02.001Z");
    expect(await manager.authenticate(created.token)).toBeUndefined();
  });

  it("revokes one session or all user sessions", async () => {
    const repository = new MemorySessionRepository();
    const manager = new SessionManager(repository, {
      absoluteTtlMilliseconds: 10_000,
      activityWriteIntervalMilliseconds: 1_000,
      idleTtlMilliseconds: 5_000,
      now: () => new Date("2026-08-17T00:00:00.000+08:00"),
    });
    const first = await manager.create("user-1", "user", "password", METADATA);
    const second = await manager.create("user-1", "user", "passkey", METADATA);
    await manager.create("user-2", "admin", "password", METADATA);

    await manager.revoke(first.token, "user-1");
    expect(await manager.authenticate(first.token)).toBeUndefined();
    expect(await manager.authenticate(second.token)).toBeDefined();
    await manager.revokeAll("user-1");
    expect(await manager.list("user-1")).toEqual([]);
    expect(await manager.list("user-2")).toHaveLength(1);
  });

  it("revokes by public session id and preserves the current session", async () => {
    const repository = new MemorySessionRepository();
    const manager = new SessionManager(repository, {
      absoluteTtlMilliseconds: 10_000,
      activityWriteIntervalMilliseconds: 1_000,
      idleTtlMilliseconds: 5_000,
      now: () => new Date("2026-08-17T00:00:00.000+08:00"),
    });
    const current = await manager.create(
      "user-1",
      "user",
      "password",
      METADATA,
    );
    const other = await manager.create("user-1", "user", "passkey", METADATA);

    expect(await manager.revokeById("user-1", other.session.id)).toBe(true);
    expect(await manager.revokeById("user-1", other.session.id)).toBe(false);
    await manager.create("user-1", "user", "password", METADATA);
    expect(await manager.revokeOthers("user-1", current.session.id)).toBe(1);
    expect(await manager.list("user-1")).toEqual([current.session]);
  });

  it("refreshes recent strong authentication but rejects recovery sessions", async () => {
    const repository = new MemorySessionRepository();
    let now = new Date("2026-08-17T00:00:00.000+08:00");
    const manager = new SessionManager(repository, {
      absoluteTtlMilliseconds: 10_000,
      activityWriteIntervalMilliseconds: 1_000,
      idleTtlMilliseconds: 5_000,
      now: () => now,
    });
    const password = await manager.create(
      "user-1",
      "admin",
      "password",
      METADATA,
    );
    const recovery = await manager.create(
      "user-1",
      "admin",
      "password_recovery",
      METADATA,
    );
    now = new Date("2026-08-16T16:00:02.000Z");

    const updated = await manager.markStrongAuthenticated(
      password.token,
      "user-1",
    );

    expect(updated.strongAuthenticatedAt).toBe(now.toISOString());
    await expect(
      manager.markStrongAuthenticated(recovery.token, "user-1"),
    ).rejects.toThrow("step_up_invalid");
  });
});

describe("redis session repository", () => {
  const SESSION: StoredSession = {
    ...METADATA,
    absoluteExpiresAt: "2026-08-18T00:00:00.000+08:00",
    authStrength: "password",
    createdAt: "2026-08-17T00:00:00.000+08:00",
    id: "session-1",
    idleExpiresAt: "2026-08-17T01:00:00.000+08:00",
    lastActiveAt: "2026-08-17T00:00:00.000+08:00",
    role: "user",
    userId: "user-1",
  };

  it("uses the latest member expiry for the user index", async () => {
    const calls: unknown[][] = [];
    const redis = {
      eval: (...arguments_: unknown[]) => {
        calls.push(arguments_);
        return Promise.resolve(1);
      },
    } as unknown as Redis;
    const repository = new RedisSessionRepository(redis);

    await repository.create("digest-1", SESSION, 3_600);

    expect(String(calls[0]?.[0])).toContain("PEXPIREAT");
    expect(calls[0]?.[1]).toBe(3);
    expect(calls[0]?.[7]).toBe(Date.parse(SESSION.idleExpiresAt).toString());
    expect(calls[0]?.[8]).toBe("digest-1");
    expect(calls[0]?.[10]).toBe("200");
  });

  it("rejects creation when the global capacity script refuses it", async () => {
    const redis = {
      eval: () => Promise.resolve(0),
    } as unknown as Redis;
    const repository = new RedisSessionRepository(redis);

    await expect(repository.create("digest-1", SESSION, 3_600)).rejects.toThrow(
      "browser_session_capacity_exceeded",
    );
  });
});
