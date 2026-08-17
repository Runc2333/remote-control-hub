import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  appendFile,
  mkdir,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { drizzle } from "drizzle-orm/mysql2";
import { migrate } from "drizzle-orm/mysql2/migrator";
import { createConnection, type RowDataPacket } from "mysql2/promise";
import type { ServerConfig } from "../config.js";
import { FileSetupStateStore } from "../setup/setup-state.js";

type CountRow = RowDataPacket & { count: number };

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

const setupSecretFile = (config: ServerConfig): string =>
  config.setupSecretFile ??
  join(dirname(config.setupStateFile), "setup-secret.json");

const operationsAuditFile = (config: ServerConfig): string =>
  config.operationsAuditFile ??
  join(dirname(config.setupStateFile), "operations-audit.jsonl");

const writeOperationsAudit = async (
  config: ServerConfig,
  action: string,
  result: "failure" | "success",
  details: Record<string, boolean | number | string> = {},
): Promise<void> => {
  const path = operationsAuditFile(config);
  await mkdir(dirname(path), { recursive: true });
  await appendFile(
    path,
    `${JSON.stringify({
      action,
      occurredAt: new Date().toISOString(),
      result,
      ...details,
    })}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
};

export const issueSetupSecret = async (
  config: ServerConfig,
  rotate: boolean,
  ttlSeconds: number,
): Promise<{ expiresAt: string; setupSecret: string }> => {
  if (
    !Number.isSafeInteger(ttlSeconds) ||
    ttlSeconds < 60 ||
    ttlSeconds > 3600
  ) {
    throw new Error("setup_secret_ttl_invalid");
  }
  const state = await new FileSetupStateStore(
    config.setupStateFile,
    config.deploymentMode,
  ).read();
  if (state.step === "installed") {
    throw new Error("setup_already_complete");
  }
  const path = setupSecretFile(config);
  if (!rotate) {
    try {
      const existing: unknown = JSON.parse(await readFile(path, "utf8"));
      if (
        typeof existing === "object" &&
        existing !== null &&
        "expiresAt" in existing &&
        typeof existing.expiresAt === "string" &&
        Date.parse(existing.expiresAt) > Date.now()
      ) {
        throw new Error("setup_secret_already_active");
      }
    } catch (error: unknown) {
      if (
        error instanceof Error &&
        error.message === "setup_secret_already_active"
      ) {
        throw error;
      }
      if (
        typeof error !== "object" ||
        error === null ||
        !("code" in error) ||
        error.code !== "ENOENT"
      ) {
        throw error;
      }
    }
  }
  const setupSecret = randomBytes(32).toString("base64url");
  const issuedAt = new Date();
  const expiresAt = new Date(issuedAt.getTime() + ttlSeconds * 1_000);
  const document = {
    digest: createHash("sha256").update(setupSecret, "utf8").digest("hex"),
    expiresAt: expiresAt.toISOString(),
    issuedAt: issuedAt.toISOString(),
  };
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(document)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporaryPath, path);
  await writeOperationsAudit(
    config,
    rotate ? "setup-secret.rotate" : "setup-secret.issue",
    "success",
    { expiresAt: document.expiresAt },
  );
  return { expiresAt: document.expiresAt, setupSecret };
};

export const getSetupManagementStatus = async (
  config: ServerConfig,
): Promise<{
  deploymentMode: ServerConfig["deploymentMode"];
  fencingToken: number;
  setupSecretActive: boolean;
  step: string;
  updatedAt: string;
}> => {
  const state = await new FileSetupStateStore(
    config.setupStateFile,
    config.deploymentMode,
  ).read();
  let setupSecretActive = false;
  try {
    const document: unknown = JSON.parse(
      await readFile(setupSecretFile(config), "utf8"),
    );
    setupSecretActive =
      typeof document === "object" &&
      document !== null &&
      "expiresAt" in document &&
      typeof document.expiresAt === "string" &&
      Date.parse(document.expiresAt) > Date.now();
  } catch (error: unknown) {
    if (
      typeof error !== "object" ||
      error === null ||
      !("code" in error) ||
      error.code !== "ENOENT"
    ) {
      throw error;
    }
  }
  return {
    deploymentMode: state.deploymentMode,
    fencingToken: state.fencingToken,
    setupSecretActive,
    step: state.step,
    updatedAt: state.updatedAt,
  };
};

export const reconcileSetup = async (
  config: ServerConfig,
  backupReference: string,
): Promise<Awaited<ReturnType<FileSetupStateStore["read"]>>> => {
  if (backupReference.trim().length < 8 || backupReference.length > 128) {
    throw new Error("backup_reference_invalid");
  }
  const connection = await createConnection(mysqlOptions(config));
  try {
    const [rows] = await connection.execute<CountRow[]>(
      "SELECT COUNT(*) AS count FROM users WHERE role = 'admin' AND status = 'active' AND deleted_at IS NULL",
    );
    const state = await new FileSetupStateStore(
      config.setupStateFile,
      config.deploymentMode,
    ).reconcile(Number(rows[0]?.count ?? 0) > 0);
    await writeOperationsAudit(config, "setup.reconcile", "success", {
      backupReference: backupReference.trim(),
      resultingStep: state.step,
    });
    return state;
  } catch (error: unknown) {
    await writeOperationsAudit(config, "setup.reconcile", "failure", {
      backupReference: backupReference.trim(),
    });
    throw error;
  } finally {
    await connection.end();
  }
};

export const getMigrationStatus = async (
  config: ServerConfig,
): Promise<{
  applied: number;
  expected: number;
  latestExpected?: string;
  pending: number;
}> => {
  const journal: unknown = JSON.parse(
    await readFile(
      join(config.migrationsFolder, "meta", "_journal.json"),
      "utf8",
    ),
  );
  if (
    typeof journal !== "object" ||
    journal === null ||
    !("entries" in journal) ||
    !Array.isArray(journal.entries)
  ) {
    throw new Error("migration_journal_invalid");
  }
  const tags = journal.entries.flatMap((entry: unknown) => {
    if (
      typeof entry === "object" &&
      entry !== null &&
      "tag" in entry &&
      typeof entry.tag === "string"
    ) {
      return [entry.tag];
    }
    return [];
  });
  const connection = await createConnection(mysqlOptions(config));
  let applied = 0;
  try {
    const [rows] = await connection.query<CountRow[]>(
      "SELECT COUNT(*) AS count FROM __drizzle_migrations",
    );
    applied = Number(rows[0]?.count ?? 0);
  } catch (error: unknown) {
    if (
      typeof error !== "object" ||
      error === null ||
      !("code" in error) ||
      error.code !== "ER_NO_SUCH_TABLE"
    ) {
      throw error;
    }
  } finally {
    await connection.end();
  }
  const latestExpected = tags.at(-1);
  return {
    applied,
    expected: tags.length,
    ...(latestExpected === undefined ? {} : { latestExpected }),
    pending: Math.max(0, tags.length - applied),
  };
};

export const applyMigrations = async (
  config: ServerConfig,
): Promise<Awaited<ReturnType<typeof getMigrationStatus>>> => {
  const before = await getMigrationStatus(config);
  const connection = await createConnection(mysqlOptions(config));
  try {
    await migrate(drizzle(connection), {
      migrationsFolder: config.migrationsFolder,
    });
    const after = await getMigrationStatus(config);
    await writeOperationsAudit(config, "migration.apply", "success", {
      appliedBefore: before.applied,
      appliedAfter: after.applied,
      expected: after.expected,
    });
    return after;
  } catch (error: unknown) {
    await writeOperationsAudit(config, "migration.apply", "failure", {
      appliedBefore: before.applied,
      expected: before.expected,
    });
    throw error;
  } finally {
    await connection.end();
  }
};
