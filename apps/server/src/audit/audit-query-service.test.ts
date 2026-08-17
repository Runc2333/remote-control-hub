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

import { AuditQueryService } from "./audit-query-service.js";

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

describe("AuditQueryService", () => {
  beforeEach(() => {
    MYSQL_MOCKS.createConnection.mockClear();
    MYSQL_MOCKS.end.mockClear();
    MYSQL_MOCKS.query.mockReset();
  });

  it("uses a parameterized text query so MySQL accepts the limit", async () => {
    MYSQL_MOCKS.query.mockResolvedValue([
      [
        {
          action: "agent.connect",
          actorId: "device-1",
          actorType: "agent",
          errorCategory: null,
          id: "event-1",
          occurredAt: "2026-08-17 14:00:00.000",
          requestId: "req-1",
          result: "success",
          sourceAddressClass: "private",
          subjectId: "session-1",
          subjectType: "device_session",
          visibility: "system",
        },
      ],
      [],
    ]);

    const result = await new AuditQueryService(CONFIG).listAdmin({ limit: 30 });

    expect(MYSQL_MOCKS.query).toHaveBeenCalledWith(
      expect.stringContaining("LIMIT ?"),
      [31],
    );
    expect(result.events).toEqual([
      expect.objectContaining({
        id: "event-1",
        occurredAt: "2026-08-17T14:00:00.000Z",
      }),
    ]);
    expect(MYSQL_MOCKS.end).toHaveBeenCalledOnce();
  });
});
