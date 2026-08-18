import { describe, expect, it } from "vitest";
import { CommandCoordinator } from "./coordinator.js";

const DEVICE_ID = "00000000-0000-4000-8000-000000000001";
const OWNER_ID = "00000000-0000-4000-8000-000000000002";

const createCoordinator = (online = true): CommandCoordinator => {
  const coordinator = new CommandCoordinator();
  coordinator.upsertDevice({
    capabilities: ["display.turn_off", "media.play_pause"],
    id: DEVICE_ID,
    online,
    ownerUserId: OWNER_ID,
  });
  return coordinator;
};

describe("CommandCoordinator", () => {
  it("returns the original batch for an identical idempotent retry", () => {
    const coordinator = createCoordinator();
    const request = {
      commandType: "display.turn_off" as const,
      deviceIds: [DEVICE_ID],
      idempotencyKey: "idempotency-key-0001",
    };

    const first = coordinator.createBatch(OWNER_ID, request);
    const second = coordinator.createBatch(OWNER_ID, request);

    expect(second.batchId).toBe(first.batchId);
    expect(() =>
      coordinator.createBatch(OWNER_ID, {
        ...request,
        commandType: "media.play_pause",
      }),
    ).toThrow("idempotency_conflict");
  });

  it("fails an offline target immediately", () => {
    const coordinator = createCoordinator(false);
    const batch = coordinator.createBatch(OWNER_ID, {
      commandType: "display.turn_off",
      deviceIds: [DEVICE_ID],
      idempotencyKey: "idempotency-key-0002",
    });

    expect(batch.commands[0]).toMatchObject({
      errorCode: "device_offline",
      status: "failed",
    });
  });

  it("requires an execution acknowledgement before success", () => {
    const coordinator = createCoordinator();
    const batch = coordinator.createBatch(OWNER_ID, {
      commandType: "display.turn_off",
      deviceIds: [DEVICE_ID],
      idempotencyKey: "idempotency-key-0003",
    });
    const command = batch.commands[0];
    if (command === undefined) {
      throw new Error("command_missing");
    }

    expect(() =>
      coordinator.transition(command.commandId, "succeeded"),
    ).toThrow("command_transition_invalid");
    coordinator.dispatchNext(DEVICE_ID);
    coordinator.transition(command.commandId, "accepted");
    coordinator.transition(command.commandId, "executing");
    expect(coordinator.transition(command.commandId, "succeeded").status).toBe(
      "succeeded",
    );
  });

  it("continues the persisted device sequence after a restart", () => {
    const coordinator = createCoordinator();
    coordinator.restoreDeviceSequence(DEVICE_ID, 7);

    const batch = coordinator.createBatch(OWNER_ID, {
      commandType: "display.turn_off",
      deviceIds: [DEVICE_ID],
      idempotencyKey: "idempotency-key-0005",
    });

    expect(batch.commands[0]?.sequence).toBe(8);
  });

  it("enforces ownership without revealing the device", () => {
    const coordinator = createCoordinator();

    expect(() =>
      coordinator.createBatch("another-owner", {
        commandType: "display.turn_off",
        deviceIds: [DEVICE_ID],
        idempotencyKey: "idempotency-key-0004",
      }),
    ).toThrow("device_not_found");
  });
});
