import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";

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

describe("system routes", () => {
  it("returns process health", async () => {
    const app = buildApp({
      deploymentMode: "standalone",
      host: "127.0.0.1",
      migrationsFolder: "apps/server/drizzle",
      port: 3000,
      releaseId: "test-release",
      setupConfigFile: "state/test-setup-config.json",
      setupStateFile: "state/test-setup-state.json",
    });
    apps.push(app);

    const response = await app.inject({ method: "GET", url: "/healthz" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: "ok" });
  });

  it("exposes only non-sensitive setup state", async () => {
    const app = buildApp({
      deploymentMode: "compose",
      host: "127.0.0.1",
      migrationsFolder: "apps/server/drizzle",
      port: 3000,
      releaseId: "test-release",
      setupConfigFile: "state/test-setup-config.json",
      setupStateFile: "state/test-setup-state.json",
    });
    apps.push(app);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/setup/status",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      deploymentMode: "compose",
      installed: false,
      step: "unconfigured",
    });
  });

  it("reports installation mode as not operational", async () => {
    const app = buildApp({
      deploymentMode: "standalone",
      host: "127.0.0.1",
      migrationsFolder: "apps/server/drizzle",
      port: 3000,
      releaseId: "test-release",
      setupConfigFile: "state/test-setup-config.json",
      setupStateFile: "state/test-setup-state.json",
    });
    apps.push(app);

    const response = await app.inject({
      method: "GET",
      url: "/operationalz",
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      reason: "setup_incomplete",
      status: "unavailable",
    });
  });

  it("serves the WebUI shell with controlled cache headers", async () => {
    const webRoot = await mkdtemp(join(tmpdir(), "remote-control-hub-web-"));
    temporaryDirectories.push(webRoot);
    await mkdir(join(webRoot, "assets"));
    await writeFile(join(webRoot, "index.html"), "<main>shell</main>");
    await writeFile(join(webRoot, "sw.js"), "export {};\n");
    await writeFile(join(webRoot, "app-version.json"), "{}\n");
    await writeFile(join(webRoot, "assets", "app-hash.js"), "export {};\n");
    const app = buildApp({
      deploymentMode: "standalone",
      host: "127.0.0.1",
      migrationsFolder: "apps/server/drizzle",
      port: 3000,
      releaseId: "test-release",
      setupConfigFile: join(webRoot, "setup-config.json"),
      setupStateFile: join(webRoot, "setup-state.json"),
      webRoot,
    });
    apps.push(app);

    const [shell, worker, manifest, asset, fallback, missingApi] =
      await Promise.all([
        app.inject({ method: "GET", url: "/" }),
        app.inject({ method: "GET", url: "/sw.js" }),
        app.inject({ method: "GET", url: "/app-version.json" }),
        app.inject({ method: "GET", url: "/assets/app-hash.js" }),
        app.inject({ method: "GET", url: "/devices/example" }),
        app.inject({ method: "GET", url: "/api/v1/missing" }),
      ]);

    expect(shell.headers["cache-control"]).toBe("no-cache, must-revalidate");
    expect(worker.headers["cache-control"]).toBe("no-cache");
    expect(manifest.headers["cache-control"]).toBe("no-store");
    expect(asset.headers["cache-control"]).toBe(
      "public, max-age=31536000, immutable",
    );
    expect(fallback.body).toBe("<main>shell</main>");
    expect(missingApi.statusCode).toBe(404);
  });

  it("tests only the fixed Compose data-service target", async () => {
    const setupSecret = "0123456789abcdef0123456789abcdef";
    let testedService: string | undefined;
    const app = buildApp(
      {
        deploymentMode: "compose",
        host: "127.0.0.1",
        migrationsFolder: "apps/server/drizzle",
        mysqlConnection: {
          database: "remote_control_hub",
          host: "mysql",
          password: "database-password",
          port: 3306,
          tls: false,
          username: "remote_control_hub",
        },
        port: 3000,
        redisConnection: {
          database: 0,
          host: "redis",
          password: "redis-password",
          port: 6379,
          tls: false,
        },
        releaseId: "test-release",
        setupSecretDigest: createHash("sha256")
          .update(setupSecret, "utf8")
          .digest("hex"),
        setupConfigFile: "state/test-setup-config.json",
        setupStateFile: "state/test-setup-state.json",
      },
      {
        testDataService: async (input) => {
          testedService = input.service;
          return { ok: true };
        },
      },
    );
    apps.push(app);

    const success = await app.inject({
      method: "POST",
      payload: { service: "mysql", setupSecret },
      url: "/api/v1/setup/test-data-service",
    });
    const override = await app.inject({
      method: "POST",
      payload: {
        connection: {
          database: "other",
          host: "attacker.example",
          password: "password",
          port: 3306,
          tls: true,
          username: "user",
        },
        service: "mysql",
        setupSecret,
      },
      url: "/api/v1/setup/test-data-service",
    });

    expect(success.statusCode).toBe(200);
    expect(testedService).toBe("mysql");
    expect(override.statusCode).toBe(400);
    expect(override.json()).toMatchObject({ code: "compose_target_immutable" });
  });

  it("completes setup once and permanently closes the write endpoint", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rch-setup-route-"));
    temporaryDirectories.push(directory);
    const setupSecret = "0123456789abcdef0123456789abcdef";
    let administratorExists = false;
    const app = buildApp(
      {
        deploymentMode: "standalone",
        host: "127.0.0.1",
        migrationsFolder: join(directory, "drizzle"),
        port: 3000,
        releaseId: "test-release",
        setupConfigFile: join(directory, "setup-config.json"),
        setupSecretDigest: createHash("sha256")
          .update(setupSecret, "utf8")
          .digest("hex"),
        setupStateFile: join(directory, "setup-state.json"),
      },
      {
        createSetupActions: () => ({
          administratorExists: async () => administratorExists,
          ensureAdministrator: async () => {
            administratorExists = true;
          },
          migrate: async () => undefined,
          stageConfiguration: async () => undefined,
          testConnections: async () => undefined,
        }),
      },
    );
    apps.push(app);
    const payload = {
      administrator: {
        identifier: "admin@example.com",
        identifierType: "email",
        password: "a-secure-password",
      },
      connections: {
        mysql: {
          database: "remote_control_hub",
          host: "127.0.0.1",
          password: "database-password",
          port: 3306,
          tls: true,
          username: "remote_control_hub",
        },
        redis: {
          database: 0,
          host: "127.0.0.1",
          password: "redis-password",
          port: 6379,
          tls: true,
        },
      },
      idempotencyKey: "0123456789abcdef",
      setupSecret,
    };

    const success = await app.inject({
      method: "POST",
      payload,
      url: "/api/v1/setup/complete",
    });
    const repeated = await app.inject({
      method: "POST",
      payload,
      url: "/api/v1/setup/complete",
    });

    expect(success.statusCode).toBe(200);
    expect(success.json()).toMatchObject({
      installed: true,
      step: "installed",
    });
    expect(repeated.statusCode).toBe(409);
  });
});
import { createHash } from "node:crypto";
