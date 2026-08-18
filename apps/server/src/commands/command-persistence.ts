import {
  createConnection,
  type ResultSetHeader,
  type RowDataPacket,
} from "mysql2/promise";
import type {
  CommandErrorCode,
  CommandStatus,
  DeviceCapability,
} from "@remote-control-hub/contracts";
import type { ServerConfig } from "../config.js";
import type { CoordinatedBatch, CoordinatedCommand } from "./coordinator.js";

const TERMINAL_STATES = new Set<CommandStatus>([
  "succeeded",
  "failed",
  "expired",
  "outcome_unknown",
]);
const COMMAND_STATUSES = new Set<CommandStatus>([
  "created",
  "sent",
  "accepted",
  "executing",
  "succeeded",
  "failed",
  "expired",
  "outcome_unknown",
]);
const COMMAND_ERROR_CODES = new Set<CommandErrorCode>([
  "device_offline",
  "unsupported",
  "interactive_session_unavailable",
  "multiple_sessions_unsupported",
  "local_user_mismatch",
  "device_disabled",
  "device_credentials_revoked",
  "device_deleted",
  "owner_deleted",
  "execution_failed",
]);
const COMMAND_TYPES = new Set<DeviceCapability>([
  "display.turn_off",
  "media.volume_up",
  "media.volume_down",
  "media.volume_mute_toggle",
  "media.play_pause",
  "media.previous_track",
  "media.next_track",
  "media.stop",
]);

type BatchRow = RowDataPacket & {
  batchId: string;
  commandType: string;
  createdAt: string;
  initiatedByUserId: string;
  ownerUserId: string;
  requestDigest: Buffer;
};

type CommandRow = RowDataPacket & {
  commandId: string;
  deviceId: string;
  deviceSequence: number;
  errorCode: string | null;
  expiresAt: string;
  status: string;
};

type RecoverableCommandRow = CommandRow & {
  batchId: string;
  commandType: string;
  createdAt: string;
  initiatedByUserId: string;
  ownerUserId: string;
};

type ListedCommandRow = RecoverableCommandRow & {
  requestDigest: Buffer;
};

export type RecoverableCommand = CoordinatedCommand;

export type CommandPersistence = {
  findBatch: (
    ownerUserId: string,
    idempotencyKey: string,
  ) => Promise<CoordinatedBatch | undefined>;
  findBatchById: (
    ownerUserId: string,
    batchId: string,
  ) => Promise<CoordinatedBatch | undefined>;
  listBatches: (
    ownerUserId: string,
    limit: number,
  ) => Promise<CoordinatedBatch[]>;
  loadRecoverable: () => Promise<RecoverableCommand[]>;
  saveBatch: (batch: CoordinatedBatch, idempotencyKey: string) => Promise<void>;
  updateCommand: (command: CoordinatedCommand) => Promise<void>;
};

const mysqlDateTime = (date: Date): string =>
  date.toISOString().replace("T", " ").replace("Z", "");

const toIsoDateTime = (value: string): string =>
  new Date(`${value.replace(" ", "T")}Z`).toISOString();

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

const parseCommandType = (value: string): DeviceCapability => {
  if (!COMMAND_TYPES.has(value as DeviceCapability)) {
    throw new Error("command_record_invalid");
  }
  return value as DeviceCapability;
};

const parseCommandStatus = (value: string): CommandStatus => {
  if (!COMMAND_STATUSES.has(value as CommandStatus)) {
    throw new Error("command_record_invalid");
  }
  return value as CommandStatus;
};

const parseErrorCode = (value: string | null): CommandErrorCode | undefined => {
  if (value === null) {
    return undefined;
  }
  if (!COMMAND_ERROR_CODES.has(value as CommandErrorCode)) {
    throw new Error("command_record_invalid");
  }
  return value as CommandErrorCode;
};

const isDuplicateEntry = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  error.code === "ER_DUP_ENTRY";

export class MySqlCommandPersistence implements CommandPersistence {
  readonly #config: ServerConfig;

  public constructor(config: ServerConfig) {
    this.#config = config;
  }

  public async findBatch(
    ownerUserId: string,
    idempotencyKey: string,
  ): Promise<CoordinatedBatch | undefined> {
    const connection = await createConnection(connectionOptions(this.#config));
    try {
      const [batches] = await connection.execute<BatchRow[]>(
        "SELECT id AS batchId, owner_user_id AS ownerUserId, initiated_by_user_id AS initiatedByUserId, command_type AS commandType, request_digest AS requestDigest, created_at AS createdAt FROM command_batches WHERE owner_user_id = ? AND idempotency_key = ? LIMIT 1",
        [ownerUserId, idempotencyKey],
      );
      const batch = batches[0];
      if (batch === undefined) {
        return undefined;
      }
      const commandType = parseCommandType(batch.commandType);
      const [commands] = await connection.execute<CommandRow[]>(
        "SELECT c.id AS commandId, c.device_id AS deviceId, c.device_sequence AS deviceSequence, c.status, c.expires_at AS expiresAt, (SELECT cr.error_code FROM command_results cr WHERE cr.command_id = c.id ORDER BY cr.id DESC LIMIT 1) AS errorCode FROM commands c WHERE c.batch_id = ? ORDER BY c.device_sequence",
        [batch.batchId],
      );
      return {
        batchId: batch.batchId,
        commands: commands.map((command) => {
          const errorCode = parseErrorCode(command.errorCode);
          return {
            batchId: batch.batchId,
            commandId: command.commandId,
            commandType,
            createdAt: toIsoDateTime(batch.createdAt),
            deviceId: command.deviceId,
            ...(errorCode === undefined ? {} : { errorCode }),
            expiresAt: toIsoDateTime(command.expiresAt),
            initiatedByUserId: batch.initiatedByUserId,
            ownerUserId: batch.ownerUserId,
            sequence: command.deviceSequence,
            status: parseCommandStatus(command.status),
          };
        }),
        createdAt: toIsoDateTime(batch.createdAt),
        ownerUserId: batch.ownerUserId,
        requestDigest: batch.requestDigest.toString("hex"),
      };
    } finally {
      await connection.end();
    }
  }

  public async findBatchById(
    ownerUserId: string,
    batchId: string,
  ): Promise<CoordinatedBatch | undefined> {
    const connection = await createConnection(connectionOptions(this.#config));
    try {
      const [batches] = await connection.execute<BatchRow[]>(
        "SELECT id AS batchId, owner_user_id AS ownerUserId, initiated_by_user_id AS initiatedByUserId, command_type AS commandType, request_digest AS requestDigest, created_at AS createdAt FROM command_batches WHERE owner_user_id = ? AND id = ? LIMIT 1",
        [ownerUserId, batchId],
      );
      const batch = batches[0];
      if (batch === undefined) {
        return undefined;
      }
      const commandType = parseCommandType(batch.commandType);
      const [commands] = await connection.execute<CommandRow[]>(
        "SELECT c.id AS commandId, c.device_id AS deviceId, c.device_sequence AS deviceSequence, c.status, c.expires_at AS expiresAt, (SELECT cr.error_code FROM command_results cr WHERE cr.command_id = c.id ORDER BY cr.id DESC LIMIT 1) AS errorCode FROM commands c WHERE c.batch_id = ? ORDER BY c.device_sequence",
        [batch.batchId],
      );
      return {
        batchId: batch.batchId,
        commands: commands.map((command) => {
          const errorCode = parseErrorCode(command.errorCode);
          return {
            batchId: batch.batchId,
            commandId: command.commandId,
            commandType,
            createdAt: toIsoDateTime(batch.createdAt),
            deviceId: command.deviceId,
            ...(errorCode === undefined ? {} : { errorCode }),
            expiresAt: toIsoDateTime(command.expiresAt),
            initiatedByUserId: batch.initiatedByUserId,
            ownerUserId: batch.ownerUserId,
            sequence: command.deviceSequence,
            status: parseCommandStatus(command.status),
          };
        }),
        createdAt: toIsoDateTime(batch.createdAt),
        ownerUserId: batch.ownerUserId,
        requestDigest: batch.requestDigest.toString("hex"),
      };
    } finally {
      await connection.end();
    }
  }

  public async listBatches(
    ownerUserId: string,
    limit: number,
  ): Promise<CoordinatedBatch[]> {
    const connection = await createConnection(connectionOptions(this.#config));
    try {
      const [rows] = await connection.query<ListedCommandRow[]>(
        "SELECT cb.id AS batchId, cb.owner_user_id AS ownerUserId, cb.initiated_by_user_id AS initiatedByUserId, cb.command_type AS commandType, cb.request_digest AS requestDigest, cb.created_at AS createdAt, c.id AS commandId, c.device_id AS deviceId, c.device_sequence AS deviceSequence, c.status, c.expires_at AS expiresAt, (SELECT cr.error_code FROM command_results cr WHERE cr.command_id = c.id ORDER BY cr.id DESC LIMIT 1) AS errorCode FROM (SELECT id, owner_user_id, initiated_by_user_id, command_type, request_digest, created_at FROM command_batches WHERE owner_user_id = ? ORDER BY created_at DESC LIMIT ?) cb INNER JOIN commands c ON c.batch_id = cb.id ORDER BY cb.created_at DESC, c.device_sequence",
        [ownerUserId, limit],
      );
      const batches = new Map<string, CoordinatedBatch>();
      for (const row of rows) {
        const errorCode = parseErrorCode(row.errorCode);
        const createdAt = toIsoDateTime(row.createdAt);
        const batch = batches.get(row.batchId) ?? {
          batchId: row.batchId,
          commands: [],
          createdAt,
          ownerUserId: row.ownerUserId,
          requestDigest: row.requestDigest.toString("hex"),
        };
        batch.commands.push({
          batchId: row.batchId,
          commandId: row.commandId,
          commandType: parseCommandType(row.commandType),
          createdAt,
          deviceId: row.deviceId,
          ...(errorCode === undefined ? {} : { errorCode }),
          expiresAt: toIsoDateTime(row.expiresAt),
          initiatedByUserId: row.initiatedByUserId,
          ownerUserId: row.ownerUserId,
          sequence: row.deviceSequence,
          status: parseCommandStatus(row.status),
        });
        batches.set(row.batchId, batch);
      }
      return [...batches.values()];
    } finally {
      await connection.end();
    }
  }

  public async loadRecoverable(): Promise<RecoverableCommand[]> {
    const connection = await createConnection(connectionOptions(this.#config));
    try {
      const [commands] = await connection.execute<RecoverableCommandRow[]>(
        "SELECT c.id AS commandId, c.batch_id AS batchId, c.owner_user_id AS ownerUserId, c.device_id AS deviceId, c.status, c.device_sequence AS deviceSequence, c.expires_at AS expiresAt, c.created_at AS createdAt, cb.initiated_by_user_id AS initiatedByUserId, cb.command_type AS commandType, (SELECT cr.error_code FROM command_results cr WHERE cr.command_id = c.id ORDER BY cr.id DESC LIMIT 1) AS errorCode FROM commands c INNER JOIN command_batches cb ON cb.id = c.batch_id WHERE c.status IN ('created', 'sent', 'accepted', 'executing') ORDER BY c.device_id, c.device_sequence LIMIT 8000",
      );
      return commands.map((command) => {
        const errorCode = parseErrorCode(command.errorCode);
        return {
          batchId: command.batchId,
          commandId: command.commandId,
          commandType: parseCommandType(command.commandType),
          createdAt: toIsoDateTime(command.createdAt),
          deviceId: command.deviceId,
          ...(errorCode === undefined ? {} : { errorCode }),
          expiresAt: toIsoDateTime(command.expiresAt),
          initiatedByUserId: command.initiatedByUserId,
          ownerUserId: command.ownerUserId,
          sequence: command.deviceSequence,
          status: parseCommandStatus(command.status),
        };
      });
    } finally {
      await connection.end();
    }
  }

  public async saveBatch(
    batch: CoordinatedBatch,
    idempotencyKey: string,
  ): Promise<void> {
    const connection = await createConnection(connectionOptions(this.#config));
    try {
      await connection.beginTransaction();
      const first = batch.commands[0];
      if (first === undefined) {
        throw new Error("command_targets_invalid");
      }
      const batchStatus = batch.commands.some(
        (command) => !TERMINAL_STATES.has(command.status),
      )
        ? "created"
        : "failed";
      await connection.execute<ResultSetHeader>(
        "INSERT INTO command_batches (id, owner_user_id, initiated_by_user_id, command_type, target_count, status, idempotency_key, request_digest, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [
          batch.batchId,
          batch.ownerUserId,
          first.initiatedByUserId,
          first.commandType,
          batch.commands.length,
          batchStatus,
          idempotencyKey,
          Buffer.from(batch.requestDigest, "hex"),
          mysqlDateTime(new Date(batch.createdAt)),
        ],
      );
      for (const command of batch.commands) {
        await connection.execute<ResultSetHeader>(
          "INSERT INTO commands (id, batch_id, owner_user_id, device_id, status, device_sequence, parameters, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
          [
            command.commandId,
            batch.batchId,
            batch.ownerUserId,
            command.deviceId,
            command.status,
            command.sequence,
            "{}",
            mysqlDateTime(new Date(command.expiresAt)),
            mysqlDateTime(new Date(command.createdAt)),
          ],
        );
        if (command.errorCode !== undefined) {
          await connection.execute<ResultSetHeader>(
            "INSERT INTO command_results (command_id, status, error_code, received_at, completed_at) VALUES (?, ?, ?, ?, ?)",
            [
              command.commandId,
              command.status,
              command.errorCode,
              mysqlDateTime(new Date()),
              mysqlDateTime(new Date()),
            ],
          );
        }
      }
      await connection.commit();
    } catch (error: unknown) {
      await connection.rollback();
      if (isDuplicateEntry(error)) {
        throw new Error("idempotency_conflict", { cause: error });
      }
      throw error;
    } finally {
      await connection.end();
    }
  }

  public async updateCommand(command: CoordinatedCommand): Promise<void> {
    const connection = await createConnection(connectionOptions(this.#config));
    const now = mysqlDateTime(new Date());
    try {
      await connection.beginTransaction();
      await connection.execute<ResultSetHeader>(
        "UPDATE commands SET status = ? WHERE id = ? AND device_id = ?",
        [command.status, command.commandId, command.deviceId],
      );
      await connection.execute<ResultSetHeader>(
        "INSERT INTO command_results (command_id, status, error_code, received_at, completed_at) VALUES (?, ?, ?, ?, ?)",
        [
          command.commandId,
          command.status,
          command.errorCode ?? null,
          now,
          TERMINAL_STATES.has(command.status) ? now : null,
        ],
      );
      await connection.commit();
    } catch (error: unknown) {
      await connection.rollback();
      throw error;
    } finally {
      await connection.end();
    }
  }
}
