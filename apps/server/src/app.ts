import { randomBytes } from "node:crypto";
import fastifyCookie from "@fastify/cookie";
import fastifyCsrf from "@fastify/csrf-protection";
import fastifyWebsocket from "@fastify/websocket";
import type { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import fastifyStatic from "@fastify/static";
import fastifyRateLimit from "@fastify/rate-limit";
import Fastify, { type FastifyInstance } from "fastify";
import type { ServerConfig } from "./config.js";
import { createAuthRuntime } from "./auth/auth-runtime.js";
import { createAuditService } from "./audit/audit-service.js";
import { createAuditQueryService } from "./audit/audit-query-service.js";
import { createCommandRuntime } from "./commands/command-runtime.js";
import { createDeviceRuntime } from "./devices/device-runtime.js";
import { authRoutes } from "./http/auth-routes.js";
import { commandRoutes } from "./http/command-routes.js";
import { deviceRoutes } from "./http/device-routes.js";
import { systemRoutes } from "./http/system-routes.js";
import { testDataServiceConnection } from "./setup/data-services.js";
import { createSetupActions } from "./setup/setup-actions.js";

export type AppDependencies = {
  createAuditQueryService?: typeof createAuditQueryService;
  createAuditService?: (
    config: ServerConfig,
  ) => Pick<ReturnType<typeof createAuditService>, "record">;
  createAuthRuntime?: typeof createAuthRuntime;
  createCommandRuntime?: typeof createCommandRuntime;
  createDeviceRuntime?: typeof createDeviceRuntime;
  createSetupActions?: typeof createSetupActions;
  testDataService?: typeof testDataServiceConnection;
};

export const buildApp = (
  config: ServerConfig,
  dependencies: AppDependencies = {},
): FastifyInstance => {
  const app = Fastify({
    logger: process.env.NODE_ENV !== "test",
    requestIdHeader: "x-request-id",
    ...(config.trustedProxies === undefined
      ? {}
      : { trustProxy: [...config.trustedProxies] }),
  }).withTypeProvider<TypeBoxTypeProvider>();
  const cookieSecret =
    config.cookieSecret ?? randomBytes(32).toString("base64url");
  let authRuntime: ReturnType<typeof createAuthRuntime> | undefined;
  const getAuthRuntime = () => {
    authRuntime ??= (dependencies.createAuthRuntime ?? createAuthRuntime)(
      config,
      getDeviceRuntime().connections,
    );
    return authRuntime;
  };
  let auditService:
    Pick<ReturnType<typeof createAuditService>, "record"> | undefined;
  const getAuditService = () => {
    auditService ??= (dependencies.createAuditService ?? createAuditService)(
      config,
    );
    return auditService;
  };
  let auditQueryService: ReturnType<typeof createAuditQueryService> | undefined;
  const getAuditQueryService = () => {
    auditQueryService ??= (
      dependencies.createAuditQueryService ?? createAuditQueryService
    )(config);
    return auditQueryService;
  };
  let deviceRuntime: ReturnType<typeof createDeviceRuntime> | undefined;
  const getDeviceRuntime = () => {
    deviceRuntime ??= (dependencies.createDeviceRuntime ?? createDeviceRuntime)(
      config,
    );
    return deviceRuntime;
  };
  let commandRuntime: ReturnType<typeof createCommandRuntime> | undefined;
  const getCommandRuntime = () => {
    commandRuntime ??= (
      dependencies.createCommandRuntime ?? createCommandRuntime
    )(getDeviceRuntime(), config);
    return commandRuntime;
  };
  app.addHook("onClose", async () => {
    authRuntime?.close();
  });
  void app.register(fastifyRateLimit, { global: false });
  void app.register(fastifyCookie, {
    hook: "onRequest",
    secret: cookieSecret,
  });
  void app.register(fastifyCsrf, {
    cookieKey: "rch_csrf_secret",
    cookieOpts: {
      httpOnly: true,
      path: "/",
      sameSite: "strict",
      secure: true,
      signed: true,
    },
  });
  void app.register(fastifyWebsocket, {
    options: { maxPayload: 64 * 1024 },
  });
  void app.register(systemRoutes, {
    config,
    createSetupActions: dependencies.createSetupActions ?? createSetupActions,
    testDataService: dependencies.testDataService ?? testDataServiceConnection,
  });
  void app.register(authRoutes, {
    config,
    getAuditQueryService,
    getAuditService,
    getAuthRuntime,
  });
  void app.register(deviceRoutes, {
    config,
    getAuditService,
    getAuthRuntime,
    getCommandRuntime,
    getDeviceRuntime,
  });
  void app.register(commandRoutes, {
    config,
    getAuditService,
    getAuthRuntime,
    getCommandRuntime,
  });
  if (config.webRoot !== undefined) {
    app.addHook("onSend", async (request, reply, payload) => {
      const contentType = reply.getHeader("content-type");
      const path = request.url.split("?", 1)[0];
      if (path === "/app-version.json") {
        reply.header("Cache-Control", "no-store");
        return payload;
      }
      if (path === "/sw.js") {
        reply.header("Cache-Control", "no-cache");
        return payload;
      }
      if (
        typeof contentType === "string" &&
        contentType.startsWith("text/html")
      ) {
        reply.header("Cache-Control", "no-cache, must-revalidate");
        return payload;
      }
      if (path?.startsWith("/assets/") === true) {
        reply.header("Cache-Control", "public, max-age=31536000, immutable");
        return payload;
      }
      reply.header("Cache-Control", "no-cache");
      return payload;
    });
    void app.register(fastifyStatic, {
      root: config.webRoot,
      wildcard: false,
    });
    app.setNotFoundHandler(async (request, reply) => {
      if (
        request.url.startsWith("/api/") ||
        request.url === "/healthz" ||
        request.url === "/readyz" ||
        request.url === "/operationalz"
      ) {
        return reply.code(404).send({ error: "not_found" });
      }
      return reply.sendFile("index.html", { cacheControl: false });
    });
  }
  return app;
};
