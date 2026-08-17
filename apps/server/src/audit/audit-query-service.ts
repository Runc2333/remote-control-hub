import { createConnection, type RowDataPacket } from "mysql2/promise";
import type {
  AuditEvent,
  AuditEventListResponse,
  AuditEventQuery,
} from "@remote-control-hub/contracts";
import type { ServerConfig } from "../config.js";

const DEFAULT_PAGE_SIZE = 50;

type AuditRow = RowDataPacket & {
  action: string;
  actorId: string | null;
  actorType: "agent" | "system" | "user";
  errorCategory: string | null;
  id: string;
  occurredAt: string;
  requestId: string;
  result: "failure" | "success";
  sourceAddressClass: "loopback" | "private" | "public" | "unknown";
  subjectId: string;
  subjectType: string;
  visibility: "admin" | "owner" | "system";
};

type AuditCursor = {
  id: string;
  occurredAt: string;
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

const mysqlDateTime = (value: string): string =>
  new Date(value).toISOString().replace("T", " ").replace("Z", "");

const toIsoDateTime = (value: string): string =>
  new Date(`${value.replace(" ", "T")}Z`).toISOString();

const encodeCursor = (cursor: AuditCursor): string =>
  Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");

const decodeCursor = (value: string): AuditCursor => {
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    );
    if (typeof parsed !== "object" || parsed === null) {
      throw new Error("audit_cursor_invalid");
    }
    const record = parsed as Record<string, unknown>;
    if (
      typeof record.id !== "string" ||
      record.id.length === 0 ||
      typeof record.occurredAt !== "string" ||
      !Number.isFinite(Date.parse(record.occurredAt))
    ) {
      throw new Error("audit_cursor_invalid");
    }
    return { id: record.id, occurredAt: record.occurredAt };
  } catch (error: unknown) {
    if (error instanceof Error && error.message === "audit_cursor_invalid") {
      throw error;
    }
    throw new Error("audit_cursor_invalid", { cause: error });
  }
};

const toAuditEvent = (row: AuditRow): AuditEvent => ({
  action: row.action,
  ...(row.actorId === null ? {} : { actorId: row.actorId }),
  actorType: row.actorType,
  ...(row.errorCategory === null ? {} : { errorCategory: row.errorCategory }),
  id: row.id,
  occurredAt: toIsoDateTime(row.occurredAt),
  requestId: row.requestId,
  result: row.result,
  sourceAddressClass: row.sourceAddressClass,
  subjectId: row.subjectId,
  subjectType: row.subjectType,
  visibility: row.visibility,
});

export class AuditQueryService {
  readonly #config: ServerConfig;

  public constructor(config: ServerConfig) {
    this.#config = config;
  }

  public listAdmin(query: AuditEventQuery): Promise<AuditEventListResponse> {
    return this.#list(undefined, true, query);
  }

  public listOwner(
    ownerUserId: string,
    query: AuditEventQuery,
  ): Promise<AuditEventListResponse> {
    return this.#list(ownerUserId, false, query);
  }

  async #list(
    ownerUserId: string | undefined,
    admin: boolean,
    query: AuditEventQuery,
  ): Promise<AuditEventListResponse> {
    const limit = query.limit ?? DEFAULT_PAGE_SIZE;
    const clauses = [
      admin ? "visibility IN ('admin', 'system')" : "visibility = 'owner'",
    ];
    const values: (number | string)[] = [];
    if (ownerUserId !== undefined) {
      clauses.push("owner_user_id = ?");
      values.push(ownerUserId);
    }
    if (query.action !== undefined) {
      clauses.push("action = ?");
      values.push(query.action);
    }
    if (query.result !== undefined) {
      clauses.push("result = ?");
      values.push(query.result);
    }
    if (query.from !== undefined) {
      clauses.push("occurred_at >= ?");
      values.push(mysqlDateTime(query.from));
    }
    if (query.to !== undefined) {
      clauses.push("occurred_at <= ?");
      values.push(mysqlDateTime(query.to));
    }
    if (query.cursor !== undefined) {
      const cursor = decodeCursor(query.cursor);
      const occurredAt = mysqlDateTime(cursor.occurredAt);
      clauses.push("(occurred_at < ? OR (occurred_at = ? AND id < ?))");
      values.push(occurredAt, occurredAt, cursor.id);
    }
    values.push(limit + 1);
    const connection = await createConnection(connectionOptions(this.#config));
    try {
      const [rows] = await connection.query<AuditRow[]>(
        `SELECT id, occurred_at AS occurredAt, actor_type AS actorType, actor_id AS actorId, subject_type AS subjectType, subject_id AS subjectId, action, result, error_category AS errorCategory, request_id AS requestId, source_address_class AS sourceAddressClass, visibility FROM audit_events WHERE ${clauses.join(" AND ")} ORDER BY occurred_at DESC, id DESC LIMIT ?`,
        values,
      );
      const hasNextPage = rows.length > limit;
      const page = rows.slice(0, limit);
      const last = page.at(-1);
      return {
        events: page.map(toAuditEvent),
        ...(hasNextPage && last !== undefined
          ? {
              nextCursor: encodeCursor({
                id: last.id,
                occurredAt: toIsoDateTime(last.occurredAt),
              }),
            }
          : {}),
      };
    } finally {
      await connection.end();
    }
  }
}

export const createAuditQueryService = (
  config: ServerConfig,
): AuditQueryService => new AuditQueryService(config);
