import { randomBytes, randomUUID } from "node:crypto";
import {
  AgentConnectionCoordinator,
  type AgentAuthenticationDevice,
  type AgentConnectionRepository,
} from "./agent-connection.js";
import {
  createConnection,
  type ResultSetHeader,
  type RowDataPacket,
} from "mysql2/promise";
import type { RegisterAgentRequest } from "@remote-control-hub/contracts";
import type { ServerConfig } from "../config.js";
import { AdminDeviceService } from "./admin-device-service.js";
import {
  DeviceConnectionRegistry,
  DeviceService,
  type DeviceRepository,
  type StoredDevice,
} from "./device-service.js";
import { parseDeviceCapabilities } from "./device-capabilities.js";

type EnrollmentRow = RowDataPacket & {
  expiresAt: string;
  id: string;
  ownerUserId: string;
};

type CountRow = RowDataPacket & { count: number };

type DeletableDeviceRow = RowDataPacket & { id: string };

type GenerationRow = RowDataPacket & { generation: number | string };

type DeviceRow = RowDataPacket & {
  capabilities: unknown;
  computerName: string;
  id: string;
  lastSeenAt: string | null;
  ownerUserId: string;
  serviceVersion: string;
  sessionVersion: string;
};

type AuthenticationDeviceRow = RowDataPacket & {
  active: number;
  deleted: number;
  id: string;
  publicKey: Buffer;
};

const mysqlDateTime = (date: Date): string =>
  date.toISOString().replace("T", " ").replace("Z", "");

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

const createDeviceRepository = (config: ServerConfig): DeviceRepository => ({
  createEnrollmentToken: async (ownerUserId, tokenHash, expiresAt) => {
    const connection = await createConnection(connectionOptions(config));
    try {
      await connection.execute<ResultSetHeader>(
        "INSERT INTO enrollment_tokens (id, owner_user_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)",
        [
          randomUUID(),
          ownerUserId,
          tokenHash,
          mysqlDateTime(new Date(expiresAt)),
          mysqlDateTime(new Date()),
        ],
      );
    } finally {
      await connection.end();
    }
  },
  deleteDevice: async (deviceId, ownerUserId) => {
    const connection = await createConnection(connectionOptions(config));
    try {
      await connection.beginTransaction();
      const [devices] =
        ownerUserId === undefined
          ? await connection.execute<DeletableDeviceRow[]>(
              "SELECT id FROM devices WHERE id = ? AND deleted_at IS NULL FOR UPDATE",
              [deviceId],
            )
          : await connection.execute<DeletableDeviceRow[]>(
              "SELECT id FROM devices WHERE id = ? AND owner_user_id = ? AND deleted_at IS NULL FOR UPDATE",
              [deviceId, ownerUserId],
            );
      if (devices[0] === undefined) {
        throw new Error("device_not_found");
      }
      const now = mysqlDateTime(new Date());
      await connection.execute<ResultSetHeader>(
        "INSERT INTO command_results (command_id, status, error_code, received_at, completed_at) SELECT id, 'failed', 'device_deleted', ?, ? FROM commands WHERE device_id = ? AND status IN ('created', 'sent', 'accepted', 'executing')",
        [now, now, deviceId],
      );
      await connection.execute<ResultSetHeader>(
        "UPDATE commands SET status = 'failed' WHERE device_id = ? AND status IN ('created', 'sent', 'accepted', 'executing')",
        [deviceId],
      );
      await connection.execute<ResultSetHeader>(
        "DELETE FROM device_group_members WHERE device_id = ?",
        [deviceId],
      );
      await connection.execute<ResultSetHeader>(
        "UPDATE devices SET public_key = ?, computer_name = 'deleted device', service_version = 'deleted', session_version = 'deleted', capabilities = JSON_ARRAY(), disabled_at = COALESCE(disabled_at, ?), credential_revoked_at = COALESCE(credential_revoked_at, ?), last_seen_at = NULL, deleted_at = ? WHERE id = ? AND deleted_at IS NULL",
        [randomBytes(32), now, now, now, deviceId],
      );
      await connection.commit();
    } catch (error: unknown) {
      await connection.rollback();
      throw error;
    } finally {
      await connection.end();
    }
  },
  listDevices: async (ownerUserId): Promise<StoredDevice[]> => {
    const connection = await createConnection(connectionOptions(config));
    try {
      const [rows] = await connection.execute<DeviceRow[]>(
        "SELECT id, owner_user_id AS ownerUserId, computer_name AS computerName, service_version AS serviceVersion, session_version AS sessionVersion, capabilities, last_seen_at AS lastSeenAt FROM devices WHERE owner_user_id = ? AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1000",
        [ownerUserId],
      );
      return rows.map((row) => ({
        capabilities: parseDeviceCapabilities(row.capabilities),
        computerName: row.computerName,
        id: row.id,
        ...(row.lastSeenAt === null
          ? {}
          : {
              lastSeenAt: new Date(
                `${row.lastSeenAt.replace(" ", "T")}Z`,
              ).toISOString(),
            }),
        ownerUserId: row.ownerUserId,
        serviceVersion: row.serviceVersion,
        sessionVersion: row.sessionVersion,
      }));
    } finally {
      await connection.end();
    }
  },
  registerDevice: async (
    tokenHash: Buffer,
    request: Omit<RegisterAgentRequest, "enrollmentToken">,
  ) => {
    const connection = await createConnection(connectionOptions(config));
    try {
      await connection.beginTransaction();
      const [enrollments] = await connection.execute<EnrollmentRow[]>(
        "SELECT id, owner_user_id AS ownerUserId, expires_at AS expiresAt FROM enrollment_tokens WHERE token_hash = ? AND used_at IS NULL LIMIT 1 FOR UPDATE",
        [tokenHash],
      );
      const enrollment = enrollments[0];
      const now = new Date();
      if (
        enrollment === undefined ||
        Date.parse(`${enrollment.expiresAt.replace(" ", "T")}Z`) <=
          now.getTime()
      ) {
        throw new Error("enrollment_token_invalid");
      }
      const [deviceCounts] = await connection.execute<CountRow[]>(
        "SELECT COUNT(*) AS count FROM devices WHERE deleted_at IS NULL FOR UPDATE",
      );
      if (Number(deviceCounts[0]?.count ?? 0) >= 1_000) {
        throw new Error("registered_device_capacity_exceeded");
      }
      const usedAt = mysqlDateTime(now);
      await connection.execute<ResultSetHeader>(
        "UPDATE enrollment_tokens SET used_at = ? WHERE id = ? AND used_at IS NULL",
        [usedAt, enrollment.id],
      );
      const deviceId = randomUUID();
      await connection.execute<ResultSetHeader>(
        "INSERT INTO devices (id, owner_user_id, public_key, computer_name, platform, service_version, session_version, capabilities, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [
          deviceId,
          enrollment.ownerUserId,
          Buffer.from(request.publicKey, "base64url"),
          request.computerName,
          request.platform,
          request.serviceVersion,
          request.sessionVersion,
          JSON.stringify(request.capabilities),
          usedAt,
        ],
      );
      await connection.commit();
      return deviceId;
    } catch (error: unknown) {
      await connection.rollback();
      if (
        error instanceof Error &&
        (error.message === "enrollment_token_invalid" ||
          ("code" in error && error.code === "ER_DUP_ENTRY"))
      ) {
        throw new Error("enrollment_token_invalid", { cause: error });
      }
      throw error;
    } finally {
      await connection.end();
    }
  },
});

const createAgentConnectionRepository = (
  config: ServerConfig,
): AgentConnectionRepository => ({
  findAuthenticationDevice: async (
    deviceId: string,
  ): Promise<AgentAuthenticationDevice | undefined> => {
    const connection = await createConnection(connectionOptions(config));
    try {
      const [rows] = await connection.execute<AuthenticationDeviceRow[]>(
        "SELECT id, public_key AS publicKey, (disabled_at IS NULL AND credential_revoked_at IS NULL AND deleted_at IS NULL) AS active, (deleted_at IS NOT NULL) AS deleted FROM devices WHERE id = ? LIMIT 1",
        [deviceId],
      );
      const row = rows[0];
      return row === undefined
        ? undefined
        : {
            active: row.active === 1,
            deleted: row.deleted === 1,
            id: row.id,
            publicKey: row.publicKey,
          };
    } finally {
      await connection.end();
    }
  },
  recordAuthenticated: async (hello, remoteAddress, sessionId) => {
    const connection = await createConnection(connectionOptions(config));
    const now = mysqlDateTime(new Date());
    try {
      await connection.beginTransaction();
      const [devices] = await connection.execute<RowDataPacket[]>(
        "SELECT id FROM devices WHERE id = ? AND disabled_at IS NULL AND credential_revoked_at IS NULL AND deleted_at IS NULL FOR UPDATE",
        [hello.deviceId],
      );
      if (devices[0] === undefined) {
        throw new Error("device_authentication_failed");
      }
      const [generations] = await connection.execute<GenerationRow[]>(
        "SELECT generation FROM device_sessions WHERE device_id = ? ORDER BY generation DESC LIMIT 1 FOR UPDATE",
        [hello.deviceId],
      );
      const previousGeneration = Number(generations[0]?.generation ?? 0);
      const generation = previousGeneration + 1;
      if (!Number.isSafeInteger(generation) || generation <= 0) {
        throw new Error("agent_generation_invalid");
      }
      await connection.execute<ResultSetHeader>(
        "UPDATE devices SET service_version = ?, session_version = ?, capabilities = ?, last_seen_at = ? WHERE id = ?",
        [
          hello.serviceVersion,
          hello.sessionVersion,
          JSON.stringify(hello.capabilities),
          now,
          hello.deviceId,
        ],
      );
      await connection.execute<ResultSetHeader>(
        "INSERT INTO device_sessions (id, device_id, generation, connected_at, last_heartbeat_at, remote_address) VALUES (?, ?, ?, ?, ?, ?)",
        [sessionId, hello.deviceId, generation, now, now, remoteAddress],
      );
      await connection.commit();
      return generation;
    } catch (error: unknown) {
      await connection.rollback();
      throw error;
    } finally {
      await connection.end();
    }
  },
  recordDisconnected: async (sessionId, reason) => {
    const connection = await createConnection(connectionOptions(config));
    try {
      await connection.execute<ResultSetHeader>(
        "UPDATE device_sessions SET disconnected_at = ?, close_reason = ? WHERE id = ? AND disconnected_at IS NULL",
        [mysqlDateTime(new Date()), reason, sessionId],
      );
    } finally {
      await connection.end();
    }
  },
  recordHeartbeat: async (deviceId, sessionId) => {
    const connection = await createConnection(connectionOptions(config));
    const now = mysqlDateTime(new Date());
    try {
      await connection.beginTransaction();
      await connection.execute<ResultSetHeader>(
        "UPDATE device_sessions SET last_heartbeat_at = ? WHERE id = ? AND device_id = ? AND disconnected_at IS NULL",
        [now, sessionId, deviceId],
      );
      await connection.execute<ResultSetHeader>(
        "UPDATE devices SET last_seen_at = ? WHERE id = ?",
        [now, deviceId],
      );
      await connection.commit();
    } catch (error: unknown) {
      await connection.rollback();
      throw error;
    } finally {
      await connection.end();
    }
  },
});

export type DeviceRuntime = {
  admin: Pick<
    AdminDeviceService,
    "delete" | "list" | "revokeCredentials" | "setDisabled"
  >;
  agentConnections: AgentConnectionCoordinator;
  connections: DeviceConnectionRegistry;
  service: DeviceService;
};

export const createDeviceRuntime = (config: ServerConfig): DeviceRuntime => {
  const connections = new DeviceConnectionRegistry();
  return {
    admin: new AdminDeviceService(config, connections),
    agentConnections: new AgentConnectionCoordinator(
      createAgentConnectionRepository(config),
      connections,
    ),
    connections,
    service: new DeviceService(createDeviceRepository(config), connections),
  };
};
