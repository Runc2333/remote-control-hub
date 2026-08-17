import { randomBytes, randomUUID } from "node:crypto";
import { and, eq, isNull, lt, or } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import { Redis } from "ioredis";
import {
  createConnection,
  type ResultSetHeader,
  type RowDataPacket,
} from "mysql2/promise";
import type { IdentifierType } from "@remote-control-hub/contracts";
import type { ServerConfig } from "../config.js";
import type { DeviceConnectionRegistry } from "../devices/device-service.js";
import {
  recoveryCodes,
  systemSettings,
  totpAuthenticators,
  users,
} from "../db/schema.js";
import { AccountService, type AccountRepository } from "./account-service.js";
import { AdminUserService } from "./admin-user-service.js";
import {
  ActionConfirmationManager,
  RedisActionConfirmationRepository,
} from "./action-confirmation.js";
import { MySqlWebauthnRepository } from "./mysql-webauthn-repository.js";
import {
  PasswordAuthService,
  type LoginUser,
  type LoginUserRepository,
} from "./auth-service.js";
import { RedisSessionRepository, SessionManager } from "./session-store.js";
import { RedisSecondFactorChallengeRepository } from "./redis-second-factor.js";
import { RedisTotpEnrollmentChallengeRepository } from "./redis-totp-enrollment.js";
import {
  SecondFactorService,
  type SecondFactorCredentialRepository,
} from "./second-factor.js";
import {
  TotpEnrollmentService,
  type TotpEnrollmentCredentialRepository,
} from "./totp-enrollment.js";
import {
  RedisTemporaryPasswordRepository,
  TemporaryPasswordManager,
} from "./temporary-password.js";
import { TotpKeyring } from "./totp.js";
import {
  RedisWebauthnChallengeRepository,
  WebauthnChallengeManager,
} from "./webauthn-challenge.js";
import { WebauthnService } from "./webauthn-service.js";

const DUMMY_PASSWORD_HASH =
  "$argon2id$v=19$m=65536,p=1,t=3$rws0Ro7syC9wRxH01Yk39Q$zyi/yboNuBaJ7oDTDzZgSr3NwVQ/T7WxLk9KyLrKVic";
const SESSION_IDLE_TTL_MILLISECONDS = 24 * 60 * 60 * 1_000;
const SESSION_ABSOLUTE_TTL_MILLISECONDS = 30 * 24 * 60 * 60 * 1_000;
const SESSION_ACTIVITY_INTERVAL_MILLISECONDS = 5 * 60 * 1_000;
const SECOND_FACTOR_TTL_SECONDS = 5 * 60;
const SECOND_FACTOR_ATTEMPTS = 5;

export type AuthRuntime = {
  adminUsers: Pick<
    AdminUserService,
    | "delete"
    | "list"
    | "resetEnhancedAuthentication"
    | "resetPassword"
    | "update"
  >;
  accounts: Pick<
    AccountService,
    | "beginTemporaryPasswordChange"
    | "changePassword"
    | "completeTemporaryPasswordChange"
    | "createTemporaryUser"
    | "getRegistrationMode"
    | "getTotpLabel"
    | "register"
    | "setRegistrationMode"
    | "verifyCurrentPassword"
  >;
  close: () => void;
  confirmations: Pick<ActionConfirmationManager, "consume" | "issue">;
  passwordAuth: Pick<PasswordAuthService, "login">;
  passkeys: Pick<
    WebauthnService,
    | "beginAuthentication"
    | "beginRegistration"
    | "beginStepUp"
    | "completeAuthentication"
    | "completeRegistration"
    | "completeStepUp"
    | "delete"
    | "list"
    | "rename"
  >;
  secondFactor: Pick<SecondFactorService, "begin" | "complete" | "verifyTotp">;
  sessions: Pick<
    SessionManager,
    | "authenticate"
    | "list"
    | "markStrongAuthenticated"
    | "revoke"
    | "revokeAll"
    | "revokeByAuthenticator"
    | "revokeById"
    | "revokeOthers"
  >;
  totpEnrollment: Pick<
    TotpEnrollmentService,
    "begin" | "confirm" | "disable" | "getStatus" | "regenerateRecoveryCodes"
  >;
};

const createSecondFactorCredentialRepository = (
  config: ServerConfig,
): SecondFactorCredentialRepository => ({
  consumeRecoveryCode: async (userId, codeDigest, usedAt) => {
    const connection = await createConnection(mysqlOptions(config));
    try {
      const [result] = await drizzle(connection)
        .update(recoveryCodes)
        .set({ usedAt: mysqlDateTime(usedAt) })
        .where(
          and(
            eq(recoveryCodes.userId, userId),
            eq(recoveryCodes.codeHash, Buffer.from(codeDigest)),
            eq(recoveryCodes.revoked, false),
            isNull(recoveryCodes.usedAt),
          ),
        );
      return result.affectedRows === 1;
    } finally {
      await connection.end();
    }
  },
  findTotp: async (userId) => {
    const connection = await createConnection(mysqlOptions(config));
    try {
      const result = await drizzle(connection)
        .select({
          algorithm: totpAuthenticators.algorithm,
          ciphertext: totpAuthenticators.ciphertext,
          id: totpAuthenticators.id,
          keyVersion: totpAuthenticators.keyVersion,
          label: users.displayIdentifier,
          lastSuccessfulCounter: totpAuthenticators.lastSuccessfulCounter,
          nonce: totpAuthenticators.nonce,
        })
        .from(totpAuthenticators)
        .innerJoin(users, eq(users.id, totpAuthenticators.userId))
        .where(
          and(
            eq(totpAuthenticators.userId, userId),
            eq(totpAuthenticators.enabled, true),
          ),
        )
        .limit(1);
      const authenticator = result[0];
      if (
        authenticator === undefined ||
        authenticator.algorithm !== "aes-256-gcm"
      ) {
        return undefined;
      }
      return {
        envelope: {
          algorithm: "aes-256-gcm" as const,
          ciphertext: authenticator.ciphertext,
          keyVersion: authenticator.keyVersion,
          nonce: authenticator.nonce,
        },
        id: authenticator.id,
        label: authenticator.label,
        ...(authenticator.lastSuccessfulCounter === null
          ? {}
          : { lastSuccessfulCounter: authenticator.lastSuccessfulCounter }),
      };
    } finally {
      await connection.end();
    }
  },
  recordTotpCounter: async (authenticatorId, counter, usedAt) => {
    const connection = await createConnection(mysqlOptions(config));
    try {
      const [result] = await drizzle(connection)
        .update(totpAuthenticators)
        .set({
          lastSuccessfulCounter: counter,
          lastUsedAt: mysqlDateTime(usedAt),
        })
        .where(
          and(
            eq(totpAuthenticators.id, authenticatorId),
            eq(totpAuthenticators.enabled, true),
            or(
              isNull(totpAuthenticators.lastSuccessfulCounter),
              lt(totpAuthenticators.lastSuccessfulCounter, counter),
            ),
          ),
        );
      return result.affectedRows === 1;
    } finally {
      await connection.end();
    }
  },
});

type EnabledTotpRow = RowDataPacket & {
  enabled: number;
};

type TotpStatusRow = RowDataPacket & {
  enabled: number;
  lastUsedAt: Date | null;
};

type RecoveryCountRow = RowDataPacket & {
  count: number;
};

const createTotpEnrollmentCredentialRepository = (
  config: ServerConfig,
): TotpEnrollmentCredentialRepository => ({
  disable: async (userId) => {
    const connection = await createConnection(mysqlOptions(config));
    try {
      await connection.beginTransaction();
      const [existing] = await connection.execute<EnabledTotpRow[]>(
        "SELECT enabled FROM totp_authenticators WHERE user_id = ? FOR UPDATE",
        [userId],
      );
      if (existing[0]?.enabled !== 1) {
        await connection.rollback();
        return false;
      }
      await connection.execute<ResultSetHeader>(
        "DELETE FROM totp_authenticators WHERE user_id = ?",
        [userId],
      );
      await connection.execute<ResultSetHeader>(
        "UPDATE recovery_codes SET revoked = TRUE WHERE user_id = ? AND revoked = FALSE",
        [userId],
      );
      await connection.commit();
      return true;
    } catch (error: unknown) {
      await connection.rollback();
      throw error;
    } finally {
      await connection.end();
    }
  },
  enable: async (input) => {
    const connection = await createConnection(mysqlOptions(config));
    try {
      await connection.beginTransaction();
      const [usersFound] = await connection.execute<RowDataPacket[]>(
        "SELECT id FROM users WHERE id = ? AND status = 'active' FOR UPDATE",
        [input.userId],
      );
      if (usersFound.length !== 1) {
        throw new Error("user_not_found");
      }
      const [existing] = await connection.execute<EnabledTotpRow[]>(
        "SELECT enabled FROM totp_authenticators WHERE user_id = ? FOR UPDATE",
        [input.userId],
      );
      if (existing[0]?.enabled === 1) {
        throw new Error("totp_already_enabled");
      }
      await connection.execute<ResultSetHeader>(
        "DELETE FROM totp_authenticators WHERE user_id = ?",
        [input.userId],
      );
      const timestamp = mysqlDateTime(input.createdAt);
      await connection.execute<ResultSetHeader>(
        "INSERT INTO totp_authenticators (id, user_id, algorithm, key_version, nonce, ciphertext, enabled, last_successful_counter, created_at, confirmed_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?, TRUE, NULL, ?, ?, NULL)",
        [
          input.authenticatorId,
          input.userId,
          input.envelope.algorithm,
          input.envelope.keyVersion,
          Buffer.from(input.envelope.nonce),
          Buffer.from(input.envelope.ciphertext),
          timestamp,
          timestamp,
        ],
      );
      await connection.execute<ResultSetHeader>(
        "UPDATE recovery_codes SET revoked = TRUE WHERE user_id = ? AND revoked = FALSE",
        [input.userId],
      );
      for (const digest of input.recoveryCodeDigests) {
        await connection.execute<ResultSetHeader>(
          "INSERT INTO recovery_codes (id, user_id, code_hash, created_at, used_at, revoked) VALUES (?, ?, ?, ?, NULL, FALSE)",
          [randomUUID(), input.userId, Buffer.from(digest), timestamp],
        );
      }
      await connection.commit();
    } catch (error: unknown) {
      await connection.rollback();
      throw error;
    } finally {
      await connection.end();
    }
  },
  getStatus: async (userId) => {
    const connection = await createConnection(mysqlOptions(config));
    try {
      const [authenticators] = await connection.execute<TotpStatusRow[]>(
        "SELECT enabled, last_used_at AS lastUsedAt FROM totp_authenticators WHERE user_id = ? LIMIT 1",
        [userId],
      );
      const [counts] = await connection.execute<RecoveryCountRow[]>(
        "SELECT COUNT(*) AS count FROM recovery_codes WHERE user_id = ? AND revoked = FALSE AND used_at IS NULL",
        [userId],
      );
      const authenticator = authenticators[0];
      return {
        enabled: authenticator?.enabled === 1,
        ...(authenticator?.lastUsedAt === null ||
        authenticator?.lastUsedAt === undefined
          ? {}
          : { lastUsedAt: authenticator.lastUsedAt.toISOString() }),
        remainingRecoveryCodes: Number(counts[0]?.count ?? 0),
      };
    } finally {
      await connection.end();
    }
  },
  replaceRecoveryCodes: async (input) => {
    const connection = await createConnection(mysqlOptions(config));
    try {
      await connection.beginTransaction();
      const [existing] = await connection.execute<EnabledTotpRow[]>(
        "SELECT enabled FROM totp_authenticators WHERE user_id = ? FOR UPDATE",
        [input.userId],
      );
      if (existing[0]?.enabled !== 1) {
        await connection.rollback();
        return false;
      }
      await connection.execute<ResultSetHeader>(
        "UPDATE recovery_codes SET revoked = TRUE WHERE user_id = ? AND revoked = FALSE",
        [input.userId],
      );
      const createdAt = mysqlDateTime(input.createdAt);
      for (const digest of input.recoveryCodeDigests) {
        await connection.execute<ResultSetHeader>(
          "INSERT INTO recovery_codes (id, user_id, code_hash, created_at, used_at, revoked) VALUES (?, ?, ?, ?, NULL, FALSE)",
          [randomUUID(), input.userId, Buffer.from(digest), createdAt],
        );
      }
      await connection.commit();
      return true;
    } catch (error: unknown) {
      await connection.rollback();
      throw error;
    } finally {
      await connection.end();
    }
  },
});

const mysqlDateTime = (date: Date): string =>
  date.toISOString().replace("T", " ").replace("Z", "");

const mysqlOptions = (config: ServerConfig) => {
  const mysql = config.mysqlConnection;
  if (mysql === undefined) {
    throw new Error("mysql_unavailable");
  }
  return {
    database: mysql.database,
    host: mysql.host,
    password: mysql.password,
    port: mysql.port,
    user: mysql.username,
    ...(mysql.tls ? { ssl: {} } : {}),
  };
};

const isDuplicateEntry = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  error.code === "ER_DUP_ENTRY";

const createAccountRepository = (config: ServerConfig): AccountRepository => ({
  createUser: async (user) => {
    const connection = await createConnection(mysqlOptions(config));
    const userId = randomUUID();
    const now = mysqlDateTime(new Date());
    try {
      await drizzle(connection)
        .insert(users)
        .values({
          createdAt: now,
          displayIdentifier: user.displayIdentifier,
          id: userId,
          identifierType: user.identifierType,
          mustChangePassword: user.mustChangePassword,
          normalizedIdentifier: user.normalizedIdentifier,
          passwordHash: user.passwordHash,
          role: "user",
          status: "active",
          ...(user.temporaryPasswordExpiresAt === undefined
            ? {}
            : {
                temporaryPasswordExpiresAt: mysqlDateTime(
                  new Date(user.temporaryPasswordExpiresAt),
                ),
              }),
          updatedAt: now,
          webauthnUserHandle: randomBytes(32),
        });
      return userId;
    } catch (error: unknown) {
      if (isDuplicateEntry(error)) {
        throw new Error("identifier_conflict", { cause: error });
      }
      throw error;
    } finally {
      await connection.end();
    }
  },
  findById: async (userId) => {
    const connection = await createConnection(mysqlOptions(config));
    try {
      const result = await drizzle(connection)
        .select({
          displayIdentifier: users.displayIdentifier,
          id: users.id,
          passwordHash: users.passwordHash,
          role: users.role,
          status: users.status,
        })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);
      return result[0];
    } finally {
      await connection.end();
    }
  },
  getRegistrationMode: async () => {
    const connection = await createConnection(mysqlOptions(config));
    try {
      const result = await drizzle(connection)
        .select({ value: systemSettings.value })
        .from(systemSettings)
        .where(eq(systemSettings.key, "registration_mode"))
        .limit(1);
      const value = result[0]?.value;
      if (value !== "open" && value !== "closed") {
        throw new Error("registration_mode_invalid");
      }
      return value;
    } finally {
      await connection.end();
    }
  },
  invalidateTemporaryPassword: async (userId) => {
    const connection = await createConnection(mysqlOptions(config));
    try {
      const [result] = await drizzle(connection)
        .update(users)
        .set({
          mustChangePassword: false,
          passwordHash: DUMMY_PASSWORD_HASH,
          temporaryPasswordExpiresAt: null,
          updatedAt: mysqlDateTime(new Date()),
        })
        .where(and(eq(users.id, userId), eq(users.mustChangePassword, true)));
      return result.affectedRows === 1;
    } finally {
      await connection.end();
    }
  },
  setRegistrationMode: async (actorUserId, mode) => {
    const connection = await createConnection(mysqlOptions(config));
    try {
      const [result] = await drizzle(connection)
        .update(systemSettings)
        .set({
          updatedAt: mysqlDateTime(new Date()),
          updatedByUserId: actorUserId,
          value: mode,
        })
        .where(eq(systemSettings.key, "registration_mode"));
      if (result.affectedRows !== 1) {
        throw new Error("registration_mode_invalid");
      }
    } finally {
      await connection.end();
    }
  },
  updatePassword: async (userId, passwordHash) => {
    const connection = await createConnection(mysqlOptions(config));
    try {
      await drizzle(connection)
        .update(users)
        .set({
          mustChangePassword: false,
          passwordHash,
          temporaryPasswordExpiresAt: null,
          updatedAt: mysqlDateTime(new Date()),
        })
        .where(eq(users.id, userId));
    } finally {
      await connection.end();
    }
  },
});

const createUserRepository = (config: ServerConfig): LoginUserRepository => ({
  findByIdentifier: async (
    identifierType: IdentifierType,
    normalizedIdentifier: string,
  ): Promise<LoginUser | undefined> => {
    const connection = await createConnection(mysqlOptions(config));
    try {
      const database = drizzle(connection);
      const result = await database
        .select({
          id: users.id,
          mustChangePassword: users.mustChangePassword,
          passwordHash: users.passwordHash,
          role: users.role,
          status: users.status,
          temporaryPasswordExpiresAt: users.temporaryPasswordExpiresAt,
          totpEnabled: totpAuthenticators.enabled,
        })
        .from(users)
        .leftJoin(totpAuthenticators, eq(totpAuthenticators.userId, users.id))
        .where(
          and(
            eq(users.identifierType, identifierType),
            eq(users.normalizedIdentifier, normalizedIdentifier),
          ),
        )
        .limit(1);
      const user = result[0];
      if (user === undefined) {
        return undefined;
      }
      return {
        id: user.id,
        mustChangePassword: user.mustChangePassword,
        passwordHash: user.passwordHash,
        role: user.role,
        status: user.status,
        totpEnabled: user.totpEnabled === true,
        ...(user.temporaryPasswordExpiresAt === null
          ? {}
          : { temporaryPasswordExpiresAt: user.temporaryPasswordExpiresAt }),
      };
    } finally {
      await connection.end();
    }
  },
});

export const createAuthRuntime = (
  config: ServerConfig,
  deviceConnections?: DeviceConnectionRegistry,
): AuthRuntime => {
  const redisConfig = config.redisConnection;
  if (redisConfig === undefined) {
    throw new Error("redis_unavailable");
  }
  const redis = new Redis({
    db: redisConfig.database,
    host: redisConfig.host,
    password: redisConfig.password,
    port: redisConfig.port,
    tls: redisConfig.tls ? {} : undefined,
    username: redisConfig.username,
  });
  const sessions = new SessionManager(new RedisSessionRepository(redis), {
    absoluteTtlMilliseconds: SESSION_ABSOLUTE_TTL_MILLISECONDS,
    activityWriteIntervalMilliseconds: SESSION_ACTIVITY_INTERVAL_MILLISECONDS,
    idleTtlMilliseconds: SESSION_IDLE_TTL_MILLISECONDS,
  });
  const temporaryPasswords = new TemporaryPasswordManager(
    new RedisTemporaryPasswordRepository(redis),
  );
  const keyring =
    config.totpKeyring === undefined
      ? undefined
      : new TotpKeyring(
          config.totpKeyring.keys,
          config.totpKeyring.currentVersion,
        );
  const secondFactor = new SecondFactorService(
    new RedisSecondFactorChallengeRepository(redis),
    createSecondFactorCredentialRepository(config),
    sessions,
    keyring,
    {
      attempts: SECOND_FACTOR_ATTEMPTS,
      ttlSeconds: SECOND_FACTOR_TTL_SECONDS,
    },
  );
  const totpEnrollment = new TotpEnrollmentService(
    new RedisTotpEnrollmentChallengeRepository(redis),
    createTotpEnrollmentCredentialRepository(config),
    keyring,
    {
      attempts: SECOND_FACTOR_ATTEMPTS,
      ttlSeconds: SECOND_FACTOR_TTL_SECONDS,
    },
  );
  const passkeys = new WebauthnService(
    new MySqlWebauthnRepository(config),
    new WebauthnChallengeManager(
      new RedisWebauthnChallengeRepository(redis),
      SECOND_FACTOR_TTL_SECONDS,
    ),
    sessions,
    config.webauthn,
  );
  const confirmations = new ActionConfirmationManager(
    new RedisActionConfirmationRepository(redis),
    SECOND_FACTOR_TTL_SECONDS,
  );
  const adminUsers = new AdminUserService(
    config,
    sessions,
    undefined,
    (deviceId) => {
      deviceConnections?.forceDisconnect(deviceId, "owner_deleted");
    },
  );
  return {
    adminUsers,
    accounts: new AccountService(
      createAccountRepository(config),
      sessions,
      temporaryPasswords,
    ),
    close: () => redis.disconnect(false),
    confirmations,
    passwordAuth: new PasswordAuthService(
      createUserRepository(config),
      sessions,
      DUMMY_PASSWORD_HASH,
    ),
    passkeys,
    secondFactor,
    sessions,
    totpEnrollment,
  };
};
