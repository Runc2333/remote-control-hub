import {
  ADMIN_CONFIRMED_DEVICE_ACTION_REQUEST_SCHEMA,
  ADMIN_DEVICE_ID_PARAMS_SCHEMA,
  ADMIN_DEVICE_LIST_RESPONSE_SCHEMA,
  ADMIN_SYSTEM_SUMMARY_RESPONSE_SCHEMA,
  ADMIN_UPDATE_DEVICE_REQUEST_SCHEMA,
  AGENT_AUTHENTICATE_SCHEMA,
  AGENT_COMMAND_RESULT_SCHEMA,
  AGENT_HELLO_SCHEMA,
  AGENT_HEARTBEAT_SCHEMA,
  AGENT_PROTOCOL_VERSION,
  AUTH_ACTION_RESPONSE_SCHEMA,
  CREATE_ENROLLMENT_TOKEN_RESPONSE_SCHEMA,
  DEVICE_LIST_RESPONSE_SCHEMA,
  EMPTY_OBJECT_SCHEMA,
  ERROR_RESPONSE_SCHEMA,
  REGISTER_AGENT_REQUEST_SCHEMA,
  REGISTER_AGENT_RESPONSE_SCHEMA,
  type RegisterAgentRequest,
  type AdminConfirmedDeviceActionRequest,
  type AdminDeviceIdParams,
  type AdminUpdateDeviceRequest,
  type AgentAuthenticate,
  type AgentCommandResult,
  type AgentHello,
  type AgentHeartbeat,
} from "@remote-control-hub/contracts";
import Value from "typebox/value";
import { Redis } from "ioredis";
import type {
  FastifyPluginAsync,
  FastifyReply,
  FastifyRequest,
  onRequestHookHandler,
} from "fastify";
import type { AuthRuntime } from "../auth/auth-runtime.js";
import type { AuditEventInput, AuditService } from "../audit/audit-service.js";
import type { StoredSession } from "../auth/session-store.js";
import type { CommandRuntime } from "../commands/command-runtime.js";
import type { ServerConfig } from "../config.js";
import type { DeviceRuntime } from "../devices/device-runtime.js";
import type { AuthenticatedAgentConnection } from "../devices/agent-connection.js";
import { FileSetupStateStore } from "../setup/setup-state.js";

const SESSION_COOKIE_NAME = "rch_session";
const AGENT_AUTHENTICATION_TIMEOUT_MILLISECONDS = 30_000;
const AGENT_HEARTBEAT_TIMEOUT_MILLISECONDS = 45_000;
const RECENT_AUTHENTICATION_MILLISECONDS = 10 * 60 * 1_000;
const REGISTERED_DEVICE_WARNING_THRESHOLD = 700;
const ONLINE_AGENT_WARNING_THRESHOLD = 350;
const ACTIVE_SESSION_WARNING_THRESHOLD = 140;

type LiveAgentSocket = {
  close: (code?: number, reason?: string) => void;
  generation: number;
};

const serializeAgentMessage = (data: unknown): string => {
  if (typeof data === "string") {
    return data;
  }
  if (Buffer.isBuffer(data)) {
    return data.toString("utf8");
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString("utf8");
  }
  if (Array.isArray(data) && data.every((item) => Buffer.isBuffer(item))) {
    return Buffer.concat(data).toString("utf8");
  }
  throw new Error("agent_message_invalid");
};

export type DeviceRoutesOptions = {
  config: ServerConfig;
  getAuditService: () => Pick<AuditService, "record">;
  getAuthRuntime: () => AuthRuntime;
  getCommandRuntime: () => CommandRuntime;
  getDeviceRuntime: () => DeviceRuntime;
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

export const deviceRoutes: FastifyPluginAsync<DeviceRoutesOptions> = async (
  fastify,
  options,
) => {
  const setupState = new FileSetupStateStore(
    options.config.setupStateFile,
    options.config.deploymentMode,
  );
  const liveSockets = new Map<string, LiveAgentSocket>();
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

  const requireBrowserConfiguration: onRequestHookHandler = async (
    request,
    reply,
  ) => {
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
            "authentication_unavailable",
            "认证服务暂不可用",
          ),
        );
    }
  };

  const requireDeviceConfiguration: onRequestHookHandler = async (
    request,
    reply,
  ) => {
    if (options.config.mysqlConnection === undefined) {
      return reply
        .code(503)
        .send(
          errorResponse(
            request,
            "device_service_unavailable",
            "设备服务暂不可用",
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

  const requireAdminSession = async (
    request: FastifyRequest,
    reply: FastifyReply,
    recentAuthentication: boolean,
  ): Promise<StoredSession | undefined> => {
    const session = await requireSession(request, reply);
    if (session === undefined) {
      return undefined;
    }
    const recentlyAuthenticated =
      session.strongAuthenticatedAt !== undefined &&
      Date.now() - Date.parse(session.strongAuthenticatedAt) <=
        RECENT_AUTHENTICATION_MILLISECONDS;
    if (
      session.role !== "admin" ||
      (recentAuthentication && !recentlyAuthenticated)
    ) {
      reply
        .code(403)
        .send(
          errorResponse(
            request,
            recentAuthentication
              ? "recent_authentication_required"
              : "authorization_denied",
            recentAuthentication ? "管理员需要重新验证身份" : "无权访问该资源",
          ),
        );
      return undefined;
    }
    return session;
  };

  fastify.get(
    "/api/v1/admin/devices",
    {
      onRequest: [requireInstalled, requireBrowserConfiguration],
      schema: {
        params: EMPTY_OBJECT_SCHEMA,
        querystring: EMPTY_OBJECT_SCHEMA,
        response: {
          200: ADMIN_DEVICE_LIST_RESPONSE_SCHEMA,
          401: ERROR_RESPONSE_SCHEMA,
          403: ERROR_RESPONSE_SCHEMA,
          404: ERROR_RESPONSE_SCHEMA,
          503: ERROR_RESPONSE_SCHEMA,
        },
      },
    },
    async (request, reply) => {
      const session = await requireAdminSession(request, reply, false);
      if (session === undefined) {
        return;
      }
      try {
        return { devices: await options.getDeviceRuntime().admin.list() };
      } catch {
        return reply
          .code(503)
          .send(
            errorResponse(
              request,
              "admin_devices_unavailable",
              "设备治理列表暂不可用",
            ),
          );
      }
    },
  );

  fastify.get(
    "/api/v1/admin/system-summary",
    {
      onRequest: [requireInstalled, requireBrowserConfiguration],
      schema: {
        params: EMPTY_OBJECT_SCHEMA,
        querystring: EMPTY_OBJECT_SCHEMA,
        response: {
          200: ADMIN_SYSTEM_SUMMARY_RESPONSE_SCHEMA,
          401: ERROR_RESPONSE_SCHEMA,
          403: ERROR_RESPONSE_SCHEMA,
          404: ERROR_RESPONSE_SCHEMA,
          503: ERROR_RESPONSE_SCHEMA,
        },
      },
    },
    async (request, reply) => {
      const session = await requireAdminSession(request, reply, false);
      if (session === undefined) {
        return;
      }
      const redisConfig = options.config.redisConnection;
      if (redisConfig === undefined) {
        return reply
          .code(503)
          .send(
            errorResponse(
              request,
              "system_summary_unavailable",
              "系统摘要暂不可用",
            ),
          );
      }
      const redis = new Redis({
        commandTimeout: 2_000,
        connectTimeout: 2_000,
        db: redisConfig.database,
        host: redisConfig.host,
        lazyConnect: true,
        maxRetriesPerRequest: 0,
        password: redisConfig.password,
        port: redisConfig.port,
        tls: redisConfig.tls ? {} : undefined,
        username: redisConfig.username,
      });
      try {
        const devices = await options.getDeviceRuntime().admin.list();
        await redis.connect();
        await redis.zremrangebyscore(
          "rch:active-sessions",
          "-inf",
          Date.now().toString(),
        );
        const activeBrowserSessions = await redis.zcard("rch:active-sessions");
        const versions = new Map<
          string,
          {
            online: number;
            registered: number;
            serviceVersion: string;
            sessionVersion: string;
          }
        >();
        for (const device of devices) {
          const key = `${device.serviceVersion}\u0000${device.sessionVersion}`;
          const version = versions.get(key) ?? {
            online: 0,
            registered: 0,
            serviceVersion: device.serviceVersion,
            sessionVersion: device.sessionVersion,
          };
          version.registered += 1;
          if (device.online) {
            version.online += 1;
          }
          versions.set(key, version);
        }
        const registeredDevices = devices.length;
        const onlineAgents = devices.filter((device) => device.online).length;
        const capacityWarnings: (
          "active_browser_sessions" | "online_agents" | "registered_devices"
        )[] = [];
        if (registeredDevices >= REGISTERED_DEVICE_WARNING_THRESHOLD) {
          capacityWarnings.push("registered_devices");
        }
        if (onlineAgents >= ONLINE_AGENT_WARNING_THRESHOLD) {
          capacityWarnings.push("online_agents");
        }
        if (activeBrowserSessions >= ACTIVE_SESSION_WARNING_THRESHOLD) {
          capacityWarnings.push("active_browser_sessions");
        }
        return {
          activeBrowserSessions,
          agentVersions: [...versions.values()].sort((left, right) =>
            left.serviceVersion.localeCompare(right.serviceVersion),
          ),
          capacityWarnings,
          checkedAt: new Date().toISOString(),
          onlineAgents,
          registeredDevices,
        };
      } catch {
        return reply
          .code(503)
          .send(
            errorResponse(
              request,
              "system_summary_unavailable",
              "系统摘要暂不可用",
            ),
          );
      } finally {
        redis.disconnect(false);
      }
    },
  );

  fastify.patch<{
    Body: AdminUpdateDeviceRequest;
    Params: AdminDeviceIdParams;
  }>(
    "/api/v1/admin/devices/:deviceId",
    {
      onRequest: [
        requireInstalled,
        requireBrowserConfiguration,
        requireOrigin,
        fastify.csrfProtection,
      ],
      preHandler: fastify.rateLimit({ max: 30, timeWindow: "10 minutes" }),
      schema: {
        body: ADMIN_UPDATE_DEVICE_REQUEST_SCHEMA,
        params: ADMIN_DEVICE_ID_PARAMS_SCHEMA,
        querystring: EMPTY_OBJECT_SCHEMA,
        response: {
          200: AUTH_ACTION_RESPONSE_SCHEMA,
          401: ERROR_RESPONSE_SCHEMA,
          403: ERROR_RESPONSE_SCHEMA,
          404: ERROR_RESPONSE_SCHEMA,
          503: ERROR_RESPONSE_SCHEMA,
        },
      },
    },
    async (request, reply) => {
      const session = await requireAdminSession(request, reply, false);
      if (session === undefined) {
        return;
      }
      try {
        await options
          .getDeviceRuntime()
          .admin.setDisabled(request.params.deviceId, request.body.disabled);
        audit(
          {
            action: request.body.disabled
              ? "admin.device_disabled"
              : "admin.device_restored",
            actorId: session.userId,
            actorType: "user",
            metadata: { disabled: request.body.disabled },
            requestId: request.id,
            result: "success",
            subjectId: request.params.deviceId,
            subjectType: "device",
            visibility: "admin",
          },
          request,
        );
        return { success: true as const };
      } catch (error: unknown) {
        const code =
          error instanceof Error ? error.message : "device_update_failed";
        const status = code === "device_not_found" ? 404 : 503;
        return reply
          .code(status)
          .send(
            errorResponse(
              request,
              code,
              status === 404 ? "设备不存在" : "设备治理操作失败",
            ),
          );
      }
    },
  );

  fastify.post<{
    Body: AdminConfirmedDeviceActionRequest;
    Params: AdminDeviceIdParams;
  }>(
    "/api/v1/admin/devices/:deviceId/credentials/revoke",
    {
      onRequest: [
        requireInstalled,
        requireBrowserConfiguration,
        requireOrigin,
        fastify.csrfProtection,
      ],
      preHandler: fastify.rateLimit({ max: 10, timeWindow: "10 minutes" }),
      schema: {
        body: ADMIN_CONFIRMED_DEVICE_ACTION_REQUEST_SCHEMA,
        params: ADMIN_DEVICE_ID_PARAMS_SCHEMA,
        querystring: EMPTY_OBJECT_SCHEMA,
        response: {
          200: AUTH_ACTION_RESPONSE_SCHEMA,
          401: ERROR_RESPONSE_SCHEMA,
          403: ERROR_RESPONSE_SCHEMA,
          404: ERROR_RESPONSE_SCHEMA,
          503: ERROR_RESPONSE_SCHEMA,
        },
      },
    },
    async (request, reply) => {
      const session = await requireAdminSession(request, reply, true);
      if (session === undefined) {
        return;
      }
      try {
        await options.getAuthRuntime().confirmations.consume({
          action: "admin.device.credentials_revoke",
          actorId: session.userId,
          payload: {},
          sessionId: session.id,
          targetId: request.params.deviceId,
          token: request.body.confirmationToken,
        });
        await options
          .getDeviceRuntime()
          .admin.revokeCredentials(request.params.deviceId);
        audit(
          {
            action: "admin.device_credentials_revoked",
            actorId: session.userId,
            actorType: "user",
            requestId: request.id,
            result: "success",
            subjectId: request.params.deviceId,
            subjectType: "device",
            visibility: "admin",
          },
          request,
        );
        return { success: true as const };
      } catch (error: unknown) {
        const code =
          error instanceof Error ? error.message : "credential_revoke_failed";
        const status =
          code === "confirmation_invalid"
            ? 403
            : code === "device_not_found"
              ? 404
              : 503;
        return reply
          .code(status)
          .send(
            errorResponse(
              request,
              code,
              status === 403
                ? "操作确认已失效"
                : status === 404
                  ? "设备不存在"
                  : "设备凭据撤销失败",
            ),
          );
      }
    },
  );

  fastify.delete<{
    Body: AdminConfirmedDeviceActionRequest;
    Params: AdminDeviceIdParams;
  }>(
    "/api/v1/admin/devices/:deviceId",
    {
      onRequest: [
        requireInstalled,
        requireBrowserConfiguration,
        requireOrigin,
        fastify.csrfProtection,
      ],
      preHandler: fastify.rateLimit({ max: 10, timeWindow: "10 minutes" }),
      schema: {
        body: ADMIN_CONFIRMED_DEVICE_ACTION_REQUEST_SCHEMA,
        params: ADMIN_DEVICE_ID_PARAMS_SCHEMA,
        querystring: EMPTY_OBJECT_SCHEMA,
        response: {
          200: AUTH_ACTION_RESPONSE_SCHEMA,
          400: ERROR_RESPONSE_SCHEMA,
          401: ERROR_RESPONSE_SCHEMA,
          403: ERROR_RESPONSE_SCHEMA,
          404: ERROR_RESPONSE_SCHEMA,
          503: ERROR_RESPONSE_SCHEMA,
        },
      },
    },
    async (request, reply) => {
      const session = await requireAdminSession(request, reply, true);
      if (session === undefined) {
        return;
      }
      try {
        await options.getAuthRuntime().confirmations.consume({
          action: "admin.device.delete",
          actorId: session.userId,
          payload: {},
          sessionId: session.id,
          targetId: request.params.deviceId,
          token: request.body.confirmationToken,
        });
        await options.getDeviceRuntime().admin.delete(request.params.deviceId);
        audit(
          {
            action: "admin.device_deleted",
            actorId: session.userId,
            actorType: "user",
            requestId: request.id,
            result: "success",
            subjectId: request.params.deviceId,
            subjectType: "device",
            visibility: "admin",
          },
          request,
        );
        return { success: true as const };
      } catch (error: unknown) {
        const code =
          error instanceof Error ? error.message : "device_delete_failed";
        const status =
          code === "confirmation_invalid"
            ? 403
            : code === "device_not_found"
              ? 404
              : code === "device_credentials_active"
                ? 400
                : 503;
        return reply
          .code(status)
          .send(
            errorResponse(
              request,
              code,
              status === 403
                ? "操作确认已失效"
                : status === 404
                  ? "设备不存在"
                  : status === 400
                    ? "必须先撤销设备凭据"
                    : "设备删除失败",
            ),
          );
      }
    },
  );

  fastify.post(
    "/api/v1/enrollment-tokens",
    {
      onRequest: [
        requireInstalled,
        requireBrowserConfiguration,
        requireOrigin,
        fastify.csrfProtection,
      ],
      preHandler: fastify.rateLimit({ max: 10, timeWindow: "10 minutes" }),
      schema: {
        body: EMPTY_OBJECT_SCHEMA,
        params: EMPTY_OBJECT_SCHEMA,
        querystring: EMPTY_OBJECT_SCHEMA,
        response: {
          200: CREATE_ENROLLMENT_TOKEN_RESPONSE_SCHEMA,
          401: ERROR_RESPONSE_SCHEMA,
          403: ERROR_RESPONSE_SCHEMA,
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
        const enrollment = await options
          .getDeviceRuntime()
          .service.createEnrollmentToken(session.userId);
        audit(
          {
            action: "enrollment.create",
            actorId: session.userId,
            actorType: "user",
            ownerUserId: session.userId,
            requestId: request.id,
            result: "success",
            subjectId: session.userId,
            subjectType: "enrollment_token",
            visibility: "owner",
          },
          request,
        );
        return enrollment;
      } catch {
        return reply
          .code(503)
          .send(
            errorResponse(
              request,
              "enrollment_unavailable",
              "注册码服务暂不可用",
            ),
          );
      }
    },
  );

  fastify.get(
    "/api/v1/devices",
    {
      onRequest: [requireInstalled, requireBrowserConfiguration],
      schema: {
        params: EMPTY_OBJECT_SCHEMA,
        querystring: EMPTY_OBJECT_SCHEMA,
        response: {
          200: DEVICE_LIST_RESPONSE_SCHEMA,
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
        return {
          devices: await options
            .getDeviceRuntime()
            .service.listDevices(session.userId),
        };
      } catch {
        return reply
          .code(503)
          .send(
            errorResponse(request, "devices_unavailable", "设备列表暂不可用"),
          );
      }
    },
  );

  fastify.get(
    "/api/v1/events",
    {
      onRequest: [requireInstalled, requireBrowserConfiguration],
      schema: {
        params: EMPTY_OBJECT_SCHEMA,
        querystring: EMPTY_OBJECT_SCHEMA,
        response: {
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
        const runtime = options.getDeviceRuntime();
        const devices = await runtime.service.listDevices(session.userId);
        const allowedDeviceIds = new Set(devices.map((device) => device.id));
        reply.hijack();
        reply.raw.writeHead(200, {
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
          "Content-Type": "text/event-stream; charset=utf-8",
          "X-Accel-Buffering": "no",
        });
        reply.raw.write('event: ready\ndata: {"type":"ready"}\n\n');
        let closed = false;
        const writeEvent = (event: string, data: object): void => {
          if (closed) {
            return;
          }
          if (
            !reply.raw.write(
              `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
            )
          ) {
            closed = true;
            reply.raw.destroy();
          }
        };
        const unsubscribeDevices = runtime.connections.subscribe((event) => {
          if (allowedDeviceIds.has(event.deviceId)) {
            writeEvent("device.status", {
              deviceId: event.deviceId,
              online: event.online,
              type: "device.status",
            });
          }
        });
        const unsubscribeCommands = options
          .getCommandRuntime()
          .subscribe(session.userId, (event) => {
            writeEvent("command.status", {
              batchId: event.batchId,
              commandId: event.commandId,
              deviceId: event.deviceId,
              status: event.status,
              type: "command.status",
            });
          });
        const heartbeat = setInterval(() => {
          if (!closed && !reply.raw.write(": heartbeat\n\n")) {
            closed = true;
            reply.raw.destroy();
          }
        }, 15_000);
        request.raw.once("close", () => {
          closed = true;
          clearInterval(heartbeat);
          unsubscribeCommands();
          unsubscribeDevices();
        });
      } catch {
        if (!reply.sent) {
          return reply
            .code(503)
            .send(
              errorResponse(request, "events_unavailable", "事件流暂不可用"),
            );
        }
      }
    },
  );

  fastify.post<{ Body: RegisterAgentRequest }>(
    "/api/v1/agent/register",
    {
      onRequest: [requireInstalled, requireDeviceConfiguration],
      preHandler: fastify.rateLimit({ max: 10, timeWindow: "1 minute" }),
      schema: {
        body: REGISTER_AGENT_REQUEST_SCHEMA,
        params: EMPTY_OBJECT_SCHEMA,
        querystring: EMPTY_OBJECT_SCHEMA,
        response: {
          200: REGISTER_AGENT_RESPONSE_SCHEMA,
          400: ERROR_RESPONSE_SCHEMA,
          404: ERROR_RESPONSE_SCHEMA,
          503: ERROR_RESPONSE_SCHEMA,
        },
      },
    },
    async (request, reply) => {
      try {
        const deviceId = await options
          .getDeviceRuntime()
          .service.registerDevice(request.body);
        audit(
          {
            action: "device.register",
            actorId: deviceId,
            actorType: "agent",
            requestId: request.id,
            result: "success",
            subjectId: deviceId,
            subjectType: "device",
            visibility: "system",
          },
          request,
        );
        return { deviceId };
      } catch (error: unknown) {
        if (
          error instanceof Error &&
          error.message === "enrollment_token_invalid"
        ) {
          return reply
            .code(400)
            .send(
              errorResponse(
                request,
                "enrollment_token_invalid",
                "注册码无效或已过期",
              ),
            );
        }
        return reply
          .code(503)
          .send(
            errorResponse(
              request,
              "device_registration_unavailable",
              "设备注册暂不可用",
            ),
          );
      }
    },
  );

  fastify.get(
    "/api/v1/agent/connect",
    {
      onRequest: [requireInstalled, requireDeviceConfiguration],
      websocket: true,
    },
    (socket, request) => {
      let authenticated: AuthenticatedAgentConnection | undefined;
      let challengeIssued = false;
      let heartbeatTimeout: ReturnType<typeof setTimeout> | undefined;
      let outboundSequence = 1;
      const authenticationTimeout = setTimeout(() => {
        if (authenticated === undefined) {
          socket.close(4003, "authentication_timeout");
        }
      }, AGENT_AUTHENTICATION_TIMEOUT_MILLISECONDS);
      const armHeartbeatTimeout = (): void => {
        clearTimeout(heartbeatTimeout);
        heartbeatTimeout = setTimeout(() => {
          socket.close(4000, "heartbeat_timeout");
        }, AGENT_HEARTBEAT_TIMEOUT_MILLISECONDS);
      };

      const handleMessage = async (serialized: string): Promise<void> => {
        const value: unknown = JSON.parse(serialized);
        const runtime = options.getDeviceRuntime();
        if (!challengeIssued) {
          if (!Value.Check(AGENT_HELLO_SCHEMA, value)) {
            throw new Error("agent_message_invalid");
          }
          challengeIssued = true;
          const challenge = await runtime.agentConnections.begin(
            value as AgentHello,
          );
          socket.send(JSON.stringify(challenge));
          return;
        }
        if (authenticated === undefined) {
          if (!Value.Check(AGENT_AUTHENTICATE_SCHEMA, value)) {
            throw new Error("agent_message_invalid");
          }
          authenticated = await runtime.agentConnections.authenticate(
            value as AgentAuthenticate,
            request.ip || request.socket?.remoteAddress || "unknown",
          );
          audit(
            {
              action: "agent.connect",
              actorId: authenticated.deviceId,
              actorType: "agent",
              requestId: request.id,
              result: "success",
              subjectId: authenticated.sessionId,
              subjectType: "device_session",
              visibility: "system",
            },
            request,
          );
          clearTimeout(authenticationTimeout);
          armHeartbeatTimeout();
          const previous = liveSockets.get(authenticated.deviceId);
          liveSockets.set(authenticated.deviceId, {
            close: (code, reason) => socket.close(code, reason),
            generation: authenticated.generation,
          });
          runtime.connections.attachSender(
            authenticated.deviceId,
            authenticated.generation,
            (payload) => {
              if (socket.bufferedAmount > 8 * 64 * 1_024) {
                socket.close(4001, "send_queue_capacity_exceeded");
                return;
              }
              outboundSequence += 1;
              socket.send(
                JSON.stringify({
                  ...payload,
                  messageSequence: outboundSequence,
                  protocolVersion: AGENT_PROTOCOL_VERSION,
                }),
              );
            },
            (reason) => socket.close(4001, reason),
          );
          if (
            previous !== undefined &&
            previous.generation !== authenticated.generation
          ) {
            previous.close(4001, "connection_replaced");
          }
          socket.send(
            JSON.stringify({
              deviceId: authenticated.deviceId,
              generation: authenticated.generation,
              messageSequence: 1,
              protocolVersion: AGENT_PROTOCOL_VERSION,
              sessionId: authenticated.sessionId,
              type: "agent.authenticated",
            }),
          );
          await options
            .getCommandRuntime()
            .onDeviceConnected(authenticated.deviceId);
          return;
        }
        if (Value.Check(AGENT_COMMAND_RESULT_SCHEMA, value)) {
          const result = value as AgentCommandResult;
          if (
            !runtime.connections.isCurrent(
              authenticated.deviceId,
              authenticated.generation,
            ) ||
            result.messageSequence <= authenticated.lastMessageSequence
          ) {
            throw new Error("agent_message_replay");
          }
          authenticated.lastMessageSequence = result.messageSequence;
          await options
            .getCommandRuntime()
            .handleAgentResult(authenticated.deviceId, result);
          return;
        }
        if (!Value.Check(AGENT_HEARTBEAT_SCHEMA, value)) {
          throw new Error("agent_message_unsupported");
        }
        await runtime.agentConnections.heartbeat(
          authenticated,
          value as AgentHeartbeat,
        );
        armHeartbeatTimeout();
        socket.send(
          JSON.stringify({
            deviceId: authenticated.deviceId,
            messageSequence: ++outboundSequence,
            protocolVersion: AGENT_PROTOCOL_VERSION,
            receivedAt: new Date().toISOString(),
            type: "agent.heartbeat_ack",
          }),
        );
      };

      socket.on("message", (data: unknown) => {
        void Promise.resolve()
          .then(async () => handleMessage(serializeAgentMessage(data)))
          .catch((error: unknown) => {
            fastify.log.warn(
              { error, requestId: request.id },
              "agent_connection_message_rejected",
            );
            socket.close(
              4003,
              process.env.NODE_ENV === "test" && error instanceof Error
                ? error.message.slice(0, 123)
                : "authentication_failed",
            );
          });
      });
      socket.on("close", () => {
        clearTimeout(authenticationTimeout);
        clearTimeout(heartbeatTimeout);
        if (authenticated !== undefined) {
          const live = liveSockets.get(authenticated.deviceId);
          if (live?.generation === authenticated.generation) {
            liveSockets.delete(authenticated.deviceId);
          }
          void options
            .getDeviceRuntime()
            .agentConnections.disconnect(authenticated, "socket_closed")
            .catch(() => undefined);
        }
      });
    },
  );
};
