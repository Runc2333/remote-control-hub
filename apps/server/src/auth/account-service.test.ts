import { describe, expect, it, vi } from "vitest";
import { AccountService, type AccountRepository } from "./account-service.js";
import { hashPassword } from "./password.js";

const METADATA = {
  browser: "Browser",
  deviceType: "desktop",
  ipAddress: "127.0.0.1",
  location: "private",
  operatingSystem: "Windows",
};

const createFixture = async (registrationMode: "open" | "closed") => {
  const createUser = vi.fn(async () => "11111111-1111-4111-8111-111111111111");
  const updatePassword = vi.fn(async () => undefined);
  const invalidateTemporaryPassword = vi.fn(async () => true);
  const repository: AccountRepository = {
    createUser,
    findById: async () => ({
      id: "user-1",
      passwordHash: await hashPassword("current-password"),
      role: "user",
      status: "active",
    }),
    getRegistrationMode: async () => registrationMode,
    invalidateTemporaryPassword,
    setRegistrationMode: vi.fn(async () => undefined),
    updatePassword,
  };
  const create = vi.fn(async () => ({
    session: {
      ...METADATA,
      absoluteExpiresAt: "2026-09-17T00:00:00.000+08:00",
      authStrength: "password" as const,
      createdAt: "2026-08-17T00:00:00.000+08:00",
      id: "22222222-2222-4222-8222-222222222222",
      idleExpiresAt: "2026-08-18T00:00:00.000+08:00",
      lastActiveAt: "2026-08-17T00:00:00.000+08:00",
      role: "user" as const,
      userId: "user-1",
    },
    token: "new-session-token",
  }));
  const revokeAll = vi.fn(async () => undefined);
  const temporaryPasswords = {
    consume: vi.fn(async (token: string) =>
      token === "temporary-token"
        ? { role: "user" as const, userId: "user-1" }
        : undefined,
    ),
    create: vi.fn(async () => "temporary-token"),
  };
  return {
    create,
    createUser,
    revokeAll,
    service: new AccountService(
      repository,
      { create, revokeAll },
      temporaryPasswords,
      () => new Date("2026-08-17T00:00:00.000+08:00"),
    ),
    temporaryPasswords,
    updatePassword,
  };
};

describe("account service", () => {
  it("normalizes identifiers only when registration is open", async () => {
    const open = await createFixture("open");
    const closed = await createFixture("closed");
    const request = {
      identifier: " USER@Example.com ",
      identifierType: "email" as const,
      password: "registration-password",
    };

    await expect(open.service.register(request)).resolves.toBe(
      "11111111-1111-4111-8111-111111111111",
    );
    expect(open.createUser).toHaveBeenCalledWith(
      expect.objectContaining({
        displayIdentifier: "user@example.com",
        normalizedIdentifier: "user@example.com",
      }),
    );
    await expect(closed.service.register(request)).rejects.toThrow(
      "registration_closed",
    );
    expect(closed.createUser).not.toHaveBeenCalled();
  });

  it("rotates all sessions after a password change", async () => {
    const fixture = await createFixture("closed");

    const created = await fixture.service.changePassword(
      "user-1",
      "current-password",
      "replacement-password",
      METADATA,
    );

    expect(fixture.updatePassword).toHaveBeenCalledOnce();
    expect(fixture.revokeAll).toHaveBeenCalledWith("user-1");
    expect(fixture.create).toHaveBeenCalledWith(
      "user-1",
      "user",
      "password",
      METADATA,
    );
    expect(created.token).toBe("new-session-token");
  });

  it("creates a one-time 24-hour temporary credential for an administrator", async () => {
    const fixture = await createFixture("closed");

    const created = await fixture.service.createTemporaryUser({
      identifier: " NEW@Example.com ",
      identifierType: "email",
    });

    expect(created.temporaryPassword).toHaveLength(32);
    expect(created.temporaryPasswordExpiresAt).toBe("2026-08-17T16:00:00.000Z");
    expect(fixture.createUser).toHaveBeenCalledWith(
      expect.objectContaining({
        mustChangePassword: true,
        normalizedIdentifier: "new@example.com",
        temporaryPasswordExpiresAt: "2026-08-17T16:00:00.000Z",
      }),
    );
  });

  it("rejects an incorrect or unchanged password", async () => {
    const fixture = await createFixture("closed");

    await expect(
      fixture.service.changePassword(
        "user-1",
        "incorrect-password",
        "replacement-password",
        METADATA,
      ),
    ).rejects.toThrow("credentials_invalid");
    await expect(
      fixture.service.changePassword(
        "user-1",
        "current-password",
        "current-password",
        METADATA,
      ),
    ).rejects.toThrow("password_unchanged");
    expect(fixture.updatePassword).not.toHaveBeenCalled();
  });

  it("consumes a single-purpose temporary password challenge", async () => {
    const fixture = await createFixture("closed");

    await expect(
      fixture.service.beginTemporaryPasswordChange("user-1", "user"),
    ).resolves.toBe("temporary-token");
    const session = await fixture.service.completeTemporaryPasswordChange(
      "temporary-token",
      "replacement-password",
      METADATA,
    );

    expect(fixture.temporaryPasswords.create).toHaveBeenCalledWith({
      role: "user",
      userId: "user-1",
    });
    expect(fixture.temporaryPasswords.consume).toHaveBeenCalledWith(
      "temporary-token",
    );
    expect(session.token).toBe("new-session-token");
  });
});
