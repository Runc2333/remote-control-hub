import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerConfig } from "../config.js";

const MYSQL_MOCKS = vi.hoisted(() => {
  const end = vi.fn(async () => undefined);
  const query = vi.fn(async (): Promise<[unknown[], unknown[]]> => [[], []]);
  const createConnection = vi.fn(async () => ({ end, query }));
  return { createConnection, end, query };
});

vi.mock("mysql2/promise", () => ({
  createConnection: MYSQL_MOCKS.createConnection,
}));

import { MySqlCommandPersistence } from "./command-persistence.js";

const CONFIG = {
  deploymentMode: "production",
  host: "127.0.0.1",
  migrationsFolder: "migrations",
  mysqlConnection: {
    database: "remote_control_hub",
    host: "127.0.0.1",
    password: "test-password",
    port: 3306,
    tls: false,
    username: "remote_control_hub",
  },
  port: 51692,
  releaseId: "test-release",
  setupConfigFile: "setup-config.json",
  setupStateFile: "setup-state.json",
} satisfies ServerConfig;

const OWNER_ID = "11111111-1111-4111-8111-111111111111";

describe("MySqlCommandPersistence", () => {
  beforeEach(() => {
    MYSQL_MOCKS.createConnection.mockClear();
    MYSQL_MOCKS.end.mockClear();
    MYSQL_MOCKS.query.mockReset();
  });

  it("uses a parameterized text query so MySQL accepts the batch limit", async () => {
    MYSQL_MOCKS.query.mockResolvedValue([
      [
        {
          batchId: "22222222-2222-4222-8222-222222222222",
          commandId: "33333333-3333-4333-8333-333333333333",
          commandType: "display.turn_off",
          createdAt: "2026-08-18 12:00:00.000",
          deviceId: "44444444-4444-4444-8444-444444444444",
          deviceSequence: 1,
          errorCode: null,
          expiresAt: "2026-08-18 12:00:30.000",
          initiatedByUserId: OWNER_ID,
          ownerUserId: OWNER_ID,
          requestDigest: Buffer.alloc(32, 1),
          status: "succeeded",
        },
      ],
      [],
    ]);

    const result = await new MySqlCommandPersistence(CONFIG).listBatches(
      OWNER_ID,
      50,
    );

    expect(MYSQL_MOCKS.query).toHaveBeenCalledWith(
      expect.stringContaining("LIMIT ?"),
      [OWNER_ID, 50],
    );
    expect(result).toEqual([
      expect.objectContaining({
        batchId: "22222222-2222-4222-8222-222222222222",
        commands: [
          expect.objectContaining({
            commandId: "33333333-3333-4333-8333-333333333333",
            status: "succeeded",
          }),
        ],
        createdAt: "2026-08-18T12:00:00.000Z",
      }),
    ]);
    expect(MYSQL_MOCKS.end).toHaveBeenCalledOnce();
  });

  it("loads the maximum persisted sequence for every device", async () => {
    MYSQL_MOCKS.query.mockResolvedValue([
      [
        {
          deviceId: "44444444-4444-4444-8444-444444444444",
          deviceSequence: "12",
        },
      ],
      [],
    ]);

    await expect(
      new MySqlCommandPersistence(CONFIG).loadDeviceSequences(),
    ).resolves.toEqual([
      {
        deviceId: "44444444-4444-4444-8444-444444444444",
        sequence: 12,
      },
    ]);
    expect(MYSQL_MOCKS.query).toHaveBeenCalledWith(
      expect.stringContaining("MAX(device_sequence)"),
    );
    expect(MYSQL_MOCKS.end).toHaveBeenCalledOnce();
  });
});
