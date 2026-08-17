import { describe, expect, it, vi } from "vitest";
import { hashPassword } from "./password.js";
import {
  PasswordAuthService,
  type LoginUser,
  type LoginUserRepository,
} from "./auth-service.js";

const METADATA = {
  browser: "Browser",
  deviceType: "desktop",
  ipAddress: "127.0.0.1",
  location: "private",
  operatingSystem: "Windows",
};

const createService = async (
  user: LoginUser | undefined,
): Promise<{
  createSession: ReturnType<typeof vi.fn>;
  service: PasswordAuthService;
}> => {
  const repository: LoginUserRepository = {
    findByIdentifier: async () => user,
  };
  const createSession = vi.fn().mockResolvedValue({
    session: {
      ...METADATA,
      absoluteExpiresAt: "2026-09-17T00:00:00.000+08:00",
      authStrength: "password",
      createdAt: "2026-08-17T00:00:00.000+08:00",
      id: "11111111-1111-4111-8111-111111111111",
      idleExpiresAt: "2026-08-18T00:00:00.000+08:00",
      lastActiveAt: "2026-08-17T00:00:00.000+08:00",
      role: "user",
      userId: "user-1",
    },
    token: "opaque-token",
  });
  return {
    createSession,
    service: new PasswordAuthService(
      repository,
      { create: createSession },
      await hashPassword("dummy-password-value"),
      () => new Date("2026-08-17T00:00:00.000+08:00"),
    ),
  };
};

const activeUser = async (): Promise<LoginUser> => ({
  id: "user-1",
  mustChangePassword: false,
  passwordHash: await hashPassword("correct-password"),
  role: "user",
  status: "active",
  totpEnabled: false,
});

describe("password authentication", () => {
  it("creates a session only for a valid active user", async () => {
    const fixture = await createService(await activeUser());

    const result = await fixture.service.login(
      {
        identifier: " USER@Example.com ",
        identifierType: "email",
        password: "correct-password",
      },
      METADATA,
    );

    expect(result.kind).toBe("authenticated");
    expect(fixture.createSession).toHaveBeenCalledOnce();
  });

  it("uses one external error for unknown and disabled users", async () => {
    const unknown = await createService(undefined);
    const disabled = await activeUser();
    disabled.status = "disabled";
    const disabledFixture = await createService(disabled);
    const request = {
      identifier: "user@example.com",
      identifierType: "email" as const,
      password: "incorrect-password",
    };

    await expect(unknown.service.login(request, METADATA)).rejects.toThrow(
      "credentials_invalid",
    );
    await expect(
      disabledFixture.service.login(request, METADATA),
    ).rejects.toThrow("credentials_invalid");
    expect(unknown.createSession).not.toHaveBeenCalled();
    expect(disabledFixture.createSession).not.toHaveBeenCalled();
  });

  it("does not create a formal session before TOTP", async () => {
    const user = await activeUser();
    user.totpEnabled = true;
    const fixture = await createService(user);

    const result = await fixture.service.login(
      {
        identifier: "user@example.com",
        identifierType: "email",
        password: "correct-password",
      },
      METADATA,
    );

    expect(result.kind).toBe("totp_required");
    expect(fixture.createSession).not.toHaveBeenCalled();
  });
});
