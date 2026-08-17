import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ServerConfig } from "../config.js";
import type { AuthRuntime } from "../auth/auth-runtime.js";
import type { StoredSession } from "../auth/session-store.js";
import { buildApp } from "../app.js";
import { AuditQueryService } from "../audit/audit-query-service.js";

const APP_ORIGIN = "https://hub.example.com";
const SESSION_TOKEN = "opaque-session-token";
const CURRENT_SESSION: StoredSession = {
  absoluteExpiresAt: "2026-09-16T16:00:00.000Z",
  authStrength: "password",
  browser: "Test Browser",
  createdAt: "2026-08-16T16:00:00.000Z",
  deviceType: "desktop",
  id: "11111111-1111-4111-8111-111111111111",
  idleExpiresAt: "2026-08-17T16:00:00.000Z",
  ipAddress: "127.0.0.1",
  lastActiveAt: "2026-08-16T16:00:00.000Z",
  location: "private",
  operatingSystem: "Windows",
  role: "user",
  strongAuthenticatedAt: "2026-08-16T16:00:00.000Z",
  userId: "user-1",
};
const OTHER_SESSION: StoredSession = {
  ...CURRENT_SESSION,
  authStrength: "passkey",
  id: "22222222-2222-4222-8222-222222222222",
  lastActiveAt: "2026-08-16T15:00:00.000Z",
};
const SECOND_FACTOR_SESSION: StoredSession = {
  ...CURRENT_SESSION,
  authStrength: "password_totp",
};

const apps: ReturnType<typeof buildApp>[] = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map(async (app) => app.close()));
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map(async (path) => rm(path, { force: true, recursive: true })),
  );
});

const createConfig = async (installed: boolean): Promise<ServerConfig> => {
  const directory = await mkdtemp(join(tmpdir(), "rch-auth-routes-"));
  temporaryDirectories.push(directory);
  const setupStateFile = join(directory, "setup-state.json");
  if (installed) {
    await mkdir(directory, { recursive: true });
    await writeFile(
      setupStateFile,
      `${JSON.stringify({
        deploymentMode: "standalone",
        fencingToken: 1,
        step: "installed",
        updatedAt: "2026-08-17T00:00:00.000+08:00",
      })}\n`,
    );
  }
  return {
    appOrigin: APP_ORIGIN,
    cookieSecret: "0123456789abcdef0123456789abcdef",
    deploymentMode: "standalone",
    host: "127.0.0.1",
    migrationsFolder: "apps/server/drizzle",
    mysqlConnection: {
      database: "remote_control_hub",
      host: "127.0.0.1",
      password: "database-password",
      port: 3306,
      tls: true,
      username: "remote_control_hub",
    },
    port: 3000,
    redisConnection: {
      database: 0,
      host: "127.0.0.1",
      password: "redis-password",
      port: 6379,
      tls: true,
    },
    releaseId: "test-release",
    setupConfigFile: join(directory, "setup-config.json"),
    setupStateFile,
  };
};

const createRuntime = (): AuthRuntime => ({
  adminUsers: {
    delete: vi.fn(async () => undefined),
    list: vi.fn(async () => []),
    resetEnhancedAuthentication: vi.fn(async () => undefined),
    resetPassword: vi.fn(async () => ({
      temporaryPassword: "temporary-password-value",
      temporaryPasswordExpiresAt: "2026-08-18T00:00:00.000Z",
    })),
    update: vi.fn(async () => ({
      createdAt: "2026-08-17T00:00:00.000Z",
      displayIdentifier: "user@example.com",
      id: "33333333-3333-4333-8333-333333333333",
      identifierType: "email" as const,
      mustChangePassword: false,
      role: "user" as const,
      status: "active" as const,
    })),
  },
  accounts: {
    beginTemporaryPasswordChange: vi.fn(async () => "temporary-token"),
    changePassword: vi.fn(async () => ({
      session: CURRENT_SESSION,
      token: SESSION_TOKEN,
    })),
    completeTemporaryPasswordChange: vi.fn(async () => ({
      session: CURRENT_SESSION,
      token: SESSION_TOKEN,
    })),
    createTemporaryUser: vi.fn(async () => ({
      temporaryPassword: "generated-temporary-password",
      temporaryPasswordExpiresAt: "2026-08-18T00:00:00.000+08:00",
      userId: "44444444-4444-4444-8444-444444444444",
    })),
    getRegistrationMode: vi.fn(async () => "closed" as const),
    getTotpLabel: vi.fn(async () => "user@example.com"),
    register: vi.fn(async () => "33333333-3333-4333-8333-333333333333"),
    setRegistrationMode: vi.fn(async () => undefined),
    verifyCurrentPassword: vi.fn(async () => undefined),
  },
  close: vi.fn(),
  confirmations: {
    consume: vi.fn(async () => undefined),
    issue: vi.fn(async () => ({
      expiresAt: "2026-08-17T00:05:00.000Z",
      token: "confirmation-token-confirmation-token",
    })),
  },
  passwordAuth: {
    login: vi.fn(async () => ({
      kind: "authenticated" as const,
      role: "user" as const,
      session: CURRENT_SESSION,
      token: SESSION_TOKEN,
    })),
  },
  passkeys: {
    beginAuthentication: vi.fn(async () => ({
      options: { challenge: "challenge" },
      token: "webauthn-token",
    })),
    beginRegistration: vi.fn(async () => ({
      options: { challenge: "challenge" },
      token: "webauthn-token",
    })),
    beginStepUp: vi.fn(async () => ({
      options: { challenge: "challenge" },
      token: "webauthn-step-up-token",
    })),
    completeAuthentication: vi.fn(async () => ({
      session: { ...CURRENT_SESSION, authStrength: "passkey" as const },
      token: SESSION_TOKEN,
    })),
    completeRegistration: vi.fn(async () => ({
      backedUp: true,
      createdAt: "2026-08-17T00:00:00.000Z",
      deviceType: "multiDevice" as const,
      id: "credential-1",
      name: "Windows Hello",
      transports: ["internal" as const],
    })),
    completeStepUp: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
    list: vi.fn(async () => []),
    rename: vi.fn(async () => ({
      backedUp: true,
      createdAt: "2026-08-17T00:00:00.000Z",
      deviceType: "multiDevice" as const,
      id: "credential-1",
      name: "Renamed",
      transports: ["internal" as const],
    })),
  },
  secondFactor: {
    begin: vi.fn(async () => "second-factor-token"),
    complete: vi.fn(async () => ({
      session: SECOND_FACTOR_SESSION,
      token: SESSION_TOKEN,
    })),
    verifyTotp: vi.fn(async () => true),
  },
  sessions: {
    authenticate: vi.fn(async (token: string) =>
      token === SESSION_TOKEN ? CURRENT_SESSION : undefined,
    ),
    list: vi.fn(async () => [CURRENT_SESSION, OTHER_SESSION]),
    markStrongAuthenticated: vi.fn(async () => CURRENT_SESSION),
    revoke: vi.fn(async () => undefined),
    revokeAll: vi.fn(async () => undefined),
    revokeByAuthenticator: vi.fn(async () => 0),
    revokeById: vi.fn(async (_userId: string, sessionId: string) =>
      [CURRENT_SESSION.id, OTHER_SESSION.id].includes(sessionId),
    ),
    revokeOthers: vi.fn(async () => 1),
  },
  totpEnrollment: {
    begin: vi.fn(async () => ({
      expiresAt: "2026-08-17T00:05:00.000Z",
      otpauthUri: "otpauth://totp/Remote%20Control%20Hub:user",
      secret: "ABCDEFGHIJKLMNOPQRSTUVWX",
    })),
    confirm: vi.fn(async () => ({
      recoveryCodes: ["0123456789ABCDEF0123"],
    })),
    disable: vi.fn(async () => undefined),
    getStatus: vi.fn(async () => ({
      enabled: false,
      remainingRecoveryCodes: 0,
    })),
    regenerateRecoveryCodes: vi.fn(async () => ({
      recoveryCodes: ["0123456789ABCDEF0123"],
    })),
  },
});

const createAuditService = () => ({
  record: vi.fn(async () => undefined),
});

const cookieFromResponse = (
  response: Awaited<ReturnType<ReturnType<typeof buildApp>["inject"]>>,
  name: string,
): string => {
  const header = response.headers["set-cookie"];
  const values = Array.isArray(header) ? header : [header];
  const value = values.find((item) => item?.startsWith(`${name}=`));
  if (value === undefined) {
    throw new Error(`missing_cookie_${name}`);
  }
  return value.split(";", 1)[0] ?? value;
};

const csrfContext = async (
  app: ReturnType<typeof buildApp>,
): Promise<{ cookie: string; token: string }> => {
  const response = await app.inject({
    method: "GET",
    url: "/api/v1/auth/csrf",
  });
  expect(response.statusCode).toBe(200);
  return {
    cookie: cookieFromResponse(response, "rch_csrf_secret"),
    token: response.json<{ csrfToken: string }>().csrfToken,
  };
};

describe("authentication routes", () => {
  it("keeps authentication hidden before setup completes", async () => {
    const runtime = createRuntime();
    const app = buildApp(await createConfig(false), {
      createAuditService,
      createAuthRuntime: () => runtime,
    });
    apps.push(app);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/auth/csrf",
    });

    expect(response.statusCode).toBe(404);
    expect(runtime.passwordAuth.login).not.toHaveBeenCalled();
  });

  it("requires CSRF and exact Origin before creating the session cookie", async () => {
    const runtime = createRuntime();
    const app = buildApp(await createConfig(true), {
      createAuditService,
      createAuthRuntime: () => runtime,
    });
    apps.push(app);
    const csrf = await csrfContext(app);
    const payload = {
      identifier: "user@example.com",
      identifierType: "email",
      password: "correct-password",
    };

    const wrongOrigin = await app.inject({
      headers: {
        cookie: csrf.cookie,
        "csrf-token": csrf.token,
        origin: "https://attacker.example",
      },
      method: "POST",
      payload,
      url: "/api/v1/auth/login",
    });
    const success = await app.inject({
      headers: {
        cookie: csrf.cookie,
        "csrf-token": csrf.token,
        origin: APP_ORIGIN,
      },
      method: "POST",
      payload,
      url: "/api/v1/auth/login",
    });

    expect(wrongOrigin.statusCode).toBe(403);
    expect(success.statusCode).toBe(200);
    expect(success.json()).toMatchObject({
      requiresPasswordChange: false,
      requiresTotp: false,
      role: "user",
      session: { current: true, id: CURRENT_SESSION.id },
    });
    const sessionCookie = success.headers["set-cookie"];
    expect(sessionCookie).toContain(`${SESSION_TOKEN}`);
    expect(sessionCookie).toContain("HttpOnly");
    expect(sessionCookie).toContain("Secure");
    expect(sessionCookie).toContain("SameSite=Strict");
  });

  it("lists only the authenticated user's sessions", async () => {
    const runtime = createRuntime();
    const app = buildApp(await createConfig(true), {
      createAuditService,
      createAuthRuntime: () => runtime,
    });
    apps.push(app);

    const response = await app.inject({
      headers: { cookie: `rch_session=${SESSION_TOKEN}` },
      method: "GET",
      url: "/api/v1/auth/sessions",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      sessions: [
        { current: true, id: CURRENT_SESSION.id },
        { current: false, id: OTHER_SESSION.id },
      ],
    });
    expect(runtime.sessions.list).toHaveBeenCalledWith("user-1");
  });

  it("uses a bounded intermediate cookie for TOTP login", async () => {
    const runtime = createRuntime();
    vi.mocked(runtime.passwordAuth.login).mockResolvedValue({
      kind: "totp_required",
      role: "user",
      userId: "user-1",
    });
    const app = buildApp(await createConfig(true), {
      createAuditService,
      createAuthRuntime: () => runtime,
    });
    apps.push(app);
    const csrf = await csrfContext(app);
    const login = await app.inject({
      headers: {
        cookie: csrf.cookie,
        "csrf-token": csrf.token,
        origin: APP_ORIGIN,
      },
      method: "POST",
      payload: {
        identifier: "user@example.com",
        identifierType: "email",
        password: "correct-password",
      },
      url: "/api/v1/auth/login",
    });

    expect(login.statusCode).toBe(200);
    expect(login.json()).toMatchObject({ requiresTotp: true });
    expect(login.headers["set-cookie"]).toContain(
      "rch_second_factor=second-factor-token",
    );

    const complete = await app.inject({
      headers: {
        cookie: `${csrf.cookie}; rch_second_factor=second-factor-token`,
        "csrf-token": csrf.token,
        origin: APP_ORIGIN,
      },
      method: "POST",
      payload: { code: "123456", type: "totp" },
      url: "/api/v1/auth/totp/login",
    });

    expect(complete.statusCode).toBe(200);
    expect(complete.json()).toMatchObject({
      requiresTotp: false,
      session: { authStrength: "password_totp" },
    });
    expect(runtime.secondFactor.complete).toHaveBeenCalledWith(
      "second-factor-token",
      { code: "123456", type: "totp" },
    );
  });

  it("requires a recent non-recovery session before enabling TOTP", async () => {
    const runtime = createRuntime();
    const recentSession = {
      ...CURRENT_SESSION,
      createdAt: new Date().toISOString(),
      strongAuthenticatedAt: new Date().toISOString(),
    };
    vi.mocked(runtime.sessions.authenticate).mockResolvedValue(recentSession);
    const app = buildApp(await createConfig(true), {
      createAuditService,
      createAuthRuntime: () => runtime,
    });
    apps.push(app);
    const csrf = await csrfContext(app);

    const begin = await app.inject({
      headers: {
        cookie: `${csrf.cookie}; rch_session=${SESSION_TOKEN}`,
        "csrf-token": csrf.token,
        origin: APP_ORIGIN,
      },
      method: "POST",
      payload: {},
      url: "/api/v1/auth/totp/enrollment",
    });
    const confirm = await app.inject({
      headers: {
        cookie: `${csrf.cookie}; rch_session=${SESSION_TOKEN}`,
        "csrf-token": csrf.token,
        origin: APP_ORIGIN,
      },
      method: "POST",
      payload: { code: "123456" },
      url: "/api/v1/auth/totp/enrollment/confirm",
    });

    expect(begin.statusCode).toBe(200);
    expect(begin.json()).toMatchObject({
      secret: "ABCDEFGHIJKLMNOPQRSTUVWX",
    });
    expect(confirm.statusCode).toBe(200);
    expect(confirm.json<{ recoveryCodes: string[] }>().recoveryCodes).toEqual([
      "0123456789ABCDEF0123",
    ]);
    expect(runtime.totpEnrollment.begin).toHaveBeenCalledWith(
      "user-1",
      "user@example.com",
    );
  });

  it("issues single-use Passkey challenges from trusted server configuration", async () => {
    const runtime = createRuntime();
    vi.mocked(runtime.sessions.authenticate).mockResolvedValue({
      ...CURRENT_SESSION,
      createdAt: new Date().toISOString(),
      strongAuthenticatedAt: new Date().toISOString(),
    });
    const app = buildApp(await createConfig(true), {
      createAuditService,
      createAuthRuntime: () => runtime,
    });
    apps.push(app);
    const csrf = await csrfContext(app);

    const authentication = await app.inject({
      headers: {
        cookie: csrf.cookie,
        "csrf-token": csrf.token,
        origin: APP_ORIGIN,
      },
      method: "POST",
      payload: {},
      url: "/api/v1/auth/passkeys/authentication/options",
    });
    const registration = await app.inject({
      headers: {
        cookie: `${csrf.cookie}; rch_session=${SESSION_TOKEN}`,
        "csrf-token": csrf.token,
        origin: APP_ORIGIN,
      },
      method: "POST",
      payload: {},
      url: "/api/v1/auth/passkeys/registration/options",
    });

    expect(authentication.statusCode).toBe(200);
    expect(authentication.json()).toMatchObject({
      options: { challenge: "challenge" },
    });
    expect(authentication.headers["set-cookie"]).toContain(
      "rch_webauthn=webauthn-token",
    );
    expect(registration.statusCode).toBe(200);
    expect(runtime.passkeys.beginRegistration).toHaveBeenCalledWith("user-1");
  });

  it("uses a one-time intermediate cookie for temporary password replacement", async () => {
    const runtime = createRuntime();
    vi.mocked(runtime.passwordAuth.login).mockResolvedValue({
      kind: "password_change_required",
      role: "user",
      userId: "user-1",
    });
    const app = buildApp(await createConfig(true), {
      createAuditService,
      createAuthRuntime: () => runtime,
    });
    apps.push(app);
    const csrf = await csrfContext(app);
    const login = await app.inject({
      headers: {
        cookie: csrf.cookie,
        "csrf-token": csrf.token,
        origin: APP_ORIGIN,
      },
      method: "POST",
      payload: {
        identifier: "user@example.com",
        identifierType: "email",
        password: "temporary-password",
      },
      url: "/api/v1/auth/login",
    });
    const temporaryCookie = cookieFromResponse(login, "rch_password_change");

    const completed = await app.inject({
      headers: {
        cookie: `${csrf.cookie}; ${temporaryCookie}`,
        "csrf-token": csrf.token,
        origin: APP_ORIGIN,
      },
      method: "POST",
      payload: { newPassword: "replacement-password" },
      url: "/api/v1/auth/temporary-password",
    });

    expect(login.json()).toMatchObject({
      requiresPasswordChange: true,
      requiresTotp: false,
    });
    expect(completed.statusCode).toBe(200);
    expect(
      runtime.accounts.completeTemporaryPasswordChange,
    ).toHaveBeenCalledWith(
      "temporary-token",
      "replacement-password",
      expect.any(Object),
    );
    const setCookie = completed.headers["set-cookie"];
    expect(
      Array.isArray(setCookie) ? setCookie.join(";") : setCookie,
    ).toContain("rch_session=");
  });

  it("revokes other sessions while preserving the authenticated session", async () => {
    const runtime = createRuntime();
    const app = buildApp(await createConfig(true), {
      createAuditService,
      createAuthRuntime: () => runtime,
    });
    apps.push(app);
    const csrf = await csrfContext(app);

    const response = await app.inject({
      headers: {
        cookie: `${csrf.cookie}; rch_session=${SESSION_TOKEN}`,
        "csrf-token": csrf.token,
        origin: APP_ORIGIN,
      },
      method: "POST",
      payload: {},
      url: "/api/v1/auth/sessions/revoke-others",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ revokedCount: 1 });
    expect(runtime.sessions.revokeOthers).toHaveBeenCalledWith(
      "user-1",
      CURRENT_SESSION.id,
    );
  });

  it("allows only an administrator to change the registration policy", async () => {
    const runtime = createRuntime();
    vi.mocked(runtime.sessions.authenticate).mockResolvedValue({
      ...CURRENT_SESSION,
      role: "admin",
      strongAuthenticatedAt: new Date().toISOString(),
    });
    const app = buildApp(await createConfig(true), {
      createAuditService,
      createAuthRuntime: () => runtime,
    });
    apps.push(app);
    const csrf = await csrfContext(app);

    const response = await app.inject({
      headers: {
        cookie: `${csrf.cookie}; rch_session=${SESSION_TOKEN}`,
        "csrf-token": csrf.token,
        origin: APP_ORIGIN,
      },
      method: "PUT",
      payload: {
        confirmationToken: "confirmation-token-confirmation-token",
        mode: "open",
      },
      url: "/api/v1/admin/registration",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ mode: "open" });
    expect(runtime.accounts.setRegistrationMode).toHaveBeenCalledWith(
      "user-1",
      "open",
    );
    expect(runtime.confirmations.consume).toHaveBeenCalledWith({
      action: "admin.registration.update",
      actorId: "user-1",
      payload: { mode: "open" },
      sessionId: CURRENT_SESSION.id,
      targetId: "registration",
      token: "confirmation-token-confirmation-token",
    });
  });

  it("queries only the authenticated user's owner audit scope", async () => {
    const runtime = createRuntime();
    const config = await createConfig(true);
    const auditQuery = new AuditQueryService(config);
    const listOwner = vi.spyOn(auditQuery, "listOwner").mockResolvedValue({
      events: [
        {
          action: "auth.login",
          actorId: "user-1",
          actorType: "user",
          id: "55555555-5555-4555-8555-555555555555",
          occurredAt: "2026-08-17T00:00:00.000Z",
          requestId: "request-1",
          result: "success",
          sourceAddressClass: "private",
          subjectId: "user-1",
          subjectType: "user",
          visibility: "owner",
        },
      ],
    });
    const app = buildApp(config, {
      createAuditQueryService: () => auditQuery,
      createAuditService,
      createAuthRuntime: () => runtime,
    });
    apps.push(app);

    const response = await app.inject({
      headers: { cookie: `rch_session=${SESSION_TOKEN}` },
      method: "GET",
      url: "/api/v1/audit-events?action=auth.login&limit=20",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      events: [{ action: "auth.login", visibility: "owner" }],
    });
    expect(listOwner).toHaveBeenCalledWith("user-1", {
      action: "auth.login",
      limit: 20,
    });
  });

  it("rejects non-administrators from the system audit scope", async () => {
    const runtime = createRuntime();
    const config = await createConfig(true);
    const auditQuery = new AuditQueryService(config);
    const listAdmin = vi.spyOn(auditQuery, "listAdmin");
    const app = buildApp(config, {
      createAuditQueryService: () => auditQuery,
      createAuditService,
      createAuthRuntime: () => runtime,
    });
    apps.push(app);

    const response = await app.inject({
      headers: { cookie: `rch_session=${SESSION_TOKEN}` },
      method: "GET",
      url: "/api/v1/admin/audit-events",
    });

    expect(response.statusCode).toBe(403);
    expect(listAdmin).not.toHaveBeenCalled();
  });

  it("requires TOTP when a TOTP-enabled account steps up with a password", async () => {
    const runtime = createRuntime();
    vi.mocked(runtime.totpEnrollment.getStatus).mockResolvedValue({
      enabled: true,
      remainingRecoveryCodes: 8,
    });
    const app = buildApp(await createConfig(true), {
      createAuditService,
      createAuthRuntime: () => runtime,
    });
    apps.push(app);
    const csrf = await csrfContext(app);

    const response = await app.inject({
      headers: {
        cookie: `${csrf.cookie}; rch_session=${SESSION_TOKEN}`,
        "csrf-token": csrf.token,
        origin: APP_ORIGIN,
      },
      method: "POST",
      payload: { password: "current-password", totpCode: "123456" },
      url: "/api/v1/auth/step-up/password",
    });

    expect(response.statusCode).toBe(200);
    expect(runtime.accounts.verifyCurrentPassword).toHaveBeenCalledWith(
      "user-1",
      "current-password",
    );
    expect(runtime.secondFactor.verifyTotp).toHaveBeenCalledWith(
      "user-1",
      "123456",
    );
    expect(runtime.sessions.markStrongAuthenticated).toHaveBeenCalledWith(
      SESSION_TOKEN,
      "user-1",
    );
  });

  it("does not allow a recovery-code session to step up", async () => {
    const runtime = createRuntime();
    const { strongAuthenticatedAt: _strongAuthenticatedAt, ...session } =
      CURRENT_SESSION;
    void _strongAuthenticatedAt;
    vi.mocked(runtime.sessions.authenticate).mockResolvedValue({
      ...session,
      authStrength: "password_recovery",
    });
    const app = buildApp(await createConfig(true), {
      createAuditService,
      createAuthRuntime: () => runtime,
    });
    apps.push(app);
    const csrf = await csrfContext(app);

    const response = await app.inject({
      headers: {
        cookie: `${csrf.cookie}; rch_session=${SESSION_TOKEN}`,
        "csrf-token": csrf.token,
        origin: APP_ORIGIN,
      },
      method: "POST",
      payload: { password: "current-password" },
      url: "/api/v1/auth/step-up/password",
    });

    expect(response.statusCode).toBe(403);
    expect(runtime.accounts.verifyCurrentPassword).not.toHaveBeenCalled();
    expect(runtime.sessions.markStrongAuthenticated).not.toHaveBeenCalled();
  });
});
