import { randomBytes } from "node:crypto";
import {
  createConnection,
  type ResultSetHeader,
  type RowDataPacket,
} from "mysql2/promise";
import type {
  AdminDevice,
  DeviceCapability,
} from "@remote-control-hub/contracts";
import type { ServerConfig } from "../config.js";
import type { DeviceConnectionRegistry } from "./device-service.js";

const DEVICE_CAPABILITIES = new Set<DeviceCapability>([
  "display.turn_off",
  "media.volume_up",
  "media.volume_down",
  "media.volume_mute_toggle",
  "media.play_pause",
  "media.previous_track",
  "media.next_track",
  "media.stop",
]);

type AdminDeviceRow = RowDataPacket & {
  capabilities: string;
  computerName: string;
  createdAt: string;
  credentialRevokedAt: string | null;
  disabledAt: string | null;
  id: string;
  lastSeenAt: string | null;
  ownerDisplayIdentifier: string;
  ownerUserId: string;
  serviceVersion: string;
  sessionVersion: string;
};

type LockedDeviceRow = RowDataPacket & {
  credentialRevokedAt: string | null;
  deletedAt: string | null;
  disabledAt: string | null;
  id: string;
};

const connectionOptions = (config: ServerConfig) => {
  const mysql = config.mysqlConnection;
  if (mysql === undefined) {
    throw new Error("mysql_unavailable");
  }
  return {
    database: mysql.database,
    dateStrings: true,
    host: mysql.host,
    password: mysql.password,
    port: mysql.port,
    user: mysql.username,
    ...(mysql.tls ? { ssl: {} } : {}),
  };
};

const mysqlDateTime = (date: Date): string =>
  date.toISOString().replace("T", " ").replace("Z", "");

const toIsoDateTime = (value: string): string =>
  new Date(`${value.replace(" ", "T")}Z`).toISOString();

const parseCapabilities = (value: string): DeviceCapability[] => {
  const parsed: unknown = JSON.parse(value);
  if (
    !Array.isArray(parsed) ||
    !parsed.every(
      (capability): capability is DeviceCapability =>
        typeof capability === "string" &&
        DEVICE_CAPABILITIES.has(capability as DeviceCapability),
    )
  ) {
    throw new Error("device_capabilities_invalid");
  }
  return parsed;
};

export class AdminDeviceService {
  readonly #config: ServerConfig;
  readonly #connections: DeviceConnectionRegistry;
  readonly #now: () => Date;

  public constructor(
    config: ServerConfig,
    connections: DeviceConnectionRegistry,
    now: () => Date = () => new Date(),
  ) {
    this.#config = config;
    this.#connections = connections;
    this.#now = now;
  }

  public async list(): Promise<AdminDevice[]> {
    const connection = await createConnection(connectionOptions(this.#config));
    try {
      const [rows] = await connection.execute<AdminDeviceRow[]>(
        "SELECT d.id, d.owner_user_id AS ownerUserId, u.display_identifier AS ownerDisplayIdentifier, d.computer_name AS computerName, d.service_version AS serviceVersion, d.session_version AS sessionVersion, d.capabilities, d.disabled_at AS disabledAt, d.credential_revoked_at AS credentialRevokedAt, d.last_seen_at AS lastSeenAt, d.created_at AS createdAt FROM devices d INNER JOIN users u ON u.id = d.owner_user_id WHERE d.deleted_at IS NULL ORDER BY d.created_at DESC LIMIT 1000",
      );
      return rows.map((row) => ({
        capabilities: parseCapabilities(row.capabilities),
        computerName: row.computerName,
        credentialStatus:
          row.credentialRevokedAt === null ? "active" : "revoked",
        disabled: row.disabledAt !== null,
        id: row.id,
        ...(row.lastSeenAt === null
          ? {}
          : { lastActiveAt: toIsoDateTime(row.lastSeenAt) }),
        online: this.#connections.isOnline(row.id),
        ownerDisplayIdentifier: row.ownerDisplayIdentifier,
        ownerUserId: row.ownerUserId,
        serviceVersion: row.serviceVersion,
        sessionVersion: row.sessionVersion,
      }));
    } finally {
      await connection.end();
    }
  }

  public async setDisabled(deviceId: string, disabled: boolean): Promise<void> {
    const connection = await createConnection(connectionOptions(this.#config));
    try {
      await connection.beginTransaction();
      const device = await this.#lockDevice(connection, deviceId);
      if (!disabled && device.credentialRevokedAt !== null) {
        throw new Error("device_credentials_revoked");
      }
      const now = mysqlDateTime(this.#now());
      await connection.execute<ResultSetHeader>(
        "UPDATE devices SET disabled_at = ? WHERE id = ? AND deleted_at IS NULL",
        [disabled ? now : null, deviceId],
      );
      if (disabled) {
        await this.#failCommands(connection, deviceId, "device_disabled", now);
      }
      await connection.commit();
      if (disabled) {
        this.#connections.forceDisconnect(deviceId, "device_disabled");
      }
    } catch (error: unknown) {
      await connection.rollback();
      throw error;
    } finally {
      await connection.end();
    }
  }

  public async revokeCredentials(deviceId: string): Promise<void> {
    const connection = await createConnection(connectionOptions(this.#config));
    try {
      await connection.beginTransaction();
      const device = await this.#lockDevice(connection, deviceId);
      const now = mysqlDateTime(this.#now());
      if (device.credentialRevokedAt === null) {
        await connection.execute<ResultSetHeader>(
          "UPDATE devices SET disabled_at = COALESCE(disabled_at, ?), credential_revoked_at = ? WHERE id = ? AND deleted_at IS NULL",
          [now, now, deviceId],
        );
        await this.#failCommands(
          connection,
          deviceId,
          "device_credentials_revoked",
          now,
        );
      }
      await connection.commit();
      this.#connections.forceDisconnect(deviceId, "device_credentials_revoked");
    } catch (error: unknown) {
      await connection.rollback();
      throw error;
    } finally {
      await connection.end();
    }
  }

  public async delete(deviceId: string): Promise<void> {
    const connection = await createConnection(connectionOptions(this.#config));
    try {
      await connection.beginTransaction();
      const device = await this.#lockDevice(connection, deviceId);
      if (device.credentialRevokedAt === null) {
        throw new Error("device_credentials_active");
      }
      const now = mysqlDateTime(this.#now());
      await connection.execute<ResultSetHeader>(
        "DELETE FROM device_group_members WHERE device_id = ?",
        [deviceId],
      );
      await connection.execute<ResultSetHeader>(
        "UPDATE devices SET public_key = ?, computer_name = 'deleted device', service_version = 'deleted', session_version = 'deleted', capabilities = JSON_ARRAY(), disabled_at = COALESCE(disabled_at, ?), credential_revoked_at = COALESCE(credential_revoked_at, ?), last_seen_at = NULL, deleted_at = ? WHERE id = ? AND deleted_at IS NULL",
        [randomBytes(32), now, now, now, deviceId],
      );
      await connection.commit();
      this.#connections.forceDisconnect(deviceId, "device_deleted");
    } catch (error: unknown) {
      await connection.rollback();
      throw error;
    } finally {
      await connection.end();
    }
  }

  async #failCommands(
    connection: Awaited<ReturnType<typeof createConnection>>,
    deviceId: string,
    errorCode: string,
    occurredAt: string,
  ): Promise<void> {
    await connection.execute<ResultSetHeader>(
      "INSERT INTO command_results (command_id, status, error_code, received_at, completed_at) SELECT id, 'failed', ?, ?, ? FROM commands WHERE device_id = ? AND status IN ('created', 'sent', 'accepted', 'executing')",
      [errorCode, occurredAt, occurredAt, deviceId],
    );
    await connection.execute<ResultSetHeader>(
      "UPDATE commands SET status = 'failed' WHERE device_id = ? AND status IN ('created', 'sent', 'accepted', 'executing')",
      [deviceId],
    );
  }

  async #lockDevice(
    connection: Awaited<ReturnType<typeof createConnection>>,
    deviceId: string,
  ): Promise<LockedDeviceRow> {
    const [rows] = await connection.execute<LockedDeviceRow[]>(
      "SELECT id, disabled_at AS disabledAt, credential_revoked_at AS credentialRevokedAt, deleted_at AS deletedAt FROM devices WHERE id = ? FOR UPDATE",
      [deviceId],
    );
    const device = rows[0];
    if (device === undefined || device.deletedAt !== null) {
      throw new Error("device_not_found");
    }
    return device;
  }
}
