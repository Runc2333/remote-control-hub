import { describe, expect, it, vi } from "vitest";
import {
  AgentConnectionCoordinator,
  type AgentConnectionRepository,
} from "../devices/agent-connection.js";
import type { DeviceRuntime } from "../devices/device-runtime.js";
import {
  DeviceConnectionRegistry,
  DeviceService,
  type DeviceRepository,
} from "../devices/device-service.js";
import { CommandRuntime } from "./command-runtime.js";
import type { CommandPersistence } from "./command-persistence.js";

const DEVICE_ID = "11111111-1111-4111-8111-111111111111";
const OWNER_ID = "22222222-2222-4222-8222-222222222222";

const createFixture = (online: boolean) => {
  const connections = new DeviceConnectionRegistry();
  const sender = vi.fn();
  if (online) {
    const generation = connections.connect(DEVICE_ID);
    connections.attachSender(DEVICE_ID, generation, sender);
  }
  const repository: DeviceRepository = {
    createEnrollmentToken: vi.fn(async () => undefined),
    deleteDevice: vi.fn(async () => undefined),
    listDevices: vi.fn(async (ownerUserId) =>
      ownerUserId === OWNER_ID
        ? [
            {
              capabilities: ["display.turn_off" as const],
              computerName: "DESKTOP-TEST",
              id: DEVICE_ID,
              ownerUserId: OWNER_ID,
              serviceVersion: "0.1.0",
              sessionVersion: "0.1.0",
            },
          ]
        : [],
    ),
    registerDevice: vi.fn(async () => DEVICE_ID),
  };
  const agentRepository: AgentConnectionRepository = {
    findAuthenticationDevice: vi.fn(async () => undefined),
    recordAuthenticated: vi.fn(async () => 1),
    recordDisconnected: vi.fn(async () => undefined),
    recordHeartbeat: vi.fn(async () => undefined),
  };
  const devices: DeviceRuntime = {
    agentConnections: new AgentConnectionCoordinator(
      agentRepository,
      connections,
    ),
    connections,
    service: new DeviceService(repository, connections),
  };
  return { devices, runtime: new CommandRuntime(devices), sender };
};

describe("command runtime", () => {
  it("sends an owned online command over the current agent connection", async () => {
    const fixture = createFixture(true);
    const batch = await fixture.runtime.createBatch(OWNER_ID, {
      commandType: "display.turn_off",
      deviceIds: [DEVICE_ID],
      idempotencyKey: "idempotency-key-0001",
    });
    const command = batch.commands[0];
    if (command === undefined) {
      throw new Error("command_missing");
    }

    expect(command.status).toBe("sent");
    expect(fixture.sender).toHaveBeenCalledWith(
      expect.objectContaining({
        commandId: command.commandId,
        type: "command.execute",
      }),
    );
    await fixture.runtime.handleAgentResult(DEVICE_ID, {
      commandId: command.commandId,
      messageSequence: 3,
      protocolVersion: 1,
      status: "accepted",
      type: "command.result",
    });
    await fixture.runtime.handleAgentResult(DEVICE_ID, {
      commandId: command.commandId,
      messageSequence: 4,
      protocolVersion: 1,
      status: "executing",
      type: "command.result",
    });
    expect(
      (
        await fixture.runtime.handleAgentResult(DEVICE_ID, {
          commandId: command.commandId,
          messageSequence: 5,
          protocolVersion: 1,
          status: "succeeded",
          type: "command.result",
        })
      ).status,
    ).toBe("succeeded");
  });

  it("fails an offline device without trying to send", async () => {
    const fixture = createFixture(false);
    const batch = await fixture.runtime.createBatch(OWNER_ID, {
      commandType: "display.turn_off",
      deviceIds: [DEVICE_ID],
      idempotencyKey: "idempotency-key-0002",
    });

    expect(batch.commands[0]).toMatchObject({
      errorCode: "device_offline",
      status: "failed",
    });
    expect(fixture.sender).not.toHaveBeenCalled();
  });

  it("restores and redelivers a non-terminal command after restart", async () => {
    const fixture = createFixture(true);
    const persistence: CommandPersistence = {
      findBatch: vi.fn(async () => undefined),
      findBatchById: vi.fn(async () => undefined),
      listBatches: vi.fn(async () => []),
      loadDeviceSequences: vi.fn(async () => [
        { deviceId: DEVICE_ID, sequence: 7 },
      ]),
      loadRecoverable: vi.fn(async () => [
        {
          batchId: "33333333-3333-4333-8333-333333333333",
          commandId: "44444444-4444-4444-8444-444444444444",
          commandType: "display.turn_off",
          createdAt: new Date().toISOString(),
          deviceId: DEVICE_ID,
          expiresAt: new Date(Date.now() + 30_000).toISOString(),
          initiatedByUserId: OWNER_ID,
          ownerUserId: OWNER_ID,
          sequence: 7,
          status: "sent",
        },
      ]),
      saveBatch: vi.fn(async () => undefined),
      updateCommand: vi.fn(async () => undefined),
    };
    const runtime = new CommandRuntime(fixture.devices, undefined, persistence);

    await runtime.onDeviceConnected(DEVICE_ID);

    expect(fixture.sender).toHaveBeenCalledWith(
      expect.objectContaining({
        commandId: "44444444-4444-4444-8444-444444444444",
        type: "command.execute",
      }),
    );
  });

  it("lists persisted batches only through the owner-scoped repository call", async () => {
    const fixture = createFixture(false);
    const listBatches = vi.fn(async () => []);
    const persistence: CommandPersistence = {
      findBatch: vi.fn(async () => undefined),
      findBatchById: vi.fn(async () => undefined),
      listBatches,
      loadDeviceSequences: vi.fn(async () => []),
      loadRecoverable: vi.fn(async () => []),
      saveBatch: vi.fn(async () => undefined),
      updateCommand: vi.fn(async () => undefined),
    };
    const runtime = new CommandRuntime(fixture.devices, undefined, persistence);

    await expect(runtime.listBatches(OWNER_ID, 50)).resolves.toEqual([]);
    expect(listBatches).toHaveBeenCalledWith(OWNER_ID, 50);
  });

  it("creates the next sequence after terminal command history", async () => {
    const fixture = createFixture(true);
    const saveBatch = vi.fn(async () => undefined);
    const persistence: CommandPersistence = {
      findBatch: vi.fn(async () => undefined),
      findBatchById: vi.fn(async () => undefined),
      listBatches: vi.fn(async () => []),
      loadDeviceSequences: vi.fn(async () => [
        { deviceId: DEVICE_ID, sequence: 12 },
      ]),
      loadRecoverable: vi.fn(async () => []),
      saveBatch,
      updateCommand: vi.fn(async () => undefined),
    };
    const runtime = new CommandRuntime(fixture.devices, undefined, persistence);

    const batch = await runtime.createBatch(OWNER_ID, {
      commandType: "display.turn_off",
      deviceIds: [DEVICE_ID],
      idempotencyKey: "idempotency-key-after-restart",
    });

    expect(batch.commands[0]?.sequence).toBe(13);
    expect(saveBatch).toHaveBeenCalledWith(
      expect.objectContaining({
        commands: [expect.objectContaining({ sequence: 13 })],
      }),
      "idempotency-key-after-restart",
    );
  });
});
