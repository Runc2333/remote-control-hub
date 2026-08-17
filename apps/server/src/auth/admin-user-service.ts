import { randomBytes, randomUUID } from "node:crypto";
import {
  createConnection,
  type ResultSetHeader,
  type RowDataPacket,
} from "mysql2/promise";
import type { IdentifierType, UserRole } from "@remote-control-hub/contracts";
import type { ServerConfig } from "../config.js";
import { normalizeIdentifier } from "./identifiers.js";
import { hashPassword } from "./password.js";
import type { SessionManager } from "./session-store.js";

export type AdminUserSummary = {
  createdAt: string;
  displayIdentifier: string;
  id: string;
  identifierType: IdentifierType;
  mustChangePassword: boolean;
  role: UserRole;
  status: "active" | "disabled" | "deleted";
};

export type AdminUserUpdate = {
  identifier?: string;
  identifierType?: IdentifierType;
  role?: UserRole;
  status?: "active" | "disabled";
};

type UserRow = RowDataPacket & {
  createdAt: Date | string;
  displayIdentifier: string;
  id: string;
  identifierType: IdentifierType;
  mustChangePassword: number;
  role: UserRole;
  status: "active" | "disabled" | "deleted";
};

type IdRow = RowDataPacket & { id: string };

const connectionOptions = (config: ServerConfig) => {
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

const mysqlDateTime = (date: Date): string =>
  date.toISOString().replace("T", " ").replace("Z", "");

const toSummary = (row: UserRow): AdminUserSummary => ({
  createdAt: (row.createdAt instanceof Date
    ? row.createdAt
    : new Date(row.createdAt)
  ).toISOString(),
  displayIdentifier: row.displayIdentifier,
  id: row.id,
  identifierType: row.identifierType,
  mustChangePassword: row.mustChangePassword === 1,
  role: row.role,
  status: row.status,
});

export class AdminUserService {
  readonly #config: ServerConfig;
  readonly #disconnectDevice: (deviceId: string) => void;
  readonly #now: () => Date;
  readonly #sessions: Pick<SessionManager, "revokeAll">;

  public constructor(
    config: ServerConfig,
    sessions: Pick<SessionManager, "revokeAll">,
    now: () => Date = () => new Date(),
    disconnectDevice: (deviceId: string) => void = () => undefined,
  ) {
    this.#config = config;
    this.#disconnectDevice = disconnectDevice;
    this.#sessions = sessions;
    this.#now = now;
  }

  public async list(): Promise<AdminUserSummary[]> {
    const connection = await createConnection(connectionOptions(this.#config));
    try {
      const [rows] = await connection.execute<UserRow[]>(
        "SELECT id, identifier_type AS identifierType, display_identifier AS displayIdentifier, role, status, must_change_password AS mustChangePassword, created_at AS createdAt FROM users ORDER BY created_at DESC LIMIT 1000",
      );
      return rows.map(toSummary);
    } finally {
      await connection.end();
    }
  }

  public async update(
    targetUserId: string,
    update: AdminUserUpdate,
  ): Promise<AdminUserSummary> {
    if (
      (update.identifier === undefined) !==
      (update.identifierType === undefined)
    ) {
      throw new Error("identifier_invalid");
    }
    if (
      update.identifier === undefined &&
      update.role === undefined &&
      update.status === undefined
    ) {
      throw new Error("user_update_empty");
    }
    const connection = await createConnection(connectionOptions(this.#config));
    try {
      await connection.beginTransaction();
      const target = await this.#lockTarget(connection, targetUserId);
      await this.#assertAdminInvariant(connection, target, update);
      const assignments: string[] = ["updated_at = ?"];
      const values: (number | string)[] = [mysqlDateTime(this.#now())];
      if (
        update.identifier !== undefined &&
        update.identifierType !== undefined
      ) {
        const normalized = normalizeIdentifier(
          update.identifierType,
          update.identifier,
        );
        assignments.push(
          "identifier_type = ?",
          "normalized_identifier = ?",
          "display_identifier = ?",
        );
        values.push(update.identifierType, normalized, normalized);
      }
      if (update.role !== undefined) {
        assignments.push("role = ?");
        values.push(update.role);
      }
      if (update.status !== undefined) {
        assignments.push("status = ?");
        values.push(update.status);
      }
      values.push(targetUserId);
      await connection.execute<ResultSetHeader>(
        `UPDATE users SET ${assignments.join(", ")} WHERE id = ? AND status <> 'deleted'`,
        values,
      );
      const updated = await this.#lockTarget(connection, targetUserId);
      if (
        (update.role !== undefined && update.role !== target.role) ||
        (update.status !== undefined && update.status !== target.status)
      ) {
        await this.#sessions.revokeAll(targetUserId);
      }
      await connection.commit();
      return toSummary(updated);
    } catch (error: unknown) {
      await connection.rollback();
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ER_DUP_ENTRY"
      ) {
        throw new Error("identifier_conflict", { cause: error });
      }
      throw error;
    } finally {
      await connection.end();
    }
  }

  public async resetPassword(targetUserId: string): Promise<{
    temporaryPassword: string;
    temporaryPasswordExpiresAt: string;
  }> {
    const temporaryPassword = randomBytes(24).toString("base64url");
    const temporaryPasswordExpiresAt = new Date(
      this.#now().getTime() + 24 * 60 * 60 * 1_000,
    );
    const passwordHash = await hashPassword(temporaryPassword);
    const connection = await createConnection(connectionOptions(this.#config));
    try {
      await connection.beginTransaction();
      await this.#lockTarget(connection, targetUserId);
      const [result] = await connection.execute<ResultSetHeader>(
        "UPDATE users SET password_hash = ?, must_change_password = TRUE, temporary_password_expires_at = ?, updated_at = ? WHERE id = ? AND status = 'active'",
        [
          passwordHash,
          mysqlDateTime(temporaryPasswordExpiresAt),
          mysqlDateTime(this.#now()),
          targetUserId,
        ],
      );
      if (result.affectedRows !== 1) {
        throw new Error("user_not_found");
      }
      await this.#sessions.revokeAll(targetUserId);
      await connection.commit();
      return {
        temporaryPassword,
        temporaryPasswordExpiresAt: temporaryPasswordExpiresAt.toISOString(),
      };
    } catch (error: unknown) {
      await connection.rollback();
      throw error;
    } finally {
      await connection.end();
    }
  }

  public async resetEnhancedAuthentication(
    targetUserId: string,
  ): Promise<void> {
    const connection = await createConnection(connectionOptions(this.#config));
    try {
      await connection.beginTransaction();
      await this.#lockTarget(connection, targetUserId);
      await connection.execute<ResultSetHeader>(
        "DELETE FROM webauthn_credentials WHERE user_id = ?",
        [targetUserId],
      );
      await connection.execute<ResultSetHeader>(
        "DELETE FROM totp_authenticators WHERE user_id = ?",
        [targetUserId],
      );
      await connection.execute<ResultSetHeader>(
        "UPDATE recovery_codes SET revoked = TRUE WHERE user_id = ? AND revoked = FALSE",
        [targetUserId],
      );
      await this.#sessions.revokeAll(targetUserId);
      await connection.commit();
    } catch (error: unknown) {
      await connection.rollback();
      throw error;
    } finally {
      await connection.end();
    }
  }

  public async delete(targetUserId: string): Promise<void> {
    const now = this.#now();
    const replacementPasswordHash = await hashPassword(
      randomBytes(32).toString("base64url"),
    );
    const connection = await createConnection(connectionOptions(this.#config));
    let deviceIds: string[];
    try {
      await connection.beginTransaction();
      const target = await this.#lockTarget(connection, targetUserId);
      await this.#assertAdminInvariant(connection, target, {
        status: "disabled",
      });
      const [ownedDevices] = await connection.execute<IdRow[]>(
        "SELECT id FROM devices WHERE owner_user_id = ? AND deleted_at IS NULL FOR UPDATE",
        [targetUserId],
      );
      deviceIds = ownedDevices.map((device) => device.id);
      await connection.execute<ResultSetHeader>(
        "UPDATE devices SET disabled_at = COALESCE(disabled_at, ?), credential_revoked_at = COALESCE(credential_revoked_at, ?) WHERE owner_user_id = ?",
        [mysqlDateTime(now), mysqlDateTime(now), targetUserId],
      );
      await connection.execute<ResultSetHeader>(
        "INSERT INTO command_results (command_id, status, error_code, received_at, completed_at) SELECT id, 'failed', 'owner_deleted', ?, ? FROM commands WHERE owner_user_id = ? AND status IN ('created', 'sent', 'accepted', 'executing')",
        [mysqlDateTime(now), mysqlDateTime(now), targetUserId],
      );
      await connection.execute<ResultSetHeader>(
        "UPDATE commands SET status = 'failed' WHERE owner_user_id = ? AND status IN ('created', 'sent', 'accepted', 'executing')",
        [targetUserId],
      );
      await connection.execute<ResultSetHeader>(
        "DELETE FROM webauthn_credentials WHERE user_id = ?",
        [targetUserId],
      );
      await connection.execute<ResultSetHeader>(
        "DELETE FROM totp_authenticators WHERE user_id = ?",
        [targetUserId],
      );
      await connection.execute<ResultSetHeader>(
        "UPDATE recovery_codes SET revoked = TRUE WHERE user_id = ?",
        [targetUserId],
      );
      const tombstone = `deleted-${randomUUID()}@invalid`;
      await connection.execute<ResultSetHeader>(
        "UPDATE users SET normalized_identifier = ?, display_identifier = 'deleted account', password_hash = ?, status = 'deleted', must_change_password = FALSE, temporary_password_expires_at = NULL, deleted_at = ?, updated_at = ? WHERE id = ?",
        [
          tombstone,
          replacementPasswordHash,
          mysqlDateTime(now),
          mysqlDateTime(now),
          targetUserId,
        ],
      );
      await this.#sessions.revokeAll(targetUserId);
      await connection.commit();
      for (const deviceId of deviceIds) {
        this.#disconnectDevice(deviceId);
      }
    } catch (error: unknown) {
      await connection.rollback();
      throw error;
    } finally {
      await connection.end();
    }
  }

  async #assertAdminInvariant(
    connection: Awaited<ReturnType<typeof createConnection>>,
    target: UserRow,
    update: AdminUserUpdate,
  ): Promise<void> {
    if (target.role !== "admin" || target.status !== "active") {
      return;
    }
    const remainsActiveAdmin =
      (update.role ?? target.role) === "admin" &&
      (update.status ?? target.status) === "active";
    if (remainsActiveAdmin) {
      return;
    }
    const [activeAdmins] = await connection.execute<IdRow[]>(
      "SELECT id FROM users WHERE role = 'admin' AND status = 'active' AND deleted_at IS NULL FOR UPDATE",
    );
    if (activeAdmins.length <= 1) {
      throw new Error("last_admin_protected");
    }
  }

  async #lockTarget(
    connection: Awaited<ReturnType<typeof createConnection>>,
    targetUserId: string,
  ): Promise<UserRow> {
    const [rows] = await connection.execute<UserRow[]>(
      "SELECT id, identifier_type AS identifierType, display_identifier AS displayIdentifier, role, status, must_change_password AS mustChangePassword, created_at AS createdAt FROM users WHERE id = ? AND status <> 'deleted' FOR UPDATE",
      [targetUserId],
    );
    const target = rows[0];
    if (target === undefined) {
      throw new Error("user_not_found");
    }
    return target;
  }
}
