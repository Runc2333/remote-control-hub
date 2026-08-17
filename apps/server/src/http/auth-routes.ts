import {
  AUTH_ACTION_RESPONSE_SCHEMA,
  ADMIN_CREATE_USER_REQUEST_SCHEMA,
  ADMIN_CREATE_USER_RESPONSE_SCHEMA,
  ADMIN_CONFIRMED_ACTION_REQUEST_SCHEMA,
  ADMIN_RESET_PASSWORD_RESPONSE_SCHEMA,
  ADMIN_UPDATE_USER_REQUEST_SCHEMA,
  ADMIN_USER_ID_PARAMS_SCHEMA,
  ADMIN_USER_LIST_RESPONSE_SCHEMA,
  ADMIN_USER_SCHEMA,
  ACTION_CONFIRMATION_REQUEST_SCHEMA,
  ACTION_CONFIRMATION_RESPONSE_SCHEMA,
  AUDIT_EVENT_LIST_RESPONSE_SCHEMA,
  AUDIT_EVENT_QUERY_SCHEMA,
  CHANGE_PASSWORD_REQUEST_SCHEMA,
  COMPLETE_TEMPORARY_PASSWORD_REQUEST_SCHEMA,
  CONFIRMED_ACTION_REQUEST_SCHEMA,
  CSRF_TOKEN_RESPONSE_SCHEMA,
  EMPTY_OBJECT_SCHEMA,
  ERROR_RESPONSE_SCHEMA,
  LOGIN_REQUEST_SCHEMA,
  LOGIN_RESPONSE_SCHEMA,
  PASSKEY_AUTHENTICATION_VERIFY_REQUEST_SCHEMA,
  PASSKEY_ID_PARAMS_SCHEMA,
  PASSKEY_LIST_RESPONSE_SCHEMA,
  PASSKEY_REGISTRATION_VERIFY_REQUEST_SCHEMA,
  PASSKEY_RENAME_REQUEST_SCHEMA,
  PASSKEY_SCHEMA,
  REGISTER_REQUEST_SCHEMA,
  REGISTER_RESPONSE_SCHEMA,
  REGISTRATION_MODE_RESPONSE_SCHEMA,
  REVOKE_OTHERS_RESPONSE_SCHEMA,
  SESSION_ID_PARAMS_SCHEMA,
  SESSION_LIST_RESPONSE_SCHEMA,
  STEP_UP_PASSWORD_REQUEST_SCHEMA,
  TOTP_LOGIN_REQUEST_SCHEMA,
  TOTP_ENROLLMENT_BEGIN_RESPONSE_SCHEMA,
  TOTP_ENROLLMENT_CONFIRM_REQUEST_SCHEMA,
  TOTP_ENROLLMENT_CONFIRM_RESPONSE_SCHEMA,
  TOTP_STATUS_RESPONSE_SCHEMA,
  UPDATE_REGISTRATION_MODE_REQUEST_SCHEMA,
  WEBAUTHN_OPTIONS_RESPONSE_SCHEMA,
  type AdminCreateUserRequest,
  type AdminConfirmedActionRequest,
  type AdminUpdateUserRequest,
  type AdminUserIdParams,
  type ActionConfirmationRequest,
  type AuditEventQuery,
  type ConfirmedActionRequest,
  type LoginRequest,
  type PasskeyIdParams,
  type RegisterRequest,
  type SessionIdParams,
  type StepUpPasswordRequest,
  type TotpLoginRequest,
  type WebauthnAuthenticationResponse,
  type WebauthnRegistrationResponse,
} from "@remote-control-hub/contracts";
import type {
  AuthenticationResponseJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/server";
import type {
  FastifyPluginAsync,
  FastifyReply,
  FastifyRequest,
  onRequestHookHandler,
} from "fastify";
import type { ServerConfig } from "../config.js";
import type { AuthRuntime } from "../auth/auth-runtime.js";
import { toPublicSession } from "../auth/auth-service.js";
import type { StoredSession } from "../auth/session-store.js";
import { SessionMetadataResolver } from "../auth/session-metadata.js";
import type { AuditEventInput } from "../audit/audit-service.js";
import type { AuditService } from "../audit/audit-service.js";
import type { AuditQueryService } from "../audit/audit-query-service.js";
import { FileSetupStateStore } from "../setup/setup-state.js";

const SESSION_COOKIE_NAME = "rch_session";
const TEMPORARY_PASSWORD_COOKIE_NAME = "rch_password_change";
const SECOND_FACTOR_COOKIE_NAME = "rch_second_factor";
const WEBAUTHN_COOKIE_NAME = "rch_webauthn";
const WEBAUTHN_STEP_UP_COOKIE_NAME = "rch_webauthn_step_up";
const SESSION_COOKIE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
const TEMPORARY_PASSWORD_COOKIE_MAX_AGE_SECONDS = 5 * 60;
const RECENT_AUTHENTICATION_MILLISECONDS = 10 * 60 * 1_000;
const CONFIRMABLE_ACTIONS = new Set([
  "auth.totp.disable",
  "auth.totp.recovery_codes_regenerate",
  "admin.device.delete",
  "admin.device.credentials_revoke",
  "admin.registration.update",
  "admin.user.create",
  "admin.user.delete",
  "admin.user.reset_authentication",
  "admin.user.reset_password",
  "admin.user.update",
]);

export type AuthRoutesOptions = {
  config: ServerConfig;
  getAuditQueryService: () => Pick<
    AuditQueryService,
    "listAdmin" | "listOwner"
  >;
  getAuditService: () => Pick<AuditService, "record">;
  getAuthRuntime: () => AuthRuntime;
};

type AuthenticationResult =
  | {
      kind: "authenticated";
      runtime: AuthRuntime;
      session: StoredSession;
      token: string;
    }
  | { kind: "missing" }
  | { kind: "unavailable" };

const cookieOptions = {
  httpOnly: true,
  path: "/",
  sameSite: "strict" as const,
  secure: true,
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

const isSessionCapacityError = (error: unknown): boolean =>
  error instanceof Error &&
  error.message === "browser_session_capacity_exceeded";

export const authRoutes: FastifyPluginAsync<AuthRoutesOptions> = async (
  fastify,
  options,
) => {
  const setupState = new FileSetupStateStore(
    options.config.setupStateFile,
    options.config.deploymentMode,
  );
  const sessionMetadata = new SessionMetadataResolver(options.config);
  const requireInstalled: onRequestHookHandler = async (request, reply) => {
    const state = await setupState.read();
    if (state.step !== "installed") {
      return reply
        .code(404)
        .send(errorResponse(request, "not_found", "资源不存在"));
    }
  };

  const requireAuthConfiguration: onRequestHookHandler = async (
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

  const requireOrigin: onRequestHookHandler = async (request, reply) => {
    if (request.headers.origin !== options.config.appOrigin) {
      return reply
        .code(403)
        .send(errorResponse(request, "origin_invalid", "请求来源无法验证"));
    }
  };

  const getRuntime = (): AuthRuntime => {
    return options.getAuthRuntime();
  };
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

  const authenticate = async (
    request: FastifyRequest,
  ): Promise<AuthenticationResult> => {
    const token = request.cookies[SESSION_COOKIE_NAME];
    if (token === undefined) {
      return { kind: "missing" };
    }
    try {
      const activeRuntime = getRuntime();
      const session = await activeRuntime.sessions.authenticate(token);
      return session === undefined
        ? { kind: "missing" }
        : { kind: "authenticated", runtime: activeRuntime, session, token };
    } catch {
      return { kind: "unavailable" };
    }
  };

  const requireSession = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<
    (AuthenticationResult & { kind: "authenticated" }) | undefined
  > => {
    const result = await authenticate(request);
    if (result.kind === "missing") {
      reply
        .code(401)
        .send(errorResponse(request, "authentication_required", "需要登录"));
      return undefined;
    }
    if (result.kind === "unavailable") {
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
    return result;
  };

  const hasRecentStrongAuthentication = (session: StoredSession): boolean =>
    session.strongAuthenticatedAt !== undefined &&
    Date.now() - Date.parse(session.strongAuthenticatedAt) <=
      RECENT_AUTHENTICATION_MILLISECONDS;

  const requireAdminSession = async (
    request: FastifyRequest,
    reply: FastifyReply,
    recentAuthentication: boolean,
  ): Promise<
    (AuthenticationResult & { kind: "authenticated" }) | undefined
  > => {
    const authenticated = await requireSession(request, reply);
    if (authenticated === undefined) {
      return undefined;
    }
    if (
      authenticated.session.role !== "admin" ||
      (recentAuthentication &&
        !hasRecentStrongAuthentication(authenticated.session))
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
    return authenticated;
  };

  fastify.get(
    "/api/v1/auth/csrf",
    {
      onRequest: [requireInstalled, requireAuthConfiguration],
      schema: {
        params: EMPTY_OBJECT_SCHEMA,
        querystring: EMPTY_OBJECT_SCHEMA,
        response: {
          200: CSRF_TOKEN_RESPONSE_SCHEMA,
          404: ERROR_RESPONSE_SCHEMA,
          503: ERROR_RESPONSE_SCHEMA,
        },
      },
    },
    async (_request, reply) => ({ csrfToken: reply.generateCsrf() }),
  );

  fastify.get<{ Querystring: AuditEventQuery }>(
    "/api/v1/audit-events",
    {
      onRequest: [requireInstalled, requireAuthConfiguration],
      schema: {
        params: EMPTY_OBJECT_SCHEMA,
        querystring: AUDIT_EVENT_QUERY_SCHEMA,
        response: {
          200: AUDIT_EVENT_LIST_RESPONSE_SCHEMA,
          400: ERROR_RESPONSE_SCHEMA,
          401: ERROR_RESPONSE_SCHEMA,
          404: ERROR_RESPONSE_SCHEMA,
          503: ERROR_RESPONSE_SCHEMA,
        },
      },
    },
    async (request, reply) => {
      const authenticated = await requireSession(request, reply);
      if (authenticated === undefined) {
        return;
      }
      try {
        return await options
          .getAuditQueryService()
          .listOwner(authenticated.session.userId, request.query);
      } catch (error: unknown) {
        const invalidCursor =
          error instanceof Error && error.message === "audit_cursor_invalid";
        return reply
          .code(invalidCursor ? 400 : 503)
          .send(
            errorResponse(
              request,
              invalidCursor ? "audit_cursor_invalid" : "audit_unavailable",
              invalidCursor ? "分页位置无效" : "审计记录暂不可用",
            ),
          );
      }
    },
  );

  fastify.get<{ Querystring: AuditEventQuery }>(
    "/api/v1/admin/audit-events",
    {
      onRequest: [requireInstalled, requireAuthConfiguration],
      schema: {
        params: EMPTY_OBJECT_SCHEMA,
        querystring: AUDIT_EVENT_QUERY_SCHEMA,
        response: {
          200: AUDIT_EVENT_LIST_RESPONSE_SCHEMA,
          400: ERROR_RESPONSE_SCHEMA,
          401: ERROR_RESPONSE_SCHEMA,
          403: ERROR_RESPONSE_SCHEMA,
          404: ERROR_RESPONSE_SCHEMA,
          503: ERROR_RESPONSE_SCHEMA,
        },
      },
    },
    async (request, reply) => {
      const authenticated = await requireAdminSession(request, reply, false);
      if (authenticated === undefined) {
        return;
      }
      try {
        return await options.getAuditQueryService().listAdmin(request.query);
      } catch (error: unknown) {
        const invalidCursor =
          error instanceof Error && error.message === "audit_cursor_invalid";
        return reply
          .code(invalidCursor ? 400 : 503)
          .send(
            errorResponse(
              request,
              invalidCursor ? "audit_cursor_invalid" : "audit_unavailable",
              invalidCursor ? "分页位置无效" : "审计记录暂不可用",
            ),
          );
      }
    },
  );

  fastify.post<{ Body: StepUpPasswordRequest }>(
    "/api/v1/auth/step-up/password",
    {
      onRequest: [
        requireInstalled,
        requireAuthConfiguration,
        requireOrigin,
        fastify.csrfProtection,
      ],
      preHandler: fastify.rateLimit({ max: 5, timeWindow: "10 minutes" }),
      schema: {
        body: STEP_UP_PASSWORD_REQUEST_SCHEMA,
        params: EMPTY_OBJECT_SCHEMA,
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
      const authenticated = await requireSession(request, reply);
      if (authenticated === undefined) {
        return;
      }
      if (authenticated.session.authStrength === "password_recovery") {
        return reply
          .code(403)
          .send(
            errorResponse(
              request,
              "recovery_session_restricted",
              "恢复码会话不能完成增强验证",
            ),
          );
      }
      try {
        await authenticated.runtime.accounts.verifyCurrentPassword(
          authenticated.session.userId,
          request.body.password,
        );
        const status = await authenticated.runtime.totpEnrollment.getStatus(
          authenticated.session.userId,
        );
        if (
          status.enabled &&
          (request.body.totpCode === undefined ||
            !(await authenticated.runtime.secondFactor.verifyTotp(
              authenticated.session.userId,
              request.body.totpCode,
            )))
        ) {
          throw new Error("step_up_invalid");
        }
        await authenticated.runtime.sessions.markStrongAuthenticated(
          authenticated.token,
          authenticated.session.userId,
        );
        audit(
          {
            action: "auth.step_up_password",
            actorId: authenticated.session.userId,
            actorType: "user",
            ownerUserId: authenticated.session.userId,
            requestId: request.id,
            result: "success",
            subjectId: authenticated.session.id,
            subjectType: "session",
            visibility: "owner",
          },
          request,
        );
        return { success: true as const };
      } catch (error: unknown) {
        const unavailable =
          error instanceof Error &&
          ["mysql_unavailable", "totp_key_missing"].includes(error.message);
        return reply
          .code(unavailable ? 503 : 401)
          .send(
            errorResponse(
              request,
              unavailable ? "step_up_unavailable" : "step_up_invalid",
              unavailable ? "身份验证暂不可用" : "身份验证失败",
            ),
          );
      }
    },
  );

  fastify.post(
    "/api/v1/auth/step-up/passkey/options",
    {
      onRequest: [
        requireInstalled,
        requireAuthConfiguration,
        requireOrigin,
        fastify.csrfProtection,
      ],
      preHandler: fastify.rateLimit({ max: 10, timeWindow: "10 minutes" }),
      schema: {
        body: EMPTY_OBJECT_SCHEMA,
        params: EMPTY_OBJECT_SCHEMA,
        querystring: EMPTY_OBJECT_SCHEMA,
        response: {
          200: WEBAUTHN_OPTIONS_RESPONSE_SCHEMA,
          401: ERROR_RESPONSE_SCHEMA,
          403: ERROR_RESPONSE_SCHEMA,
          404: ERROR_RESPONSE_SCHEMA,
          503: ERROR_RESPONSE_SCHEMA,
        },
      },
    },
    async (request, reply) => {
      const authenticated = await requireSession(request, reply);
      if (authenticated === undefined) {
        return;
      }
      if (authenticated.session.authStrength === "password_recovery") {
        return reply
          .code(403)
          .send(
            errorResponse(
              request,
              "recovery_session_restricted",
              "恢复码会话不能完成增强验证",
            ),
          );
      }
      try {
        const challenge = await authenticated.runtime.passkeys.beginStepUp(
          authenticated.session.userId,
        );
        reply.setCookie(WEBAUTHN_STEP_UP_COOKIE_NAME, challenge.token, {
          ...cookieOptions,
          maxAge: 5 * 60,
        });
        return { options: challenge.options };
      } catch {
        return reply
          .code(503)
          .send(
            errorResponse(
              request,
              "passkey_step_up_unavailable",
              "Passkey 验证暂不可用",
            ),
          );
      }
    },
  );

  fastify.post<{
    Body: { response: WebauthnAuthenticationResponse };
  }>(
    "/api/v1/auth/step-up/passkey/verify",
    {
      onRequest: [
        requireInstalled,
        requireAuthConfiguration,
        requireOrigin,
        fastify.csrfProtection,
      ],
      preHandler: fastify.rateLimit({ max: 10, timeWindow: "10 minutes" }),
      schema: {
        body: PASSKEY_AUTHENTICATION_VERIFY_REQUEST_SCHEMA,
        params: EMPTY_OBJECT_SCHEMA,
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
      const authenticated = await requireSession(request, reply);
      if (authenticated === undefined) {
        return;
      }
      const challengeToken = request.cookies[WEBAUTHN_STEP_UP_COOKIE_NAME];
      if (
        authenticated.session.authStrength === "password_recovery" ||
        challengeToken === undefined
      ) {
        return reply
          .code(403)
          .send(
            errorResponse(
              request,
              "passkey_step_up_invalid",
              "Passkey 验证已失效",
            ),
          );
      }
      try {
        await authenticated.runtime.passkeys.completeStepUp(
          challengeToken,
          authenticated.session.userId,
          request.body.response as AuthenticationResponseJSON,
        );
        await authenticated.runtime.sessions.markStrongAuthenticated(
          authenticated.token,
          authenticated.session.userId,
        );
        reply.clearCookie(WEBAUTHN_STEP_UP_COOKIE_NAME, cookieOptions);
        audit(
          {
            action: "auth.step_up_passkey",
            actorId: authenticated.session.userId,
            actorType: "user",
            ownerUserId: authenticated.session.userId,
            requestId: request.id,
            result: "success",
            subjectId: authenticated.session.id,
            subjectType: "session",
            visibility: "owner",
          },
          request,
        );
        return { success: true as const };
      } catch {
        reply.clearCookie(WEBAUTHN_STEP_UP_COOKIE_NAME, cookieOptions);
        return reply
          .code(400)
          .send(
            errorResponse(
              request,
              "passkey_step_up_invalid",
              "Passkey 验证失败",
            ),
          );
      }
    },
  );

  fastify.post<{ Body: ActionConfirmationRequest }>(
    "/api/v1/auth/action-confirmations",
    {
      onRequest: [
        requireInstalled,
        requireAuthConfiguration,
        requireOrigin,
        fastify.csrfProtection,
      ],
      preHandler: fastify.rateLimit({ max: 20, timeWindow: "10 minutes" }),
      schema: {
        body: ACTION_CONFIRMATION_REQUEST_SCHEMA,
        params: EMPTY_OBJECT_SCHEMA,
        querystring: EMPTY_OBJECT_SCHEMA,
        response: {
          200: ACTION_CONFIRMATION_RESPONSE_SCHEMA,
          400: ERROR_RESPONSE_SCHEMA,
          401: ERROR_RESPONSE_SCHEMA,
          403: ERROR_RESPONSE_SCHEMA,
          404: ERROR_RESPONSE_SCHEMA,
          503: ERROR_RESPONSE_SCHEMA,
        },
      },
    },
    async (request, reply) => {
      const authenticated = await requireSession(request, reply);
      if (authenticated === undefined) {
        return;
      }
      const requiresAdministrator = request.body.action.startsWith("admin.");
      if (
        !hasRecentStrongAuthentication(authenticated.session) ||
        (requiresAdministrator && authenticated.session.role !== "admin")
      ) {
        return reply
          .code(403)
          .send(
            errorResponse(
              request,
              "recent_authentication_required",
              "需要重新验证身份",
            ),
          );
      }
      if (!CONFIRMABLE_ACTIONS.has(request.body.action)) {
        return reply
          .code(400)
          .send(
            errorResponse(
              request,
              "confirmation_action_invalid",
              "操作不支持确认令牌",
            ),
          );
      }
      return authenticated.runtime.confirmations.issue({
        action: request.body.action,
        actorId: authenticated.session.userId,
        payload: request.body.payload,
        sessionId: authenticated.session.id,
        targetId: request.body.targetId,
      });
    },
  );

  fastify.get(
    "/api/v1/auth/totp",
    {
      onRequest: [requireInstalled, requireAuthConfiguration],
      schema: {
        params: EMPTY_OBJECT_SCHEMA,
        querystring: EMPTY_OBJECT_SCHEMA,
        response: {
          200: TOTP_STATUS_RESPONSE_SCHEMA,
          401: ERROR_RESPONSE_SCHEMA,
          404: ERROR_RESPONSE_SCHEMA,
          503: ERROR_RESPONSE_SCHEMA,
        },
      },
    },
    async (request, reply) => {
      const authenticated = await requireSession(request, reply);
      if (authenticated === undefined) {
        return;
      }
      return authenticated.runtime.totpEnrollment.getStatus(
        authenticated.session.userId,
      );
    },
  );

  fastify.delete<{ Body: ConfirmedActionRequest }>(
    "/api/v1/auth/totp",
    {
      onRequest: [
        requireInstalled,
        requireAuthConfiguration,
        requireOrigin,
        fastify.csrfProtection,
      ],
      preHandler: fastify.rateLimit({ max: 5, timeWindow: "10 minutes" }),
      schema: {
        body: CONFIRMED_ACTION_REQUEST_SCHEMA,
        params: EMPTY_OBJECT_SCHEMA,
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
      const authenticated = await requireSession(request, reply);
      if (authenticated === undefined) {
        return;
      }
      if (!hasRecentStrongAuthentication(authenticated.session)) {
        return reply
          .code(403)
          .send(
            errorResponse(
              request,
              "recent_authentication_required",
              "需要重新验证身份",
            ),
          );
      }
      try {
        await authenticated.runtime.confirmations.consume({
          action: "auth.totp.disable",
          actorId: authenticated.session.userId,
          payload: {},
          sessionId: authenticated.session.id,
          targetId: "self",
          token: request.body.confirmationToken,
        });
        await authenticated.runtime.totpEnrollment.disable(
          authenticated.session.userId,
        );
        await authenticated.runtime.sessions.revokeAll(
          authenticated.session.userId,
        );
        reply.clearCookie(SESSION_COOKIE_NAME, cookieOptions);
        audit(
          {
            action: "auth.totp_disabled",
            actorId: authenticated.session.userId,
            actorType: "user",
            ownerUserId: authenticated.session.userId,
            requestId: request.id,
            result: "success",
            subjectId: authenticated.session.userId,
            subjectType: "totp_authenticator",
            visibility: "owner",
          },
          request,
        );
        return { success: true as const };
      } catch (error: unknown) {
        const code =
          error instanceof Error ? error.message : "totp_disable_failed";
        const status =
          code === "confirmation_invalid"
            ? 403
            : code === "totp_not_enabled"
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
                : status === 400
                  ? "TOTP 尚未启用"
                  : "TOTP 关闭失败",
            ),
          );
      }
    },
  );

  fastify.post<{ Body: ConfirmedActionRequest }>(
    "/api/v1/auth/totp/recovery-codes",
    {
      onRequest: [
        requireInstalled,
        requireAuthConfiguration,
        requireOrigin,
        fastify.csrfProtection,
      ],
      preHandler: fastify.rateLimit({ max: 5, timeWindow: "10 minutes" }),
      schema: {
        body: CONFIRMED_ACTION_REQUEST_SCHEMA,
        params: EMPTY_OBJECT_SCHEMA,
        querystring: EMPTY_OBJECT_SCHEMA,
        response: {
          200: TOTP_ENROLLMENT_CONFIRM_RESPONSE_SCHEMA,
          400: ERROR_RESPONSE_SCHEMA,
          401: ERROR_RESPONSE_SCHEMA,
          403: ERROR_RESPONSE_SCHEMA,
          404: ERROR_RESPONSE_SCHEMA,
          503: ERROR_RESPONSE_SCHEMA,
        },
      },
    },
    async (request, reply) => {
      const authenticated = await requireSession(request, reply);
      if (authenticated === undefined) {
        return;
      }
      if (!hasRecentStrongAuthentication(authenticated.session)) {
        return reply
          .code(403)
          .send(
            errorResponse(
              request,
              "recent_authentication_required",
              "需要重新验证身份",
            ),
          );
      }
      try {
        await authenticated.runtime.confirmations.consume({
          action: "auth.totp.recovery_codes_regenerate",
          actorId: authenticated.session.userId,
          payload: {},
          sessionId: authenticated.session.id,
          targetId: "self",
          token: request.body.confirmationToken,
        });
        const recoveryCodes =
          await authenticated.runtime.totpEnrollment.regenerateRecoveryCodes(
            authenticated.session.userId,
          );
        audit(
          {
            action: "auth.totp_recovery_codes_regenerated",
            actorId: authenticated.session.userId,
            actorType: "user",
            ownerUserId: authenticated.session.userId,
            requestId: request.id,
            result: "success",
            subjectId: authenticated.session.userId,
            subjectType: "recovery_codes",
            visibility: "owner",
          },
          request,
        );
        return recoveryCodes;
      } catch (error: unknown) {
        const code =
          error instanceof Error ? error.message : "recovery_codes_failed";
        const status =
          code === "confirmation_invalid"
            ? 403
            : code === "totp_not_enabled"
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
                : status === 400
                  ? "TOTP 尚未启用"
                  : "恢复码生成失败",
            ),
          );
      }
    },
  );

  fastify.patch<{
    Body: { name: string };
    Params: PasskeyIdParams;
  }>(
    "/api/v1/auth/passkeys/:passkeyId",
    {
      onRequest: [
        requireInstalled,
        requireAuthConfiguration,
        requireOrigin,
        fastify.csrfProtection,
      ],
      schema: {
        body: PASSKEY_RENAME_REQUEST_SCHEMA,
        params: PASSKEY_ID_PARAMS_SCHEMA,
        querystring: EMPTY_OBJECT_SCHEMA,
        response: {
          200: PASSKEY_SCHEMA,
          400: ERROR_RESPONSE_SCHEMA,
          401: ERROR_RESPONSE_SCHEMA,
          403: ERROR_RESPONSE_SCHEMA,
          404: ERROR_RESPONSE_SCHEMA,
          503: ERROR_RESPONSE_SCHEMA,
        },
      },
    },
    async (request, reply) => {
      const authenticated = await requireSession(request, reply);
      if (authenticated === undefined) {
        return;
      }
      if (!hasRecentStrongAuthentication(authenticated.session)) {
        return reply
          .code(403)
          .send(
            errorResponse(
              request,
              "recent_authentication_required",
              "需要重新验证身份",
            ),
          );
      }
      try {
        return await authenticated.runtime.passkeys.rename(
          authenticated.session.userId,
          request.params.passkeyId,
          request.body.name,
        );
      } catch (error: unknown) {
        const code =
          error instanceof Error ? error.message : "passkey_not_found";
        return reply
          .code(code === "passkey_name_invalid" ? 400 : 404)
          .send(
            errorResponse(
              request,
              code,
              code === "passkey_name_invalid"
                ? "Passkey 名称无效"
                : "Passkey 不存在",
            ),
          );
      }
    },
  );

  fastify.delete<{ Params: PasskeyIdParams }>(
    "/api/v1/auth/passkeys/:passkeyId",
    {
      onRequest: [
        requireInstalled,
        requireAuthConfiguration,
        requireOrigin,
        fastify.csrfProtection,
      ],
      schema: {
        params: PASSKEY_ID_PARAMS_SCHEMA,
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
      const authenticated = await requireSession(request, reply);
      if (authenticated === undefined) {
        return;
      }
      if (!hasRecentStrongAuthentication(authenticated.session)) {
        return reply
          .code(403)
          .send(
            errorResponse(
              request,
              "recent_authentication_required",
              "需要重新验证身份",
            ),
          );
      }
      try {
        await authenticated.runtime.passkeys.delete(
          authenticated.session.userId,
          request.params.passkeyId,
        );
        audit(
          {
            action: "auth.passkey_deleted",
            actorId: authenticated.session.userId,
            actorType: "user",
            ownerUserId: authenticated.session.userId,
            requestId: request.id,
            result: "success",
            subjectId: request.params.passkeyId,
            subjectType: "passkey",
            visibility: "owner",
          },
          request,
        );
        return { success: true as const };
      } catch {
        return reply
          .code(404)
          .send(errorResponse(request, "passkey_not_found", "Passkey 不存在"));
      }
    },
  );

  fastify.get(
    "/api/v1/admin/users",
    {
      onRequest: [requireInstalled, requireAuthConfiguration],
      schema: {
        params: EMPTY_OBJECT_SCHEMA,
        querystring: EMPTY_OBJECT_SCHEMA,
        response: {
          200: ADMIN_USER_LIST_RESPONSE_SCHEMA,
          401: ERROR_RESPONSE_SCHEMA,
          403: ERROR_RESPONSE_SCHEMA,
          404: ERROR_RESPONSE_SCHEMA,
          503: ERROR_RESPONSE_SCHEMA,
        },
      },
    },
    async (request, reply) => {
      const authenticated = await requireAdminSession(request, reply, false);
      if (authenticated === undefined) {
        return;
      }
      return { users: await authenticated.runtime.adminUsers.list() };
    },
  );

  fastify.patch<{
    Body: AdminUpdateUserRequest;
    Params: AdminUserIdParams;
  }>(
    "/api/v1/admin/users/:userId",
    {
      onRequest: [
        requireInstalled,
        requireAuthConfiguration,
        requireOrigin,
        fastify.csrfProtection,
      ],
      preHandler: fastify.rateLimit({ max: 20, timeWindow: "10 minutes" }),
      schema: {
        body: ADMIN_UPDATE_USER_REQUEST_SCHEMA,
        params: ADMIN_USER_ID_PARAMS_SCHEMA,
        querystring: EMPTY_OBJECT_SCHEMA,
        response: {
          200: ADMIN_USER_SCHEMA,
          400: ERROR_RESPONSE_SCHEMA,
          401: ERROR_RESPONSE_SCHEMA,
          403: ERROR_RESPONSE_SCHEMA,
          404: ERROR_RESPONSE_SCHEMA,
          409: ERROR_RESPONSE_SCHEMA,
          503: ERROR_RESPONSE_SCHEMA,
        },
      },
    },
    async (request, reply) => {
      const authenticated = await requireAdminSession(request, reply, true);
      if (authenticated === undefined) {
        return;
      }
      const { confirmationToken, identityVerificationReference, ...update } =
        request.body;
      const payload = {
        ...update,
        ...(identityVerificationReference === undefined
          ? {}
          : { identityVerificationReference }),
      };
      try {
        await authenticated.runtime.confirmations.consume({
          action: "admin.user.update",
          actorId: authenticated.session.userId,
          payload,
          sessionId: authenticated.session.id,
          targetId: request.params.userId,
          token: confirmationToken,
        });
        const user = await authenticated.runtime.adminUsers.update(
          request.params.userId,
          update,
        );
        audit(
          {
            action: "admin.user_updated",
            actorId: authenticated.session.userId,
            actorType: "user",
            metadata: payload,
            requestId: request.id,
            result: "success",
            subjectId: request.params.userId,
            subjectType: "user",
            visibility: "admin",
          },
          request,
        );
        return user;
      } catch (error: unknown) {
        const code =
          error instanceof Error ? error.message : "user_update_failed";
        const status =
          code === "confirmation_invalid"
            ? 403
            : code === "user_not_found"
              ? 404
              : code === "last_admin_protected" ||
                  code === "identifier_conflict"
                ? 409
                : code === "identifier_invalid" || code === "user_update_empty"
                  ? 400
                  : 503;
        return reply
          .code(status)
          .send(errorResponse(request, code, "用户更新失败"));
      }
    },
  );

  fastify.post<{
    Body: AdminConfirmedActionRequest;
    Params: AdminUserIdParams;
  }>(
    "/api/v1/admin/users/:userId/reset-password",
    {
      onRequest: [
        requireInstalled,
        requireAuthConfiguration,
        requireOrigin,
        fastify.csrfProtection,
      ],
      preHandler: fastify.rateLimit({ max: 10, timeWindow: "10 minutes" }),
      schema: {
        body: ADMIN_CONFIRMED_ACTION_REQUEST_SCHEMA,
        params: ADMIN_USER_ID_PARAMS_SCHEMA,
        querystring: EMPTY_OBJECT_SCHEMA,
        response: {
          200: ADMIN_RESET_PASSWORD_RESPONSE_SCHEMA,
          401: ERROR_RESPONSE_SCHEMA,
          403: ERROR_RESPONSE_SCHEMA,
          404: ERROR_RESPONSE_SCHEMA,
          503: ERROR_RESPONSE_SCHEMA,
        },
      },
    },
    async (request, reply) => {
      const authenticated = await requireAdminSession(request, reply, true);
      if (authenticated === undefined) {
        return;
      }
      const payload = {
        ...(request.body.identityVerificationReference === undefined
          ? {}
          : {
              identityVerificationReference:
                request.body.identityVerificationReference,
            }),
      };
      try {
        await authenticated.runtime.confirmations.consume({
          action: "admin.user.reset_password",
          actorId: authenticated.session.userId,
          payload,
          sessionId: authenticated.session.id,
          targetId: request.params.userId,
          token: request.body.confirmationToken,
        });
        const result = await authenticated.runtime.adminUsers.resetPassword(
          request.params.userId,
        );
        audit(
          {
            action: "admin.user_password_reset",
            actorId: authenticated.session.userId,
            actorType: "user",
            metadata: payload,
            requestId: request.id,
            result: "success",
            subjectId: request.params.userId,
            subjectType: "user",
            visibility: "admin",
          },
          request,
        );
        return result;
      } catch (error: unknown) {
        const code =
          error instanceof Error ? error.message : "password_reset_failed";
        return reply
          .code(
            code === "confirmation_invalid"
              ? 403
              : code === "user_not_found"
                ? 404
                : 503,
          )
          .send(errorResponse(request, code, "密码重置失败"));
      }
    },
  );

  fastify.post<{
    Body: AdminConfirmedActionRequest;
    Params: AdminUserIdParams;
  }>(
    "/api/v1/admin/users/:userId/reset-authentication",
    {
      onRequest: [
        requireInstalled,
        requireAuthConfiguration,
        requireOrigin,
        fastify.csrfProtection,
      ],
      preHandler: fastify.rateLimit({ max: 10, timeWindow: "10 minutes" }),
      schema: {
        body: ADMIN_CONFIRMED_ACTION_REQUEST_SCHEMA,
        params: ADMIN_USER_ID_PARAMS_SCHEMA,
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
      const authenticated = await requireAdminSession(request, reply, true);
      if (authenticated === undefined) {
        return;
      }
      const payload = {
        ...(request.body.identityVerificationReference === undefined
          ? {}
          : {
              identityVerificationReference:
                request.body.identityVerificationReference,
            }),
      };
      try {
        await authenticated.runtime.confirmations.consume({
          action: "admin.user.reset_authentication",
          actorId: authenticated.session.userId,
          payload,
          sessionId: authenticated.session.id,
          targetId: request.params.userId,
          token: request.body.confirmationToken,
        });
        await authenticated.runtime.adminUsers.resetEnhancedAuthentication(
          request.params.userId,
        );
        audit(
          {
            action: "admin.user_authentication_reset",
            actorId: authenticated.session.userId,
            actorType: "user",
            metadata: payload,
            requestId: request.id,
            result: "success",
            subjectId: request.params.userId,
            subjectType: "user",
            visibility: "admin",
          },
          request,
        );
        return { success: true as const };
      } catch (error: unknown) {
        const code =
          error instanceof Error
            ? error.message
            : "authentication_reset_failed";
        return reply
          .code(
            code === "confirmation_invalid"
              ? 403
              : code === "user_not_found"
                ? 404
                : 503,
          )
          .send(errorResponse(request, code, "增强认证重置失败"));
      }
    },
  );

  fastify.delete<{
    Body: AdminConfirmedActionRequest;
    Params: AdminUserIdParams;
  }>(
    "/api/v1/admin/users/:userId",
    {
      onRequest: [
        requireInstalled,
        requireAuthConfiguration,
        requireOrigin,
        fastify.csrfProtection,
      ],
      preHandler: fastify.rateLimit({ max: 10, timeWindow: "10 minutes" }),
      schema: {
        body: ADMIN_CONFIRMED_ACTION_REQUEST_SCHEMA,
        params: ADMIN_USER_ID_PARAMS_SCHEMA,
        querystring: EMPTY_OBJECT_SCHEMA,
        response: {
          200: AUTH_ACTION_RESPONSE_SCHEMA,
          401: ERROR_RESPONSE_SCHEMA,
          403: ERROR_RESPONSE_SCHEMA,
          404: ERROR_RESPONSE_SCHEMA,
          409: ERROR_RESPONSE_SCHEMA,
          503: ERROR_RESPONSE_SCHEMA,
        },
      },
    },
    async (request, reply) => {
      const authenticated = await requireAdminSession(request, reply, true);
      if (authenticated === undefined) {
        return;
      }
      const payload = {
        ...(request.body.identityVerificationReference === undefined
          ? {}
          : {
              identityVerificationReference:
                request.body.identityVerificationReference,
            }),
      };
      try {
        await authenticated.runtime.confirmations.consume({
          action: "admin.user.delete",
          actorId: authenticated.session.userId,
          payload,
          sessionId: authenticated.session.id,
          targetId: request.params.userId,
          token: request.body.confirmationToken,
        });
        await authenticated.runtime.adminUsers.delete(request.params.userId);
        audit(
          {
            action: "admin.user_deleted",
            actorId: authenticated.session.userId,
            actorType: "user",
            metadata: payload,
            requestId: request.id,
            result: "success",
            subjectId: request.params.userId,
            subjectType: "user_tombstone",
            visibility: "admin",
          },
          request,
        );
        return { success: true as const };
      } catch (error: unknown) {
        const code =
          error instanceof Error ? error.message : "user_delete_failed";
        return reply
          .code(
            code === "confirmation_invalid"
              ? 403
              : code === "user_not_found"
                ? 404
                : code === "last_admin_protected"
                  ? 409
                  : 503,
          )
          .send(errorResponse(request, code, "用户删除失败"));
      }
    },
  );

  fastify.post(
    "/api/v1/auth/totp/enrollment",
    {
      onRequest: [
        requireInstalled,
        requireAuthConfiguration,
        requireOrigin,
        fastify.csrfProtection,
      ],
      preHandler: fastify.rateLimit({ max: 5, timeWindow: "10 minutes" }),
      schema: {
        body: EMPTY_OBJECT_SCHEMA,
        params: EMPTY_OBJECT_SCHEMA,
        querystring: EMPTY_OBJECT_SCHEMA,
        response: {
          200: TOTP_ENROLLMENT_BEGIN_RESPONSE_SCHEMA,
          401: ERROR_RESPONSE_SCHEMA,
          403: ERROR_RESPONSE_SCHEMA,
          404: ERROR_RESPONSE_SCHEMA,
          409: ERROR_RESPONSE_SCHEMA,
          503: ERROR_RESPONSE_SCHEMA,
        },
      },
    },
    async (request, reply) => {
      const authenticated = await requireSession(request, reply);
      if (authenticated === undefined) {
        return;
      }
      if (!hasRecentStrongAuthentication(authenticated.session)) {
        return reply
          .code(403)
          .send(
            errorResponse(
              request,
              "recent_authentication_required",
              "需要重新验证身份",
            ),
          );
      }
      try {
        const label = await authenticated.runtime.accounts.getTotpLabel(
          authenticated.session.userId,
        );
        return await authenticated.runtime.totpEnrollment.begin(
          authenticated.session.userId,
          label,
        );
      } catch (error: unknown) {
        if (
          error instanceof Error &&
          error.message === "totp_already_enabled"
        ) {
          return reply
            .code(409)
            .send(
              errorResponse(request, "totp_already_enabled", "TOTP 已启用"),
            );
        }
        return reply
          .code(503)
          .send(errorResponse(request, "totp_unavailable", "TOTP 暂不可用"));
      }
    },
  );

  fastify.post<{ Body: { code: string } }>(
    "/api/v1/auth/totp/enrollment/confirm",
    {
      onRequest: [
        requireInstalled,
        requireAuthConfiguration,
        requireOrigin,
        fastify.csrfProtection,
      ],
      preHandler: fastify.rateLimit({ max: 10, timeWindow: "10 minutes" }),
      schema: {
        body: TOTP_ENROLLMENT_CONFIRM_REQUEST_SCHEMA,
        params: EMPTY_OBJECT_SCHEMA,
        querystring: EMPTY_OBJECT_SCHEMA,
        response: {
          200: TOTP_ENROLLMENT_CONFIRM_RESPONSE_SCHEMA,
          400: ERROR_RESPONSE_SCHEMA,
          401: ERROR_RESPONSE_SCHEMA,
          403: ERROR_RESPONSE_SCHEMA,
          404: ERROR_RESPONSE_SCHEMA,
          503: ERROR_RESPONSE_SCHEMA,
        },
      },
    },
    async (request, reply) => {
      const authenticated = await requireSession(request, reply);
      if (authenticated === undefined) {
        return;
      }
      if (!hasRecentStrongAuthentication(authenticated.session)) {
        return reply
          .code(403)
          .send(
            errorResponse(
              request,
              "recent_authentication_required",
              "需要重新验证身份",
            ),
          );
      }
      try {
        const result = await authenticated.runtime.totpEnrollment.confirm(
          authenticated.session.userId,
          request.body.code,
        );
        audit(
          {
            action: "auth.totp_enabled",
            actorId: authenticated.session.userId,
            actorType: "user",
            ownerUserId: authenticated.session.userId,
            requestId: request.id,
            result: "success",
            subjectId: authenticated.session.userId,
            subjectType: "user",
            visibility: "owner",
          },
          request,
        );
        return result;
      } catch (error: unknown) {
        if (
          error instanceof Error &&
          error.message === "totp_enrollment_invalid"
        ) {
          return reply
            .code(400)
            .send(
              errorResponse(
                request,
                "totp_enrollment_invalid",
                "验证码无效或启用请求已过期",
              ),
            );
        }
        return reply
          .code(503)
          .send(errorResponse(request, "totp_unavailable", "TOTP 暂不可用"));
      }
    },
  );

  fastify.post(
    "/api/v1/auth/passkeys/authentication/options",
    {
      onRequest: [
        requireInstalled,
        requireAuthConfiguration,
        requireOrigin,
        fastify.csrfProtection,
      ],
      preHandler: fastify.rateLimit({ max: 10, timeWindow: "10 minutes" }),
      schema: {
        body: EMPTY_OBJECT_SCHEMA,
        params: EMPTY_OBJECT_SCHEMA,
        querystring: EMPTY_OBJECT_SCHEMA,
        response: {
          200: WEBAUTHN_OPTIONS_RESPONSE_SCHEMA,
          403: ERROR_RESPONSE_SCHEMA,
          404: ERROR_RESPONSE_SCHEMA,
          503: ERROR_RESPONSE_SCHEMA,
        },
      },
    },
    async (request, reply) => {
      try {
        const result = await getRuntime().passkeys.beginAuthentication();
        reply.setCookie(WEBAUTHN_COOKIE_NAME, result.token, {
          ...cookieOptions,
          maxAge: TEMPORARY_PASSWORD_COOKIE_MAX_AGE_SECONDS,
        });
        return { options: result.options };
      } catch {
        return reply
          .code(503)
          .send(
            errorResponse(request, "webauthn_unavailable", "Passkey 暂不可用"),
          );
      }
    },
  );

  fastify.post<{
    Body: { response: WebauthnAuthenticationResponse };
  }>(
    "/api/v1/auth/passkeys/authentication/verify",
    {
      onRequest: [
        requireInstalled,
        requireAuthConfiguration,
        requireOrigin,
        fastify.csrfProtection,
      ],
      preHandler: fastify.rateLimit({ max: 10, timeWindow: "10 minutes" }),
      schema: {
        body: PASSKEY_AUTHENTICATION_VERIFY_REQUEST_SCHEMA,
        params: EMPTY_OBJECT_SCHEMA,
        querystring: EMPTY_OBJECT_SCHEMA,
        response: {
          200: LOGIN_RESPONSE_SCHEMA,
          401: ERROR_RESPONSE_SCHEMA,
          403: ERROR_RESPONSE_SCHEMA,
          404: ERROR_RESPONSE_SCHEMA,
          503: ERROR_RESPONSE_SCHEMA,
        },
      },
    },
    async (request, reply) => {
      const token = request.cookies[WEBAUTHN_COOKIE_NAME];
      if (token === undefined) {
        return reply
          .code(401)
          .send(
            errorResponse(
              request,
              "passkey_authentication_invalid",
              "Passkey 登录请求已失效",
            ),
          );
      }
      try {
        const created = await getRuntime().passkeys.completeAuthentication(
          token,
          request.body.response as AuthenticationResponseJSON,
          await sessionMetadata.resolve(request),
        );
        reply.clearCookie(WEBAUTHN_COOKIE_NAME, cookieOptions);
        reply.setCookie(SESSION_COOKIE_NAME, created.token, {
          ...cookieOptions,
          maxAge: SESSION_COOKIE_MAX_AGE_SECONDS,
        });
        audit(
          {
            action: "auth.passkey_login",
            actorId: created.session.userId,
            actorType: "user",
            ownerUserId: created.session.userId,
            requestId: request.id,
            result: "success",
            subjectId: created.session.id,
            subjectType: "session",
            visibility: "owner",
          },
          request,
        );
        return {
          requiresPasswordChange: false,
          requiresTotp: false,
          role: created.session.role,
          session: toPublicSession(created.session, created.session.id),
        };
      } catch (error: unknown) {
        reply.clearCookie(WEBAUTHN_COOKIE_NAME, cookieOptions);
        if (isSessionCapacityError(error)) {
          return reply
            .code(503)
            .send(
              errorResponse(
                request,
                "browser_session_capacity_exceeded",
                "活跃浏览器会话已达到容量上限",
              ),
            );
        }
        return reply
          .code(401)
          .send(
            errorResponse(
              request,
              "passkey_authentication_invalid",
              "Passkey 验证失败",
            ),
          );
      }
    },
  );

  fastify.get(
    "/api/v1/auth/passkeys",
    {
      onRequest: [requireInstalled, requireAuthConfiguration],
      schema: {
        params: EMPTY_OBJECT_SCHEMA,
        querystring: EMPTY_OBJECT_SCHEMA,
        response: {
          200: PASSKEY_LIST_RESPONSE_SCHEMA,
          401: ERROR_RESPONSE_SCHEMA,
          404: ERROR_RESPONSE_SCHEMA,
          503: ERROR_RESPONSE_SCHEMA,
        },
      },
    },
    async (request, reply) => {
      const authenticated = await requireSession(request, reply);
      if (authenticated === undefined) {
        return;
      }
      return {
        passkeys: await authenticated.runtime.passkeys.list(
          authenticated.session.userId,
        ),
      };
    },
  );

  fastify.post(
    "/api/v1/auth/passkeys/registration/options",
    {
      onRequest: [
        requireInstalled,
        requireAuthConfiguration,
        requireOrigin,
        fastify.csrfProtection,
      ],
      preHandler: fastify.rateLimit({ max: 5, timeWindow: "10 minutes" }),
      schema: {
        body: EMPTY_OBJECT_SCHEMA,
        params: EMPTY_OBJECT_SCHEMA,
        querystring: EMPTY_OBJECT_SCHEMA,
        response: {
          200: WEBAUTHN_OPTIONS_RESPONSE_SCHEMA,
          401: ERROR_RESPONSE_SCHEMA,
          403: ERROR_RESPONSE_SCHEMA,
          404: ERROR_RESPONSE_SCHEMA,
          503: ERROR_RESPONSE_SCHEMA,
        },
      },
    },
    async (request, reply) => {
      const authenticated = await requireSession(request, reply);
      if (authenticated === undefined) {
        return;
      }
      if (!hasRecentStrongAuthentication(authenticated.session)) {
        return reply
          .code(403)
          .send(
            errorResponse(
              request,
              "recent_authentication_required",
              "需要重新验证身份",
            ),
          );
      }
      try {
        const result = await authenticated.runtime.passkeys.beginRegistration(
          authenticated.session.userId,
        );
        reply.setCookie(WEBAUTHN_COOKIE_NAME, result.token, {
          ...cookieOptions,
          maxAge: TEMPORARY_PASSWORD_COOKIE_MAX_AGE_SECONDS,
        });
        return { options: result.options };
      } catch {
        return reply
          .code(503)
          .send(
            errorResponse(request, "webauthn_unavailable", "Passkey 暂不可用"),
          );
      }
    },
  );

  fastify.post<{
    Body: { name: string; response: WebauthnRegistrationResponse };
  }>(
    "/api/v1/auth/passkeys/registration/verify",
    {
      onRequest: [
        requireInstalled,
        requireAuthConfiguration,
        requireOrigin,
        fastify.csrfProtection,
      ],
      preHandler: fastify.rateLimit({ max: 5, timeWindow: "10 minutes" }),
      schema: {
        body: PASSKEY_REGISTRATION_VERIFY_REQUEST_SCHEMA,
        params: EMPTY_OBJECT_SCHEMA,
        querystring: EMPTY_OBJECT_SCHEMA,
        response: {
          200: PASSKEY_SCHEMA,
          400: ERROR_RESPONSE_SCHEMA,
          401: ERROR_RESPONSE_SCHEMA,
          403: ERROR_RESPONSE_SCHEMA,
          404: ERROR_RESPONSE_SCHEMA,
          503: ERROR_RESPONSE_SCHEMA,
        },
      },
    },
    async (request, reply) => {
      const authenticated = await requireSession(request, reply);
      if (authenticated === undefined) {
        return;
      }
      if (!hasRecentStrongAuthentication(authenticated.session)) {
        return reply
          .code(403)
          .send(
            errorResponse(
              request,
              "recent_authentication_required",
              "需要重新验证身份",
            ),
          );
      }
      const token = request.cookies[WEBAUTHN_COOKIE_NAME];
      if (token === undefined) {
        return reply
          .code(400)
          .send(
            errorResponse(
              request,
              "passkey_registration_invalid",
              "Passkey 注册请求已失效",
            ),
          );
      }
      try {
        const passkey =
          await authenticated.runtime.passkeys.completeRegistration(
            token,
            authenticated.session.userId,
            request.body.name,
            request.body.response as RegistrationResponseJSON,
          );
        reply.clearCookie(WEBAUTHN_COOKIE_NAME, cookieOptions);
        audit(
          {
            action: "auth.passkey_registered",
            actorId: authenticated.session.userId,
            actorType: "user",
            ownerUserId: authenticated.session.userId,
            requestId: request.id,
            result: "success",
            subjectId: passkey.id,
            subjectType: "passkey",
            visibility: "owner",
          },
          request,
        );
        return passkey;
      } catch {
        reply.clearCookie(WEBAUTHN_COOKIE_NAME, cookieOptions);
        return reply
          .code(400)
          .send(
            errorResponse(
              request,
              "passkey_registration_invalid",
              "Passkey 注册验证失败",
            ),
          );
      }
    },
  );

  fastify.post<{ Body: LoginRequest }>(
    "/api/v1/auth/login",
    {
      onRequest: [
        requireInstalled,
        requireAuthConfiguration,
        requireOrigin,
        fastify.csrfProtection,
      ],
      preHandler: fastify.rateLimit({ max: 10, timeWindow: "1 minute" }),
      schema: {
        body: LOGIN_REQUEST_SCHEMA,
        params: EMPTY_OBJECT_SCHEMA,
        querystring: EMPTY_OBJECT_SCHEMA,
        response: {
          200: LOGIN_RESPONSE_SCHEMA,
          400: ERROR_RESPONSE_SCHEMA,
          401: ERROR_RESPONSE_SCHEMA,
          403: ERROR_RESPONSE_SCHEMA,
          404: ERROR_RESPONSE_SCHEMA,
          503: ERROR_RESPONSE_SCHEMA,
        },
      },
    },
    async (request, reply) => {
      try {
        const result = await getRuntime().passwordAuth.login(
          request.body,
          await sessionMetadata.resolve(request),
        );
        if (result.kind === "password_change_required") {
          const token =
            await getRuntime().accounts.beginTemporaryPasswordChange(
              result.userId,
              result.role,
            );
          reply.setCookie(TEMPORARY_PASSWORD_COOKIE_NAME, token, {
            ...cookieOptions,
            maxAge: TEMPORARY_PASSWORD_COOKIE_MAX_AGE_SECONDS,
          });
          return {
            requiresPasswordChange: true,
            requiresTotp: false,
            role: result.role,
          };
        }
        if (result.kind === "totp_required") {
          const token = await getRuntime().secondFactor.begin({
            metadata: await sessionMetadata.resolve(request),
            role: result.role,
            userId: result.userId,
          });
          reply.setCookie(SECOND_FACTOR_COOKIE_NAME, token, {
            ...cookieOptions,
            maxAge: TEMPORARY_PASSWORD_COOKIE_MAX_AGE_SECONDS,
          });
          return {
            requiresPasswordChange: false,
            requiresTotp: true,
            role: result.role,
          };
        }
        reply.setCookie(SESSION_COOKIE_NAME, result.token, {
          ...cookieOptions,
          maxAge: SESSION_COOKIE_MAX_AGE_SECONDS,
        });
        audit(
          {
            action: "auth.login",
            actorId: result.session.userId,
            actorType: "user",
            ownerUserId: result.session.userId,
            requestId: request.id,
            result: "success",
            subjectId: result.session.id,
            subjectType: "session",
            visibility: "owner",
          },
          request,
        );
        return {
          requiresPasswordChange: false,
          requiresTotp: false,
          role: result.role,
          session: toPublicSession(result.session, result.session.id),
        };
      } catch (error: unknown) {
        if (isSessionCapacityError(error)) {
          return reply
            .code(503)
            .send(
              errorResponse(
                request,
                "browser_session_capacity_exceeded",
                "活跃浏览器会话已达到容量上限",
              ),
            );
        }
        if (error instanceof Error && error.message === "credentials_invalid") {
          audit(
            {
              action: "auth.login",
              actorType: "system",
              errorCategory: "credentials_invalid",
              requestId: request.id,
              result: "failure",
              subjectId: "unknown",
              subjectType: "user",
              visibility: "system",
            },
            request,
          );
          return reply
            .code(401)
            .send(
              errorResponse(
                request,
                "credentials_invalid",
                "登录标识或密码无效",
              ),
            );
        }
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
    },
  );

  fastify.post<{ Body: TotpLoginRequest }>(
    "/api/v1/auth/totp/login",
    {
      onRequest: [
        requireInstalled,
        requireAuthConfiguration,
        requireOrigin,
        fastify.csrfProtection,
      ],
      preHandler: fastify.rateLimit({ max: 10, timeWindow: "10 minutes" }),
      schema: {
        body: TOTP_LOGIN_REQUEST_SCHEMA,
        params: EMPTY_OBJECT_SCHEMA,
        querystring: EMPTY_OBJECT_SCHEMA,
        response: {
          200: LOGIN_RESPONSE_SCHEMA,
          401: ERROR_RESPONSE_SCHEMA,
          403: ERROR_RESPONSE_SCHEMA,
          404: ERROR_RESPONSE_SCHEMA,
          503: ERROR_RESPONSE_SCHEMA,
        },
      },
    },
    async (request, reply) => {
      const token = request.cookies[SECOND_FACTOR_COOKIE_NAME];
      if (token === undefined) {
        return reply
          .code(401)
          .send(
            errorResponse(
              request,
              "second_factor_invalid",
              "二阶段登录请求已失效",
            ),
          );
      }
      try {
        const created = await getRuntime().secondFactor.complete(
          token,
          request.body,
        );
        reply.clearCookie(SECOND_FACTOR_COOKIE_NAME, cookieOptions);
        reply.setCookie(SESSION_COOKIE_NAME, created.token, {
          ...cookieOptions,
          maxAge: SESSION_COOKIE_MAX_AGE_SECONDS,
        });
        audit(
          {
            action:
              created.session.authStrength === "password_recovery"
                ? "auth.recovery_code_login"
                : "auth.totp_login",
            actorId: created.session.userId,
            actorType: "user",
            ownerUserId: created.session.userId,
            requestId: request.id,
            result: "success",
            subjectId: created.session.id,
            subjectType: "session",
            visibility: "owner",
          },
          request,
        );
        return {
          requiresPasswordChange: false,
          requiresTotp: false,
          role: created.session.role,
          session: toPublicSession(created.session, created.session.id),
        };
      } catch (error: unknown) {
        if (isSessionCapacityError(error)) {
          return reply
            .code(503)
            .send(
              errorResponse(
                request,
                "browser_session_capacity_exceeded",
                "活跃浏览器会话已达到容量上限",
              ),
            );
        }
        if (
          error instanceof Error &&
          error.message === "second_factor_invalid"
        ) {
          return reply
            .code(401)
            .send(
              errorResponse(
                request,
                "second_factor_invalid",
                "验证码或恢复码无效",
              ),
            );
        }
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
    },
  );

  fastify.post<{ Body: RegisterRequest }>(
    "/api/v1/auth/register",
    {
      onRequest: [
        requireInstalled,
        requireAuthConfiguration,
        requireOrigin,
        fastify.csrfProtection,
      ],
      preHandler: fastify.rateLimit({ max: 5, timeWindow: "10 minutes" }),
      schema: {
        body: REGISTER_REQUEST_SCHEMA,
        params: EMPTY_OBJECT_SCHEMA,
        querystring: EMPTY_OBJECT_SCHEMA,
        response: {
          200: REGISTER_RESPONSE_SCHEMA,
          400: ERROR_RESPONSE_SCHEMA,
          403: ERROR_RESPONSE_SCHEMA,
          404: ERROR_RESPONSE_SCHEMA,
          409: ERROR_RESPONSE_SCHEMA,
          503: ERROR_RESPONSE_SCHEMA,
        },
      },
    },
    async (request, reply) => {
      try {
        const userId = await getRuntime().accounts.register(request.body);
        audit(
          {
            action: "user.register",
            actorId: userId,
            actorType: "user",
            ownerUserId: userId,
            requestId: request.id,
            result: "success",
            subjectId: userId,
            subjectType: "user",
            visibility: "owner",
          },
          request,
        );
        return { userId };
      } catch (error: unknown) {
        const code =
          error instanceof Error ? error.message : "registration_failed";
        if (code === "registration_closed") {
          return reply
            .code(403)
            .send(errorResponse(request, code, "当前未开放注册"));
        }
        if (code === "identifier_conflict") {
          return reply
            .code(409)
            .send(errorResponse(request, code, "登录标识已被使用"));
        }
        if (
          code === "identifier_invalid" ||
          code === "password_length_invalid"
        ) {
          return reply
            .code(400)
            .send(errorResponse(request, code, "注册信息无效"));
        }
        return reply
          .code(503)
          .send(
            errorResponse(
              request,
              "registration_unavailable",
              "注册服务暂不可用",
            ),
          );
      }
    },
  );

  fastify.get(
    "/api/v1/auth/sessions",
    {
      onRequest: [requireInstalled, requireAuthConfiguration],
      schema: {
        params: EMPTY_OBJECT_SCHEMA,
        querystring: EMPTY_OBJECT_SCHEMA,
        response: {
          200: SESSION_LIST_RESPONSE_SCHEMA,
          401: ERROR_RESPONSE_SCHEMA,
          404: ERROR_RESPONSE_SCHEMA,
          503: ERROR_RESPONSE_SCHEMA,
        },
      },
    },
    async (request, reply) => {
      const authenticated = await requireSession(request, reply);
      if (authenticated === undefined) {
        return;
      }
      const sessions = await authenticated.runtime.sessions.list(
        authenticated.session.userId,
      );
      return {
        sessions: sessions
          .sort(
            (left, right) =>
              Date.parse(right.lastActiveAt) - Date.parse(left.lastActiveAt),
          )
          .map((session) => toPublicSession(session, authenticated.session.id)),
      };
    },
  );

  fastify.get(
    "/api/v1/admin/registration",
    {
      onRequest: [requireInstalled, requireAuthConfiguration],
      schema: {
        params: EMPTY_OBJECT_SCHEMA,
        querystring: EMPTY_OBJECT_SCHEMA,
        response: {
          200: REGISTRATION_MODE_RESPONSE_SCHEMA,
          401: ERROR_RESPONSE_SCHEMA,
          403: ERROR_RESPONSE_SCHEMA,
          404: ERROR_RESPONSE_SCHEMA,
          503: ERROR_RESPONSE_SCHEMA,
        },
      },
    },
    async (request, reply) => {
      const authenticated = await requireSession(request, reply);
      if (authenticated === undefined) {
        return;
      }
      if (authenticated.session.role !== "admin") {
        return reply
          .code(403)
          .send(
            errorResponse(request, "authorization_denied", "无权访问该资源"),
          );
      }
      try {
        return {
          mode: await authenticated.runtime.accounts.getRegistrationMode(),
        };
      } catch {
        return reply
          .code(503)
          .send(
            errorResponse(
              request,
              "registration_unavailable",
              "注册策略暂不可用",
            ),
          );
      }
    },
  );

  fastify.put<{
    Body: { confirmationToken: string; mode: "open" | "closed" };
  }>(
    "/api/v1/admin/registration",
    {
      onRequest: [
        requireInstalled,
        requireAuthConfiguration,
        requireOrigin,
        fastify.csrfProtection,
      ],
      preHandler: fastify.rateLimit({ max: 10, timeWindow: "10 minutes" }),
      schema: {
        body: UPDATE_REGISTRATION_MODE_REQUEST_SCHEMA,
        params: EMPTY_OBJECT_SCHEMA,
        querystring: EMPTY_OBJECT_SCHEMA,
        response: {
          200: REGISTRATION_MODE_RESPONSE_SCHEMA,
          401: ERROR_RESPONSE_SCHEMA,
          403: ERROR_RESPONSE_SCHEMA,
          404: ERROR_RESPONSE_SCHEMA,
          503: ERROR_RESPONSE_SCHEMA,
        },
      },
    },
    async (request, reply) => {
      const authenticated = await requireSession(request, reply);
      if (authenticated === undefined) {
        return;
      }
      if (
        authenticated.session.role !== "admin" ||
        !hasRecentStrongAuthentication(authenticated.session)
      ) {
        return reply
          .code(403)
          .send(
            errorResponse(request, "authorization_denied", "无权执行该操作"),
          );
      }
      try {
        await authenticated.runtime.confirmations.consume({
          action: "admin.registration.update",
          actorId: authenticated.session.userId,
          payload: { mode: request.body.mode },
          sessionId: authenticated.session.id,
          targetId: "registration",
          token: request.body.confirmationToken,
        });
        await authenticated.runtime.accounts.setRegistrationMode(
          authenticated.session.userId,
          request.body.mode,
        );
        audit(
          {
            action: "admin.registration_updated",
            actorId: authenticated.session.userId,
            actorType: "user",
            metadata: { mode: request.body.mode },
            requestId: request.id,
            result: "success",
            subjectId: "registration",
            subjectType: "system_setting",
            visibility: "admin",
          },
          request,
        );
        return { mode: request.body.mode };
      } catch (error: unknown) {
        if (
          error instanceof Error &&
          error.message === "confirmation_invalid"
        ) {
          return reply
            .code(403)
            .send(
              errorResponse(request, "confirmation_invalid", "操作确认已失效"),
            );
        }
        return reply
          .code(503)
          .send(
            errorResponse(
              request,
              "registration_unavailable",
              "注册策略暂不可用",
            ),
          );
      }
    },
  );

  fastify.post<{ Body: AdminCreateUserRequest }>(
    "/api/v1/admin/users",
    {
      onRequest: [
        requireInstalled,
        requireAuthConfiguration,
        requireOrigin,
        fastify.csrfProtection,
      ],
      preHandler: fastify.rateLimit({ max: 10, timeWindow: "10 minutes" }),
      schema: {
        body: ADMIN_CREATE_USER_REQUEST_SCHEMA,
        params: EMPTY_OBJECT_SCHEMA,
        querystring: EMPTY_OBJECT_SCHEMA,
        response: {
          200: ADMIN_CREATE_USER_RESPONSE_SCHEMA,
          400: ERROR_RESPONSE_SCHEMA,
          401: ERROR_RESPONSE_SCHEMA,
          403: ERROR_RESPONSE_SCHEMA,
          404: ERROR_RESPONSE_SCHEMA,
          409: ERROR_RESPONSE_SCHEMA,
          503: ERROR_RESPONSE_SCHEMA,
        },
      },
    },
    async (request, reply) => {
      const authenticated = await requireSession(request, reply);
      if (authenticated === undefined) {
        return;
      }
      if (authenticated.session.role !== "admin") {
        return reply
          .code(403)
          .send(
            errorResponse(request, "authorization_denied", "无权执行该操作"),
          );
      }
      try {
        const created =
          await authenticated.runtime.accounts.createTemporaryUser(
            request.body,
          );
        audit(
          {
            action: "admin.user_created",
            actorId: authenticated.session.userId,
            actorType: "user",
            ownerUserId: created.userId,
            requestId: request.id,
            result: "success",
            subjectId: created.userId,
            subjectType: "user",
            visibility: "admin",
          },
          request,
        );
        return created;
      } catch (error: unknown) {
        const code =
          error instanceof Error ? error.message : "user_create_failed";
        if (code === "identifier_conflict") {
          return reply
            .code(409)
            .send(errorResponse(request, code, "登录标识已被使用"));
        }
        if (code === "identifier_invalid") {
          return reply
            .code(400)
            .send(errorResponse(request, code, "登录标识无效"));
        }
        return reply
          .code(503)
          .send(
            errorResponse(
              request,
              "user_create_unavailable",
              "用户创建暂不可用",
            ),
          );
      }
    },
  );

  fastify.post(
    "/api/v1/auth/logout",
    {
      onRequest: [
        requireInstalled,
        requireAuthConfiguration,
        requireOrigin,
        fastify.csrfProtection,
      ],
      schema: {
        body: EMPTY_OBJECT_SCHEMA,
        params: EMPTY_OBJECT_SCHEMA,
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
      const authenticated = await requireSession(request, reply);
      if (authenticated === undefined) {
        return;
      }
      await authenticated.runtime.sessions.revoke(
        authenticated.token,
        authenticated.session.userId,
      );
      audit(
        {
          action: "auth.logout",
          actorId: authenticated.session.userId,
          actorType: "user",
          ownerUserId: authenticated.session.userId,
          requestId: request.id,
          result: "success",
          subjectId: authenticated.session.id,
          subjectType: "session",
          visibility: "owner",
        },
        request,
      );
      reply.clearCookie(SESSION_COOKIE_NAME, cookieOptions);
      return { success: true as const };
    },
  );

  fastify.post<{
    Body: { currentPassword: string; newPassword: string };
  }>(
    "/api/v1/auth/password",
    {
      onRequest: [
        requireInstalled,
        requireAuthConfiguration,
        requireOrigin,
        fastify.csrfProtection,
      ],
      preHandler: fastify.rateLimit({ max: 5, timeWindow: "10 minutes" }),
      schema: {
        body: CHANGE_PASSWORD_REQUEST_SCHEMA,
        params: EMPTY_OBJECT_SCHEMA,
        querystring: EMPTY_OBJECT_SCHEMA,
        response: {
          200: LOGIN_RESPONSE_SCHEMA,
          400: ERROR_RESPONSE_SCHEMA,
          401: ERROR_RESPONSE_SCHEMA,
          403: ERROR_RESPONSE_SCHEMA,
          404: ERROR_RESPONSE_SCHEMA,
          503: ERROR_RESPONSE_SCHEMA,
        },
      },
    },
    async (request, reply) => {
      const authenticated = await requireSession(request, reply);
      if (authenticated === undefined) {
        return;
      }
      try {
        const created = await authenticated.runtime.accounts.changePassword(
          authenticated.session.userId,
          request.body.currentPassword,
          request.body.newPassword,
          await sessionMetadata.resolve(request),
        );
        reply.setCookie(SESSION_COOKIE_NAME, created.token, {
          ...cookieOptions,
          maxAge: SESSION_COOKIE_MAX_AGE_SECONDS,
        });
        return {
          requiresPasswordChange: false,
          requiresTotp: false,
          role: authenticated.session.role,
          session: toPublicSession(created.session, created.session.id),
        };
      } catch (error: unknown) {
        const code =
          error instanceof Error ? error.message : "password_change_failed";
        if (isSessionCapacityError(error)) {
          return reply
            .code(503)
            .send(
              errorResponse(
                request,
                "browser_session_capacity_exceeded",
                "活跃浏览器会话已达到容量上限",
              ),
            );
        }
        if (code === "credentials_invalid") {
          return reply
            .code(401)
            .send(errorResponse(request, code, "当前密码无效"));
        }
        if (
          code === "password_unchanged" ||
          code === "password_length_invalid"
        ) {
          return reply
            .code(400)
            .send(errorResponse(request, code, "新密码无效"));
        }
        return reply
          .code(503)
          .send(
            errorResponse(
              request,
              "password_change_unavailable",
              "密码修改暂不可用",
            ),
          );
      }
    },
  );

  fastify.post<{ Body: { newPassword: string } }>(
    "/api/v1/auth/temporary-password",
    {
      onRequest: [
        requireInstalled,
        requireAuthConfiguration,
        requireOrigin,
        fastify.csrfProtection,
      ],
      preHandler: fastify.rateLimit({ max: 5, timeWindow: "10 minutes" }),
      schema: {
        body: COMPLETE_TEMPORARY_PASSWORD_REQUEST_SCHEMA,
        params: EMPTY_OBJECT_SCHEMA,
        querystring: EMPTY_OBJECT_SCHEMA,
        response: {
          200: LOGIN_RESPONSE_SCHEMA,
          400: ERROR_RESPONSE_SCHEMA,
          401: ERROR_RESPONSE_SCHEMA,
          403: ERROR_RESPONSE_SCHEMA,
          404: ERROR_RESPONSE_SCHEMA,
          503: ERROR_RESPONSE_SCHEMA,
        },
      },
    },
    async (request, reply) => {
      const token = request.cookies[TEMPORARY_PASSWORD_COOKIE_NAME];
      if (token === undefined) {
        return reply
          .code(401)
          .send(
            errorResponse(
              request,
              "temporary_password_invalid",
              "改密请求已失效",
            ),
          );
      }
      try {
        const created =
          await getRuntime().accounts.completeTemporaryPasswordChange(
            token,
            request.body.newPassword,
            await sessionMetadata.resolve(request),
          );
        reply.clearCookie(TEMPORARY_PASSWORD_COOKIE_NAME, cookieOptions);
        reply.setCookie(SESSION_COOKIE_NAME, created.token, {
          ...cookieOptions,
          maxAge: SESSION_COOKIE_MAX_AGE_SECONDS,
        });
        return {
          requiresPasswordChange: false,
          requiresTotp: false,
          role: created.session.role,
          session: toPublicSession(created.session, created.session.id),
        };
      } catch (error: unknown) {
        const code =
          error instanceof Error ? error.message : "temporary_password_invalid";
        reply.clearCookie(TEMPORARY_PASSWORD_COOKIE_NAME, cookieOptions);
        if (isSessionCapacityError(error)) {
          return reply
            .code(503)
            .send(
              errorResponse(
                request,
                "browser_session_capacity_exceeded",
                "活跃浏览器会话已达到容量上限",
              ),
            );
        }
        if (code === "password_length_invalid") {
          return reply
            .code(400)
            .send(errorResponse(request, code, "新密码无效"));
        }
        if (code === "temporary_password_invalid") {
          return reply
            .code(401)
            .send(errorResponse(request, code, "改密请求已失效"));
        }
        return reply
          .code(503)
          .send(
            errorResponse(
              request,
              "password_change_unavailable",
              "密码修改暂不可用",
            ),
          );
      }
    },
  );

  fastify.post(
    "/api/v1/auth/sessions/revoke-others",
    {
      onRequest: [
        requireInstalled,
        requireAuthConfiguration,
        requireOrigin,
        fastify.csrfProtection,
      ],
      schema: {
        body: EMPTY_OBJECT_SCHEMA,
        params: EMPTY_OBJECT_SCHEMA,
        querystring: EMPTY_OBJECT_SCHEMA,
        response: {
          200: REVOKE_OTHERS_RESPONSE_SCHEMA,
          401: ERROR_RESPONSE_SCHEMA,
          403: ERROR_RESPONSE_SCHEMA,
          404: ERROR_RESPONSE_SCHEMA,
          503: ERROR_RESPONSE_SCHEMA,
        },
      },
    },
    async (request, reply) => {
      const authenticated = await requireSession(request, reply);
      if (authenticated === undefined) {
        return;
      }
      const revokedCount = await authenticated.runtime.sessions.revokeOthers(
        authenticated.session.userId,
        authenticated.session.id,
      );
      audit(
        {
          action: "session.revoke_others",
          actorId: authenticated.session.userId,
          actorType: "user",
          metadata: { revokedCount },
          ownerUserId: authenticated.session.userId,
          requestId: request.id,
          result: "success",
          subjectId: authenticated.session.id,
          subjectType: "session",
          visibility: "owner",
        },
        request,
      );
      return { revokedCount };
    },
  );

  fastify.delete<{ Params: SessionIdParams }>(
    "/api/v1/auth/sessions/:sessionId",
    {
      onRequest: [
        requireInstalled,
        requireAuthConfiguration,
        requireOrigin,
        fastify.csrfProtection,
      ],
      schema: {
        params: SESSION_ID_PARAMS_SCHEMA,
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
      const authenticated = await requireSession(request, reply);
      if (authenticated === undefined) {
        return;
      }
      const revoked = await authenticated.runtime.sessions.revokeById(
        authenticated.session.userId,
        request.params.sessionId,
      );
      if (!revoked) {
        return reply
          .code(404)
          .send(errorResponse(request, "session_not_found", "会话不存在"));
      }
      if (request.params.sessionId === authenticated.session.id) {
        reply.clearCookie(SESSION_COOKIE_NAME, cookieOptions);
      }
      return { success: true as const };
    },
  );
};
