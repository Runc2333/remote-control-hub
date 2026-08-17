import { randomBytes } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  createConnection,
  type ResultSetHeader,
  type RowDataPacket,
} from "mysql2/promise";
import type { ServerConfig } from "../config.js";
import { TotpKeyring } from "../auth/totp.js";

type KeyringDocument = {
  currentVersion: number;
  keys: Record<string, string>;
};

type TotpRow = RowDataPacket & {
  algorithm: string;
  ciphertext: Buffer;
  id: string;
  keyVersion: number;
  nonce: Buffer;
  userId: string;
};

const parseKeyringDocument = (value: unknown): KeyringDocument => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("totp_keyring_file_invalid");
  }
  const record = value as Record<string, unknown>;
  if (
    !Number.isSafeInteger(record.currentVersion) ||
    typeof record.currentVersion !== "number" ||
    record.currentVersion < 1 ||
    typeof record.keys !== "object" ||
    record.keys === null ||
    Array.isArray(record.keys)
  ) {
    throw new Error("totp_keyring_file_invalid");
  }
  const keys: Record<string, string> = {};
  for (const [version, encoded] of Object.entries(record.keys)) {
    const parsedVersion = Number(version);
    if (
      !Number.isSafeInteger(parsedVersion) ||
      parsedVersion < 1 ||
      parsedVersion.toString() !== version ||
      typeof encoded !== "string"
    ) {
      throw new Error("totp_keyring_file_invalid");
    }
    const key = Buffer.from(encoded, "base64");
    if (key.byteLength !== 32 || key.toString("base64") !== encoded) {
      throw new Error("totp_keyring_file_invalid");
    }
    keys[version] = encoded;
  }
  if (keys[record.currentVersion.toString()] === undefined) {
    throw new Error("totp_keyring_file_invalid");
  }
  return { currentVersion: record.currentVersion, keys };
};

const toKeyMap = (document: KeyringDocument): ReadonlyMap<number, Uint8Array> =>
  new Map(
    Object.entries(document.keys).map(([version, encoded]) => [
      Number(version),
      Buffer.from(encoded, "base64"),
    ]),
  );

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

const writeKeyring = async (
  path: string,
  document: KeyringDocument,
): Promise<void> => {
  const temporaryPath = join(
    dirname(path),
    `.totp-keyring-${randomBytes(8).toString("hex")}.tmp`,
  );
  await writeFile(temporaryPath, `${JSON.stringify(document)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporaryPath, path);
};

export const rotateTotpKey = async (
  config: ServerConfig,
  keyringPath: string,
): Promise<{ reencrypted: number; version: number }> => {
  const current = parseKeyringDocument(
    JSON.parse(await readFile(keyringPath, "utf8")) as unknown,
  );
  const version = Math.max(...Object.keys(current.keys).map(Number)) + 1;
  if (!Number.isSafeInteger(version)) {
    throw new Error("totp_key_version_exhausted");
  }
  const next: KeyringDocument = {
    currentVersion: version,
    keys: {
      ...current.keys,
      [version.toString()]: randomBytes(32).toString("base64"),
    },
  };
  await writeKeyring(keyringPath, next);
  const keyring = new TotpKeyring(toKeyMap(next), version);
  const connection = await createConnection(connectionOptions(config));
  let reencrypted = 0;
  try {
    while (true) {
      const [rows] = await connection.execute<TotpRow[]>(
        "SELECT id, user_id AS userId, algorithm, key_version AS keyVersion, nonce, ciphertext FROM totp_authenticators WHERE enabled = TRUE AND key_version <> ? ORDER BY id LIMIT 100",
        [version],
      );
      if (rows.length === 0) {
        break;
      }
      await connection.beginTransaction();
      try {
        for (const row of rows) {
          if (row.algorithm !== "aes-256-gcm") {
            throw new Error("totp_algorithm_invalid");
          }
          const secret = keyring.decrypt(row.userId, row.id, {
            algorithm: "aes-256-gcm",
            ciphertext: row.ciphertext,
            keyVersion: row.keyVersion,
            nonce: row.nonce,
          });
          const encrypted = keyring.encrypt(row.userId, row.id, secret);
          const [result] = await connection.execute<ResultSetHeader>(
            "UPDATE totp_authenticators SET key_version = ?, nonce = ?, ciphertext = ? WHERE id = ? AND key_version = ?",
            [
              encrypted.keyVersion,
              Buffer.from(encrypted.nonce),
              Buffer.from(encrypted.ciphertext),
              row.id,
              row.keyVersion,
            ],
          );
          reencrypted += result.affectedRows;
        }
        await connection.commit();
      } catch (error: unknown) {
        await connection.rollback();
        throw error;
      }
    }
  } finally {
    await connection.end();
  }
  return { reencrypted, version };
};

export const readTotpKeyringFile = async (
  path: string,
): Promise<{
  currentVersion: number;
  keys: ReadonlyMap<number, Uint8Array>;
}> => {
  const document = parseKeyringDocument(
    JSON.parse(await readFile(path, "utf8")) as unknown,
  );
  return {
    currentVersion: document.currentVersion,
    keys: toKeyMap(document),
  };
};
