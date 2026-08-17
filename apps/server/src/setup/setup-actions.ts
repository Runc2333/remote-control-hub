import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import { migrate } from "drizzle-orm/mysql2/migrator";
import { createConnection } from "mysql2/promise";
import type {
  CompleteSetupRequest,
  MysqlConnection,
  RedisConnection,
} from "@remote-control-hub/contracts";
import { normalizeIdentifier } from "../auth/identifiers.js";
import { hashPassword } from "../auth/password.js";
import type { ServerConfig } from "../config.js";
import { installationRecords, systemSettings, users } from "../db/schema.js";
import { testDataServiceConnection } from "./data-services.js";
import type { SetupActions } from "./setup-coordinator.js";

type SetupConnections = {
  mysql: MysqlConnection;
  redis: RedisConnection;
};

const mysqlOptions = (connection: MysqlConnection) => ({
  database: connection.database,
  host: connection.host,
  password: connection.password,
  port: connection.port,
  user: connection.username,
  ...(connection.tls ? { ssl: {} } : {}),
});

const mysqlDateTime = (date: Date): string =>
  date.toISOString().replace("T", " ").replace("Z", "");

const resolveConnections = (
  config: ServerConfig,
  request: CompleteSetupRequest,
): SetupConnections => {
  if (config.deploymentMode === "compose") {
    if (request.connections !== undefined) {
      throw new Error("compose_target_immutable");
    }
    if (
      config.mysqlConnection === undefined ||
      config.redisConnection === undefined
    ) {
      throw new Error("compose_data_services_unavailable");
    }
    return {
      mysql: config.mysqlConnection,
      redis: config.redisConnection,
    };
  }
  if (request.connections === undefined) {
    throw new Error("standalone_connections_required");
  }
  config.mysqlConnection = request.connections.mysql;
  config.redisConnection = request.connections.redis;
  return request.connections;
};

const writeSetupConfiguration = async (
  config: ServerConfig,
  connections: SetupConnections,
): Promise<void> => {
  const value =
    config.deploymentMode === "standalone"
      ? { deploymentMode: config.deploymentMode, ...connections }
      : {
          deploymentMode: config.deploymentMode,
          fingerprint: createHash("sha256")
            .update(
              JSON.stringify({
                mysql: {
                  database: connections.mysql.database,
                  host: connections.mysql.host,
                  port: connections.mysql.port,
                },
                redis: {
                  database: connections.redis.database,
                  host: connections.redis.host,
                  port: connections.redis.port,
                },
              }),
              "utf8",
            )
            .digest("hex"),
        };
  await mkdir(dirname(config.setupConfigFile), { recursive: true });
  const temporaryPath = `${config.setupConfigFile}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporaryPath, config.setupConfigFile);
};

export const createSetupActions = (
  config: ServerConfig,
  request: CompleteSetupRequest,
): SetupActions => {
  const connections = resolveConnections(config, request);
  return {
    administratorExists: async () => {
      const connection = await createConnection(
        mysqlOptions(connections.mysql),
      );
      try {
        const database = drizzle(connection);
        const existing = await database
          .select({ id: users.id })
          .from(users)
          .where(eq(users.role, "admin"))
          .limit(1);
        return existing.length === 1;
      } finally {
        await connection.end();
      }
    },
    ensureAdministrator: async (administrator, idempotencyKey) => {
      const connection = await createConnection(
        mysqlOptions(connections.mysql),
      );
      try {
        const database = drizzle(connection);
        const normalizedIdentifier = normalizeIdentifier(
          administrator.identifierType,
          administrator.identifier,
        );
        const passwordHash = await hashPassword(administrator.password);
        const now = mysqlDateTime(new Date());
        await database.transaction(async (transaction) => {
          const idempotencySetting = await transaction
            .select({ value: systemSettings.value })
            .from(systemSettings)
            .where(eq(systemSettings.key, "setup_admin_idempotency"))
            .limit(1);
          if (idempotencySetting.length === 1) {
            if (idempotencySetting[0]?.value === idempotencyKey) {
              return;
            }
            throw new Error("setup_administrator_already_exists");
          }
          const existingAdministrator = await transaction
            .select({ id: users.id })
            .from(users)
            .where(eq(users.role, "admin"))
            .limit(1);
          if (existingAdministrator.length > 0) {
            throw new Error("setup_administrator_already_exists");
          }
          const userId = randomUUID();
          await transaction.insert(users).values({
            createdAt: now,
            displayIdentifier: normalizedIdentifier,
            id: userId,
            identifierType: administrator.identifierType,
            mustChangePassword: false,
            normalizedIdentifier,
            passwordHash,
            role: "admin",
            status: "active",
            updatedAt: now,
            webauthnUserHandle: randomBytes(32),
          });
          await transaction.insert(systemSettings).values([
            {
              key: "registration_mode",
              updatedAt: now,
              updatedByUserId: userId,
              value: "closed",
            },
            {
              key: "setup_admin_idempotency",
              updatedAt: now,
              updatedByUserId: userId,
              value: idempotencyKey,
            },
          ]);
          await transaction.insert(installationRecords).values({
            deploymentMode: config.deploymentMode,
            fencingToken: 1,
            id: "primary",
            installedAt: now,
            schemaVersion: "0000",
            state: "installed",
            updatedAt: now,
          });
        });
      } finally {
        await connection.end();
      }
    },
    migrate: async () => {
      const connection = await createConnection(
        mysqlOptions(connections.mysql),
      );
      try {
        await migrate(drizzle(connection), {
          migrationsFolder: config.migrationsFolder,
        });
      } finally {
        await connection.end();
      }
    },
    stageConfiguration: async () =>
      writeSetupConfiguration(config, connections),
    testConnections: async () => {
      const [mysqlResult, redisResult] = await Promise.all([
        testDataServiceConnection({
          connection: connections.mysql,
          service: "mysql",
        }),
        testDataServiceConnection({
          connection: connections.redis,
          service: "redis",
        }),
      ]);
      if (!mysqlResult.ok || !redisResult.ok) {
        throw new Error("data_service_validation_failed");
      }
    },
  };
};
