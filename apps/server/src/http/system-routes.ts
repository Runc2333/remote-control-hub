import {
  API_VERSION,
  COMPLETE_SETUP_REQUEST_SCHEMA,
  ERROR_RESPONSE_SCHEMA,
  HEALTH_RESPONSE_SCHEMA,
  META_VERSION_RESPONSE_SCHEMA,
  OPERATIONAL_UNAVAILABLE_RESPONSE_SCHEMA,
  SETUP_STATUS_RESPONSE_SCHEMA,
  TEST_DATA_SERVICE_REQUEST_SCHEMA,
  TEST_DATA_SERVICE_RESPONSE_SCHEMA,
  WORKER_PROTOCOL_VERSION,
  type TestDataServiceRequest,
  type CompleteSetupRequest,
} from "@remote-control-hub/contracts";
import { createHash, timingSafeEqual } from "node:crypto";
import { readFile, unlink } from "node:fs/promises";
import { Redis } from "ioredis";
import { createConnection } from "mysql2/promise";
import type { FastifyPluginAsync } from "fastify";
import type { ServerConfig } from "../config.js";
import type { testDataServiceConnection } from "../setup/data-services.js";
import type { createSetupActions } from "../setup/setup-actions.js";
import { SetupCoordinator } from "../setup/setup-coordinator.js";
import { FileSetupStateStore } from "../setup/setup-state.js";

export type SystemRoutesOptions = {
  config: ServerConfig;
  createSetupActions: typeof createSetupActions;
  testDataService: typeof testDataServiceConnection;
};

const verifySetupSecret = (secret: string, digest: string): boolean => {
  const expected = Buffer.from(digest, "hex");
  const actual = createHash("sha256").update(secret, "utf8").digest();
  return expected.length === actual.length && timingSafeEqual(expected, actual);
};

const activeSetupSecretDigest = async (
  config: ServerConfig,
): Promise<string | undefined> => {
  if (config.setupSecretFile !== undefined) {
    try {
      const document: unknown = JSON.parse(
        await readFile(config.setupSecretFile, "utf8"),
      );
      if (typeof document === "object" && document !== null) {
        const record = document as Record<string, unknown>;
        if (
          typeof record.digest === "string" &&
          /^[a-f0-9]{64}$/u.test(record.digest) &&
          typeof record.expiresAt === "string" &&
          Date.parse(record.expiresAt) > Date.now()
        ) {
          return record.digest;
        }
      }
      return undefined;
    } catch (error: unknown) {
      if (
        typeof error !== "object" ||
        error === null ||
        !("code" in error) ||
        error.code !== "ENOENT"
      ) {
        return undefined;
      }
    }
  }
  if (
    config.setupSecretExpiresAt !== undefined &&
    Date.parse(config.setupSecretExpiresAt) <= Date.now()
  ) {
    return undefined;
  }
  return config.setupSecretDigest;
};

const dependenciesAvailable = async (
  config: ServerConfig,
): Promise<boolean> => {
  const mysql = config.mysqlConnection;
  const redis = config.redisConnection;
  if (mysql === undefined || redis === undefined) {
    return false;
  }
  const results = await Promise.allSettled([
    (async () => {
      const connection = await createConnection({
        connectTimeout: 2_000,
        database: mysql.database,
        host: mysql.host,
        password: mysql.password,
        port: mysql.port,
        user: mysql.username,
        ...(mysql.tls ? { ssl: {} } : {}),
      });
      try {
        await connection.ping();
      } finally {
        await connection.end();
      }
    })(),
    (async () => {
      const connection = new Redis({
        commandTimeout: 2_000,
        connectTimeout: 2_000,
        db: redis.database,
        host: redis.host,
        lazyConnect: true,
        maxRetriesPerRequest: 0,
        password: redis.password,
        port: redis.port,
        tls: redis.tls ? {} : undefined,
        username: redis.username,
      });
      try {
        await connection.connect();
        await connection.ping();
      } finally {
        connection.disconnect(false);
      }
    })(),
  ]);
  return results.every((result) => result.status === "fulfilled");
};

export const systemRoutes: FastifyPluginAsync<SystemRoutesOptions> = async (
  fastify,
  options,
) => {
  const setupState = new FileSetupStateStore(
    options.config.setupStateFile,
    options.config.deploymentMode,
  );
  fastify.get(
    "/healthz",
    { schema: { response: { 200: HEALTH_RESPONSE_SCHEMA } } },
    async () => ({
      status: "ok" as const,
      timestamp: new Date().toISOString(),
    }),
  );
  fastify.post<{ Body: TestDataServiceRequest }>(
    "/api/v1/setup/test-data-service",
    {
      preHandler: fastify.rateLimit({ max: 5, timeWindow: "1 minute" }),
      schema: {
        body: TEST_DATA_SERVICE_REQUEST_SCHEMA,
        response: {
          200: TEST_DATA_SERVICE_RESPONSE_SCHEMA,
          400: ERROR_RESPONSE_SCHEMA,
          403: ERROR_RESPONSE_SCHEMA,
          409: ERROR_RESPONSE_SCHEMA,
          503: ERROR_RESPONSE_SCHEMA,
        },
      },
    },
    async (request, reply) => {
      const state = await setupState.read();
      if (state.step === "installed") {
        return reply.code(409).send({
          code: "setup_already_complete",
          message: "安装已完成",
          requestId: request.id,
        });
      }
      const secretDigest = await activeSetupSecretDigest(options.config);
      if (secretDigest === undefined) {
        return reply.code(503).send({
          code: "setup_secret_unavailable",
          message: "安装引导秘密尚未配置",
          requestId: request.id,
        });
      }
      if (!verifySetupSecret(request.body.setupSecret, secretDigest)) {
        return reply.code(403).send({
          code: "setup_secret_invalid",
          message: "无法验证安装请求",
          requestId: request.id,
        });
      }
      if (
        options.config.deploymentMode === "compose" &&
        request.body.connection !== undefined
      ) {
        return reply.code(400).send({
          code: "compose_target_immutable",
          message: "Compose 数据服务目标不能由浏览器覆盖",
          requestId: request.id,
        });
      }
      if (request.body.service === "mysql") {
        const connection =
          options.config.deploymentMode === "compose"
            ? options.config.mysqlConnection
            : request.body.connection;
        if (connection === undefined) {
          return reply.code(400).send({
            code: "data_service_connection_required",
            message: "缺少 MySQL 连接参数",
            requestId: request.id,
          });
        }
        return options.testDataService({ connection, service: "mysql" });
      }
      const connection =
        options.config.deploymentMode === "compose"
          ? options.config.redisConnection
          : request.body.connection;
      if (connection === undefined) {
        return reply.code(400).send({
          code: "data_service_connection_required",
          message: "缺少 Redis 连接参数",
          requestId: request.id,
        });
      }
      return options.testDataService({
        connection,
        service: "redis",
      });
    },
  );
  fastify.post<{ Body: CompleteSetupRequest }>(
    "/api/v1/setup/complete",
    {
      preHandler: fastify.rateLimit({ max: 3, timeWindow: "10 minutes" }),
      schema: {
        body: COMPLETE_SETUP_REQUEST_SCHEMA,
        response: {
          200: SETUP_STATUS_RESPONSE_SCHEMA,
          400: ERROR_RESPONSE_SCHEMA,
          403: ERROR_RESPONSE_SCHEMA,
          409: ERROR_RESPONSE_SCHEMA,
          500: ERROR_RESPONSE_SCHEMA,
          503: ERROR_RESPONSE_SCHEMA,
        },
      },
    },
    async (request, reply) => {
      const current = await setupState.read();
      if (current.step === "installed") {
        return reply.code(409).send({
          code: "setup_already_complete",
          message: "安装已完成",
          requestId: request.id,
        });
      }
      const secretDigest = await activeSetupSecretDigest(options.config);
      if (secretDigest === undefined) {
        return reply.code(503).send({
          code: "setup_secret_unavailable",
          message: "安装引导秘密尚未配置",
          requestId: request.id,
        });
      }
      if (!verifySetupSecret(request.body.setupSecret, secretDigest)) {
        return reply.code(403).send({
          code: "setup_secret_invalid",
          message: "无法验证安装请求",
          requestId: request.id,
        });
      }
      try {
        const coordinator = new SetupCoordinator(
          setupState,
          options.createSetupActions(options.config, request.body),
        );
        const state = await coordinator.complete(request.body);
        if (state.step === "installed") {
          delete options.config.setupSecretDigest;
          delete options.config.setupSecretExpiresAt;
          if (options.config.setupSecretFile !== undefined) {
            await unlink(options.config.setupSecretFile).catch(
              (error: unknown) => {
                if (
                  typeof error !== "object" ||
                  error === null ||
                  !("code" in error) ||
                  error.code !== "ENOENT"
                ) {
                  throw error;
                }
              },
            );
          }
        }
        return {
          deploymentMode: state.deploymentMode,
          installed: state.step === "installed",
          step: state.step,
        };
      } catch (error: unknown) {
        const code = error instanceof Error ? error.message : "setup_failed";
        const badRequestCodes = new Set([
          "compose_target_immutable",
          "standalone_connections_required",
          "data_service_validation_failed",
          "identifier_invalid",
          "password_length_invalid",
        ]);
        const statusCode = badRequestCodes.has(code) ? 400 : 500;
        return reply.code(statusCode).send({
          code: badRequestCodes.has(code) ? code : "setup_failed",
          message: badRequestCodes.has(code)
            ? "安装参数或数据服务验证失败"
            : "安装未完成，可安全重试",
          requestId: request.id,
        });
      }
    },
  );
  fastify.get(
    "/api/v1/meta/version",
    { schema: { response: { 200: META_VERSION_RESPONSE_SCHEMA } } },
    async () => ({
      apiVersion: API_VERSION,
      minimumWebRelease: "0.1.0",
      releaseId: options.config.releaseId,
      workerProtocolVersion: WORKER_PROTOCOL_VERSION,
    }),
  );
  fastify.get(
    "/api/v1/setup/status",
    { schema: { response: { 200: SETUP_STATUS_RESPONSE_SCHEMA } } },
    async () => {
      const state = await setupState.read();
      return {
        deploymentMode: state.deploymentMode,
        installed: state.step === "installed",
        step: state.step,
      };
    },
  );
  fastify.get(
    "/readyz",
    {
      schema: {
        response: {
          200: HEALTH_RESPONSE_SCHEMA,
          503: OPERATIONAL_UNAVAILABLE_RESPONSE_SCHEMA,
        },
      },
    },
    async (_request, reply) => {
      const state = await setupState.read();
      const timestamp = new Date().toISOString();
      if (
        state.step === "installed" &&
        !(await dependenciesAvailable(options.config))
      ) {
        return reply.code(503).send({
          reason: "dependency_unavailable",
          status: "unavailable",
          timestamp,
        });
      }
      return reply.code(200).send({ status: "ok", timestamp });
    },
  );
  fastify.get(
    "/operationalz",
    {
      schema: {
        response: {
          200: HEALTH_RESPONSE_SCHEMA,
          503: OPERATIONAL_UNAVAILABLE_RESPONSE_SCHEMA,
        },
      },
    },
    async (_request, reply) => {
      const state = await setupState.read();
      const timestamp = new Date().toISOString();
      if (state.step !== "installed") {
        return reply.code(503).send({
          reason: "setup_incomplete",
          status: "unavailable",
          timestamp,
        });
      }
      if (!(await dependenciesAvailable(options.config))) {
        return reply.code(503).send({
          reason: "dependency_unavailable",
          status: "unavailable",
          timestamp,
        });
      }
      return reply.code(200).send({ status: "ok", timestamp });
    },
  );
};
