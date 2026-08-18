import { createHash, randomUUID } from "node:crypto";
import type {
  CommandErrorCode,
  CommandStatus,
  CreateCommandBatchRequest,
  DeviceCapability,
} from "@remote-control-hub/contracts";

export type CommandDevice = {
  capabilities: readonly DeviceCapability[];
  id: string;
  online: boolean;
  ownerUserId: string;
};

export type CoordinatedCommand = {
  batchId: string;
  commandId: string;
  commandType: DeviceCapability;
  createdAt: string;
  deviceId: string;
  errorCode?: CommandErrorCode;
  expiresAt: string;
  initiatedByUserId: string;
  ownerUserId: string;
  sequence: number;
  status: CommandStatus;
};

export type CoordinatedBatch = {
  batchId: string;
  commands: CoordinatedCommand[];
  createdAt: string;
  ownerUserId: string;
  requestDigest: string;
};

const TERMINAL_STATES: readonly CommandStatus[] = [
  "succeeded",
  "failed",
  "expired",
  "outcome_unknown",
];

const STATE_TRANSITIONS: Record<CommandStatus, readonly CommandStatus[]> = {
  created: ["sent", "failed", "expired"],
  sent: ["accepted", "failed", "expired"],
  accepted: ["executing", "failed", "expired"],
  executing: ["succeeded", "failed", "outcome_unknown"],
  succeeded: [],
  failed: [],
  expired: [],
  outcome_unknown: [],
};

export const digestCommandRequest = (
  request: CreateCommandBatchRequest,
): string =>
  createHash("sha256")
    .update(
      JSON.stringify({
        commandType: request.commandType,
        deviceIds: [...new Set(request.deviceIds)].sort(),
      }),
    )
    .digest("hex");

export class CommandCoordinator {
  readonly #batches = new Map<string, CoordinatedBatch>();
  readonly #commands = new Map<string, CoordinatedCommand>();
  readonly #devices = new Map<string, CommandDevice>();
  readonly #idempotency = new Map<string, string>();
  readonly #queues = new Map<string, string[]>();
  readonly #sequences = new Map<string, number>();

  public upsertDevice(device: CommandDevice): void {
    this.#devices.set(device.id, device);
  }

  public createBatch(
    ownerUserId: string,
    request: CreateCommandBatchRequest,
    now = new Date(),
  ): CoordinatedBatch {
    const uniqueDeviceIds = [...new Set(request.deviceIds)].sort();
    if (
      uniqueDeviceIds.length === 0 ||
      uniqueDeviceIds.length > 100 ||
      uniqueDeviceIds.length !== request.deviceIds.length
    ) {
      throw new Error("command_targets_invalid");
    }
    const requestDigest = digestCommandRequest(request);
    const idempotencyKey = `${ownerUserId}\u0000${request.idempotencyKey}`;
    const existingBatchId = this.#idempotency.get(idempotencyKey);
    if (existingBatchId !== undefined) {
      const existing = this.#batches.get(existingBatchId);
      if (existing === undefined) {
        throw new Error("command_state_invalid");
      }
      if (existing.requestDigest !== requestDigest) {
        throw new Error("idempotency_conflict");
      }
      return existing;
    }

    const batchId = randomUUID();
    const commands = uniqueDeviceIds.map((deviceId) =>
      this.#createCommand(
        batchId,
        ownerUserId,
        deviceId,
        request.commandType,
        now,
      ),
    );
    const batch = {
      batchId,
      commands,
      createdAt: now.toISOString(),
      ownerUserId,
      requestDigest,
    };
    this.#batches.set(batchId, batch);
    this.#idempotency.set(idempotencyKey, batchId);
    return batch;
  }

  public dispatchNext(deviceId: string): CoordinatedCommand | undefined {
    const queue = this.#queues.get(deviceId);
    const commandId = queue?.find((id) => {
      const status = this.#commands.get(id)?.status;
      return status !== undefined && !TERMINAL_STATES.includes(status);
    });
    if (commandId === undefined) {
      return undefined;
    }
    const command = this.#commands.get(commandId);
    if (command === undefined) {
      throw new Error("command_state_invalid");
    }
    return command.status === "created"
      ? this.transition(commandId, "sent")
      : command;
  }

  public restore(command: CoordinatedCommand): void {
    if (this.#commands.has(command.commandId)) {
      return;
    }
    this.#commands.set(command.commandId, command);
    this.#sequences.set(
      command.deviceId,
      Math.max(this.#sequences.get(command.deviceId) ?? 0, command.sequence),
    );
    if (!TERMINAL_STATES.includes(command.status)) {
      const queue = this.#queues.get(command.deviceId) ?? [];
      queue.push(command.commandId);
      queue.sort(
        (left, right) =>
          (this.#commands.get(left)?.sequence ?? 0) -
          (this.#commands.get(right)?.sequence ?? 0),
      );
      this.#queues.set(command.deviceId, queue);
    }
  }

  public restoreDeviceSequence(deviceId: string, sequence: number): void {
    if (!Number.isSafeInteger(sequence) || sequence < 1) {
      throw new Error("command_record_invalid");
    }
    this.#sequences.set(
      deviceId,
      Math.max(this.#sequences.get(deviceId) ?? 0, sequence),
    );
  }

  public handleAgentResult(
    deviceId: string,
    commandId: string,
    status: CommandStatus,
    errorCode?: CommandErrorCode,
  ): CoordinatedCommand {
    const command = this.#commands.get(commandId);
    if (command === undefined || command.deviceId !== deviceId) {
      throw new Error("command_not_found");
    }
    return this.transition(commandId, status, errorCode);
  }

  public transition(
    commandId: string,
    nextStatus: CommandStatus,
    errorCode?: CommandErrorCode,
  ): CoordinatedCommand {
    const command = this.#commands.get(commandId);
    if (command === undefined) {
      throw new Error("command_not_found");
    }
    if (!STATE_TRANSITIONS[command.status].includes(nextStatus)) {
      if (command.status === nextStatus) {
        return command;
      }
      throw new Error("command_transition_invalid");
    }
    command.status = nextStatus;
    if (errorCode === undefined) {
      delete command.errorCode;
    } else {
      command.errorCode = errorCode;
    }
    if (TERMINAL_STATES.includes(nextStatus)) {
      const queue = this.#queues.get(command.deviceId);
      if (queue !== undefined) {
        this.#queues.set(
          command.deviceId,
          queue.filter((queuedId) => queuedId !== commandId),
        );
      }
    }
    return command;
  }

  public expire(now = new Date()): CoordinatedCommand[] {
    const expired: CoordinatedCommand[] = [];
    for (const command of this.#commands.values()) {
      if (
        !TERMINAL_STATES.includes(command.status) &&
        command.expiresAt <= now.toISOString()
      ) {
        expired.push(this.transition(command.commandId, "expired"));
      }
    }
    return expired;
  }

  #createCommand(
    batchId: string,
    ownerUserId: string,
    deviceId: string,
    commandType: DeviceCapability,
    now: Date,
  ): CoordinatedCommand {
    const device = this.#devices.get(deviceId);
    if (device === undefined || device.ownerUserId !== ownerUserId) {
      throw new Error("device_not_found");
    }
    const sequence = (this.#sequences.get(deviceId) ?? 0) + 1;
    this.#sequences.set(deviceId, sequence);
    const base = {
      batchId,
      commandId: randomUUID(),
      commandType,
      createdAt: now.toISOString(),
      deviceId,
      expiresAt: new Date(now.getTime() + 30_000).toISOString(),
      initiatedByUserId: ownerUserId,
      ownerUserId,
      sequence,
    };
    if (!device.online) {
      return { ...base, errorCode: "device_offline", status: "failed" };
    }
    if (!device.capabilities.includes(commandType)) {
      return { ...base, errorCode: "unsupported", status: "failed" };
    }
    const queue = this.#queues.get(deviceId) ?? [];
    if (queue.length >= 8) {
      throw new Error("device_command_capacity_exceeded");
    }
    const command: CoordinatedCommand = { ...base, status: "created" };
    queue.push(command.commandId);
    this.#queues.set(deviceId, queue);
    this.#commands.set(command.commandId, command);
    return command;
  }
}
