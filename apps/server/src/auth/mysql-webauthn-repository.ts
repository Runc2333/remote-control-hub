import {
  createConnection,
  type ResultSetHeader,
  type RowDataPacket,
} from "mysql2/promise";
import type {
  AuthenticatorTransportFuture,
  CredentialDeviceType,
} from "@simplewebauthn/server";
import type { ServerConfig } from "../config.js";
import type {
  StoredWebauthnCredential,
  WebauthnRepository,
  WebauthnUser,
} from "./webauthn-service.js";

type UserRow = RowDataPacket & {
  displayIdentifier: string;
  handle: Buffer;
  id: string;
  role: "admin" | "user";
  status: "active" | "disabled" | "deleted";
};

type CredentialRow = UserRow & {
  backedUp: number;
  counter: number;
  createdAt: Date | string;
  credentialId: string;
  deviceType: string;
  lastUsedAt: Date | string | null;
  name: string;
  publicKey: Buffer;
  transports: unknown;
};

const TRANSPORTS = new Set<AuthenticatorTransportFuture>([
  "ble",
  "cable",
  "hybrid",
  "internal",
  "nfc",
  "smart-card",
  "usb",
]);

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

const isoDateTime = (value: Date | string): string =>
  (value instanceof Date ? value : new Date(value)).toISOString();

const parseDeviceType = (value: string): CredentialDeviceType => {
  if (value !== "singleDevice" && value !== "multiDevice") {
    throw new Error("webauthn_credential_invalid");
  }
  return value;
};

const parseTransports = (value: unknown): AuthenticatorTransportFuture[] => {
  const parsed: unknown = typeof value === "string" ? JSON.parse(value) : value;
  if (
    !Array.isArray(parsed) ||
    !parsed.every(
      (transport: unknown): transport is AuthenticatorTransportFuture =>
        typeof transport === "string" &&
        TRANSPORTS.has(transport as AuthenticatorTransportFuture),
    )
  ) {
    throw new Error("webauthn_credential_invalid");
  }
  return parsed;
};

const toUser = (row: UserRow): WebauthnUser => ({
  displayIdentifier: row.displayIdentifier,
  handle: row.handle,
  id: row.id,
  role: row.role,
  status: row.status,
});

const toCredential = (row: CredentialRow): StoredWebauthnCredential => ({
  backedUp: row.backedUp === 1,
  counter: row.counter,
  createdAt: isoDateTime(row.createdAt),
  deviceType: parseDeviceType(row.deviceType),
  id: row.credentialId,
  ...(row.lastUsedAt === null
    ? {}
    : { lastUsedAt: isoDateTime(row.lastUsedAt) }),
  name: row.name,
  publicKey: row.publicKey,
  transports: parseTransports(row.transports),
  user: toUser(row),
});

const CREDENTIAL_SELECT =
  "SELECT c.id AS credentialId, c.public_key AS publicKey, c.counter, c.transports, c.device_type AS deviceType, c.backed_up AS backedUp, c.name, c.created_at AS createdAt, c.last_used_at AS lastUsedAt, u.id, u.display_identifier AS displayIdentifier, u.webauthn_user_handle AS handle, u.role, u.status FROM webauthn_credentials c INNER JOIN users u ON u.id = c.user_id";

export class MySqlWebauthnRepository implements WebauthnRepository {
  readonly #config: ServerConfig;

  public constructor(config: ServerConfig) {
    this.#config = config;
  }

  public async deleteCredential(
    userId: string,
    credentialId: string,
  ): Promise<boolean> {
    const connection = await createConnection(connectionOptions(this.#config));
    try {
      const [result] = await connection.execute<ResultSetHeader>(
        "DELETE FROM webauthn_credentials WHERE id = ? AND user_id = ?",
        [credentialId, userId],
      );
      return result.affectedRows === 1;
    } finally {
      await connection.end();
    }
  }

  public async findCredential(
    credentialId: string,
  ): Promise<StoredWebauthnCredential | undefined> {
    const connection = await createConnection(connectionOptions(this.#config));
    try {
      const [rows] = await connection.execute<CredentialRow[]>(
        `${CREDENTIAL_SELECT} WHERE c.id = ? LIMIT 1`,
        [credentialId],
      );
      return rows[0] === undefined ? undefined : toCredential(rows[0]);
    } finally {
      await connection.end();
    }
  }

  public async findUser(userId: string): Promise<WebauthnUser | undefined> {
    const connection = await createConnection(connectionOptions(this.#config));
    try {
      const [rows] = await connection.execute<UserRow[]>(
        "SELECT id, display_identifier AS displayIdentifier, webauthn_user_handle AS handle, role, status FROM users WHERE id = ? LIMIT 1",
        [userId],
      );
      return rows[0] === undefined ? undefined : toUser(rows[0]);
    } finally {
      await connection.end();
    }
  }

  public async listCredentials(
    userId: string,
  ): Promise<StoredWebauthnCredential[]> {
    const connection = await createConnection(connectionOptions(this.#config));
    try {
      const [rows] = await connection.execute<CredentialRow[]>(
        `${CREDENTIAL_SELECT} WHERE c.user_id = ? ORDER BY c.created_at DESC`,
        [userId],
      );
      return rows.map(toCredential);
    } finally {
      await connection.end();
    }
  }

  public async saveCredential(
    credential: StoredWebauthnCredential,
  ): Promise<void> {
    const connection = await createConnection(connectionOptions(this.#config));
    try {
      await connection.execute<ResultSetHeader>(
        "INSERT INTO webauthn_credentials (id, user_id, public_key, counter, transports, device_type, backed_up, name, created_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)",
        [
          credential.id,
          credential.user.id,
          Buffer.from(credential.publicKey),
          credential.counter,
          JSON.stringify(credential.transports),
          credential.deviceType,
          credential.backedUp,
          credential.name,
          mysqlDateTime(new Date(credential.createdAt)),
        ],
      );
    } finally {
      await connection.end();
    }
  }

  public async renameCredential(
    userId: string,
    credentialId: string,
    name: string,
  ): Promise<boolean> {
    const connection = await createConnection(connectionOptions(this.#config));
    try {
      const [result] = await connection.execute<ResultSetHeader>(
        "UPDATE webauthn_credentials SET name = ? WHERE id = ? AND user_id = ?",
        [name, credentialId, userId],
      );
      return result.affectedRows === 1;
    } finally {
      await connection.end();
    }
  }

  public async updateCounter(
    credentialId: string,
    previousCounter: number,
    newCounter: number,
    backedUp: boolean,
    usedAt: Date,
  ): Promise<boolean> {
    const connection = await createConnection(connectionOptions(this.#config));
    try {
      const [result] = await connection.execute<ResultSetHeader>(
        "UPDATE webauthn_credentials SET counter = ?, backed_up = ?, last_used_at = ? WHERE id = ? AND counter = ?",
        [
          newCounter,
          backedUp,
          mysqlDateTime(usedAt),
          credentialId,
          previousCounter,
        ],
      );
      return result.affectedRows === 1;
    } finally {
      await connection.end();
    }
  }
}
