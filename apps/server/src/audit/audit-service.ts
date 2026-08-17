import { isIP } from "node:net";
import { randomUUID } from "node:crypto";
import { createConnection, type ResultSetHeader } from "mysql2/promise";
import type { ServerConfig } from "../config.js";

export type AuditVisibility = "owner" | "admin" | "system";

export type AuditEventInput = {
  action: string;
  actorId?: string;
  actorType: "user" | "agent" | "system";
  errorCategory?: string;
  metadata?: Record<string, unknown>;
  ownerUserId?: string;
  requestId: string;
  result: "success" | "failure";
  sourceAddress: string;
  subjectId: string;
  subjectType: string;
  visibility: AuditVisibility;
};

export type StoredAuditEvent = Omit<AuditEventInput, "sourceAddress"> & {
  id: string;
  occurredAt: string;
  sourceAddressClass: "loopback" | "private" | "public" | "unknown";
};

export type AuditRepository = {
  append: (event: StoredAuditEvent) => Promise<void>;
};

const classifyAddress = (
  address: string,
): StoredAuditEvent["sourceAddressClass"] => {
  const normalized = address.replace(/^::ffff:/u, "");
  if (normalized === "::1") {
    return "loopback";
  }
  if (isIP(normalized) === 4) {
    const [first = -1, second = -1] = normalized
      .split(".")
      .map((part) => Number.parseInt(part, 10));
    if (first === 127) {
      return "loopback";
    }
    if (
      first === 10 ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 168) ||
      (first === 169 && second === 254)
    ) {
      return "private";
    }
    return "public";
  }
  if (isIP(normalized) === 6) {
    const firstSegment = Number.parseInt(normalized.split(":")[0] ?? "", 16);
    if (
      (firstSegment >= 0xfc00 && firstSegment <= 0xfdff) ||
      (firstSegment >= 0xfe80 && firstSegment <= 0xfebf)
    ) {
      return "private";
    }
    return "public";
  }
  return "unknown";
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
    host: mysql.host,
    password: mysql.password,
    port: mysql.port,
    user: mysql.username,
    ...(mysql.tls ? { ssl: {} } : {}),
  };
};

export class AuditService {
  readonly #now: () => Date;
  readonly #repository: AuditRepository;

  public constructor(
    repository: AuditRepository,
    now: () => Date = () => new Date(),
  ) {
    this.#repository = repository;
    this.#now = now;
  }

  public record(input: AuditEventInput): Promise<void> {
    const { sourceAddress, ...event } = input;
    return this.#repository.append({
      ...event,
      id: randomUUID(),
      metadata: input.metadata ?? {},
      occurredAt: this.#now().toISOString(),
      sourceAddressClass: classifyAddress(sourceAddress),
    });
  }
}

export class MySqlAuditRepository implements AuditRepository {
  readonly #config: ServerConfig;

  public constructor(config: ServerConfig) {
    this.#config = config;
  }

  public async append(event: StoredAuditEvent): Promise<void> {
    const connection = await createConnection(connectionOptions(this.#config));
    try {
      await connection.execute<ResultSetHeader>(
        "INSERT INTO audit_events (id, occurred_at, actor_type, actor_id, subject_type, subject_id, owner_user_id, action, result, error_category, request_id, source_address_class, visibility, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [
          event.id,
          mysqlDateTime(new Date(event.occurredAt)),
          event.actorType,
          event.actorId ?? null,
          event.subjectType,
          event.subjectId,
          event.ownerUserId ?? null,
          event.action,
          event.result,
          event.errorCategory ?? null,
          event.requestId,
          event.sourceAddressClass,
          event.visibility,
          JSON.stringify(event.metadata ?? {}),
        ],
      );
    } finally {
      await connection.end();
    }
  }
}

export const createAuditService = (config: ServerConfig): AuditService =>
  new AuditService(new MySqlAuditRepository(config));
