import {
  COMMAND_BATCH_LIST_QUERY_SCHEMA,
  COMMAND_BATCH_LIST_RESPONSE_SCHEMA,
  COMMAND_BATCH_RESPONSE_SCHEMA,
  COMMAND_BATCH_PARAMS_SCHEMA,
  CREATE_COMMAND_BATCH_REQUEST_SCHEMA,
  EMPTY_OBJECT_SCHEMA,
  ERROR_RESPONSE_SCHEMA,
  type CreateCommandBatchRequest,
  type CommandBatchParams,
  type CommandBatchListQuery,
} from "@remote-control-hub/contracts";
import type {
  FastifyPluginAsync,
  FastifyReply,
  FastifyRequest,
  onRequestHookHandler,
} from "fastify";
import type { AuthRuntime } from "../auth/auth-runtime.js";
import type { StoredSession } from "../auth/session-store.js";
import type { AuditEventInput, AuditService } from "../audit/audit-service.js";
import type { CommandRuntime } from "../commands/command-runtime.js";
import type { ServerConfig } from "../config.js";
import { FileSetupStateStore } from "../setup/setup-state.js";

const SESSION_COOKIE_NAME = "rch_session";

export type CommandRoutesOptions = {
  config: ServerConfig;
  getAuditService: () => Pick<AuditService, "record">;
  getAuthRuntime: () => AuthRuntime;
  getCommandRuntime: () => CommandRuntime;
};

const errorResponse = (
  request: FastifyRequest,
  code: string,
  message: string,
) => ({
  code,
  message,
  requestId: request.id,
});

export const commandRoutes: FastifyPluginAsync<CommandRoutesOptions> = async (
  fastify,
  options,
) => {
  const setupState = new FileSetupStateStore(
    options.config.setupStateFile,
    options.config.deploymentMode,
  );
  const audit = (
    event: Omit<AuditEventInput, "sourceAddress">,
    request: FastifyRequest,
  ): void => {
    void options
      .getAuditService()
      .record({ ...event, sourceAddress: request.ip || "unknown" })
      .catch((error: unknown) => {
        fastify.log.error(
          { error, requestId: request.id },
          "audit_append_failed",
        );
      });
  };
  const requireInstalled: onRequestHookHandler = async (request, reply) => {
    if ((await setupState.read()).step !== "installed") {
      return reply
        .code(404)
        .send(errorResponse(request, "not_found", "资源不存在"));
    }
  };
  const requireConfiguration: onRequestHookHandler = async (request, reply) => {
    if (
      options.config.appOrigin === undefined ||
      options.config.cookieSecret === undefined ||
      options.config.mysqlConnection === undefined ||
      options.config.redisConnection === undefined
    ) {
      return reply
        .code(503)
        .send(
          errorResponse(
            request,
            "command_service_unavailable",
            "命令服务暂不可用",
          ),
        );
    }
  };
  const requireOrigin: onRequestHookHandler = async (request, reply) => {
    if (request.headers.origin !== options.config.appOrigin) {
      return reply
        .code(403)
        .send(errorResponse(request, "origin_invalid", "请求来源无法验证"));
    }
  };
  const requireSession = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<StoredSession | undefined> => {
    const token = request.cookies[SESSION_COOKIE_NAME];
    if (token === undefined) {
      reply
        .code(401)
        .send(errorResponse(request, "authentication_required", "需要登录"));
      return undefined;
    }
    try {
      const session = await options
        .getAuthRuntime()
        .sessions.authenticate(token);
      if (session === undefined) {
        reply
          .code(401)
          .send(errorResponse(request, "authentication_required", "需要登录"));
        return undefined;
      }
      return session;
    } catch {
      reply
        .code(503)
        .send(
          errorResponse(
            request,
            "authentication_unavailable",
            "认证服务暂不可用",
          ),
        );
      return undefined;
    }
  };

  fastify.post<{ Body: CreateCommandBatchRequest }>(
    "/api/v1/commands",
    {
      onRequest: [
        requireInstalled,
        requireConfiguration,
        requireOrigin,
        fastify.csrfProtection,
      ],
      preHandler: fastify.rateLimit({ max: 20, timeWindow: "1 second" }),
      schema: {
        body: CREATE_COMMAND_BATCH_REQUEST_SCHEMA,
        params: EMPTY_OBJECT_SCHEMA,
        querystring: EMPTY_OBJECT_SCHEMA,
        response: {
          200: COMMAND_BATCH_RESPONSE_SCHEMA,
          400: ERROR_RESPONSE_SCHEMA,
          401: ERROR_RESPONSE_SCHEMA,
          403: ERROR_RESPONSE_SCHEMA,
          404: ERROR_RESPONSE_SCHEMA,
          409: ERROR_RESPONSE_SCHEMA,
          429: ERROR_RESPONSE_SCHEMA,
          503: ERROR_RESPONSE_SCHEMA,
        },
      },
    },
    async (request, reply) => {
      const session = await requireSession(request, reply);
      if (session === undefined) {
        return;
      }
      try {
        const batch = await options
          .getCommandRuntime()
          .createBatch(session.userId, request.body);
        audit(
          {
            action: "command.create",
            actorId: session.userId,
            actorType: "user",
            metadata: {
              commandType: request.body.commandType,
              targetCount: request.body.deviceIds.length,
            },
            ownerUserId: session.userId,
            requestId: request.id,
            result: "success",
            subjectId: batch.batchId,
            subjectType: "command_batch",
            visibility: "owner",
          },
          request,
        );
        return {
          batchId: batch.batchId,
          results: batch.commands.map((command) => ({
            commandId: command.commandId,
            deviceId: command.deviceId,
            ...(command.errorCode === undefined
              ? {}
              : { errorCode: command.errorCode }),
            status: command.status,
          })),
        };
      } catch (error: unknown) {
        const code = error instanceof Error ? error.message : "command_failed";
        if (code === "device_not_found") {
          return reply
            .code(404)
            .send(errorResponse(request, code, "设备不存在"));
        }
        if (code === "idempotency_conflict") {
          return reply
            .code(409)
            .send(errorResponse(request, code, "幂等键已用于不同请求"));
        }
        if (
          code === "command_targets_invalid" ||
          code === "device_command_capacity_exceeded"
        ) {
          return reply
            .code(400)
            .send(errorResponse(request, code, "命令请求无效"));
        }
        return reply
          .code(503)
          .send(
            errorResponse(
              request,
              "command_service_unavailable",
              "命令服务暂不可用",
            ),
          );
      }
    },
  );
  fastify.get<{ Params: CommandBatchParams }>(
    "/api/v1/command-batches/:batchId",
    {
      onRequest: [requireInstalled, requireConfiguration],
      schema: {
        params: COMMAND_BATCH_PARAMS_SCHEMA,
        querystring: EMPTY_OBJECT_SCHEMA,
        response: {
          200: COMMAND_BATCH_RESPONSE_SCHEMA,
          401: ERROR_RESPONSE_SCHEMA,
          404: ERROR_RESPONSE_SCHEMA,
          503: ERROR_RESPONSE_SCHEMA,
        },
      },
    },
    async (request, reply) => {
      const session = await requireSession(request, reply);
      if (session === undefined) {
        return;
      }
      try {
        const batch = await options
          .getCommandRuntime()
          .findBatch(session.userId, request.params.batchId);
        if (batch === undefined) {
          return reply
            .code(404)
            .send(
              errorResponse(request, "command_batch_not_found", "命令不存在"),
            );
        }
        return {
          batchId: batch.batchId,
          results: batch.commands.map((command) => ({
            commandId: command.commandId,
            deviceId: command.deviceId,
            ...(command.errorCode === undefined
              ? {}
              : { errorCode: command.errorCode }),
            status: command.status,
          })),
        };
      } catch (error: unknown) {
        fastify.log.error(
          { error, requestId: request.id, userId: session.userId },
          "command_batch_get_failed",
        );
        return reply
          .code(503)
          .send(
            errorResponse(
              request,
              "command_service_unavailable",
              "命令服务暂不可用",
            ),
          );
      }
    },
  );
  fastify.get<{ Querystring: CommandBatchListQuery }>(
    "/api/v1/command-batches",
    {
      onRequest: [requireInstalled, requireConfiguration],
      schema: {
        params: EMPTY_OBJECT_SCHEMA,
        querystring: COMMAND_BATCH_LIST_QUERY_SCHEMA,
        response: {
          200: COMMAND_BATCH_LIST_RESPONSE_SCHEMA,
          401: ERROR_RESPONSE_SCHEMA,
          503: ERROR_RESPONSE_SCHEMA,
        },
      },
    },
    async (request, reply) => {
      const session = await requireSession(request, reply);
      if (session === undefined) {
        return;
      }
      try {
        const batches = await options
          .getCommandRuntime()
          .listBatches(session.userId, request.query.limit ?? 50);
        return {
          batches: batches.map((batch) => {
            const first = batch.commands[0];
            if (first === undefined) {
              throw new Error("command_batch_invalid");
            }
            return {
              batchId: batch.batchId,
              commandType: first.commandType,
              createdAt: batch.createdAt,
              results: batch.commands.map((command) => ({
                commandId: command.commandId,
                deviceId: command.deviceId,
                ...(command.errorCode === undefined
                  ? {}
                  : { errorCode: command.errorCode }),
                status: command.status,
              })),
            };
          }),
        };
      } catch (error: unknown) {
        fastify.log.error(
          { error, requestId: request.id, userId: session.userId },
          "command_batch_list_failed",
        );
        return reply
          .code(503)
          .send(
            errorResponse(
              request,
              "command_service_unavailable",
              "命令服务暂不可用",
            ),
          );
      }
    },
  );
};
