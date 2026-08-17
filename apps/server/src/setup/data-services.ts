import { randomUUID } from "node:crypto";
import { createConnection } from "mysql2/promise";
import { Redis } from "ioredis";
import type {
  MysqlConnection,
  RedisConnection,
  TestDataServiceResponse,
} from "@remote-control-hub/contracts";

export type DataServiceConnection =
  | { connection: MysqlConnection; service: "mysql" }
  | { connection: RedisConnection; service: "redis" };

const classifyConnectionError = (error: unknown): TestDataServiceResponse => {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return { category: "network", ok: false };
  }
  const code = String(error.code);
  if (code.includes("ENOTFOUND") || code.includes("EAI_AGAIN")) {
    return { category: "dns", ok: false };
  }
  if (
    code.includes("AUTH") ||
    code.includes("ACCESS_DENIED") ||
    code.includes("WRONGPASS")
  ) {
    return { category: "authentication", ok: false };
  }
  if (code.includes("TLS") || code.includes("CERT")) {
    return { category: "tls", ok: false };
  }
  if (code.includes("DENIED") || code.includes("NOPERM")) {
    return { category: "permissions", ok: false };
  }
  return { category: "network", ok: false };
};

const testMysql = async (
  connection: MysqlConnection,
): Promise<TestDataServiceResponse> => {
  const client = await createConnection({
    connectTimeout: 5_000,
    database: connection.database,
    host: connection.host,
    password: connection.password,
    port: connection.port,
    user: connection.username,
    ...(connection.tls ? { ssl: {} } : {}),
  });
  try {
    await client.query(
      "CREATE TEMPORARY TABLE rch_setup_permission_probe (id INT PRIMARY KEY)",
    );
    await client.query(
      "INSERT INTO rch_setup_permission_probe (id) VALUES (1)",
    );
    await client.query("SELECT id FROM rch_setup_permission_probe");
    await client.query("DROP TEMPORARY TABLE rch_setup_permission_probe");
    return { ok: true };
  } finally {
    await client.end();
  }
};

const testRedis = async (
  connection: RedisConnection,
): Promise<TestDataServiceResponse> => {
  const client = new Redis({
    connectTimeout: 5_000,
    db: connection.database,
    host: connection.host,
    lazyConnect: true,
    maxRetriesPerRequest: 0,
    password: connection.password,
    port: connection.port,
    tls: connection.tls ? {} : undefined,
    username: connection.username,
  });
  try {
    await client.connect();
    await client.ping();
    const key = `rch:setup-probe:${randomUUID()}`;
    await client.set(key, "1", "PX", 10_000);
    if ((await client.get(key)) !== "1") {
      throw new Error("redis_read_write_failed");
    }
    await client.del(key);
    await client.eval("return 1", 0);
    return { ok: true };
  } finally {
    client.disconnect(false);
  }
};

export const testDataServiceConnection = async (
  input: DataServiceConnection,
): Promise<TestDataServiceResponse> => {
  try {
    return input.service === "mysql"
      ? await testMysql(input.connection)
      : await testRedis(input.connection);
  } catch (error: unknown) {
    return classifyConnectionError(error);
  }
};
