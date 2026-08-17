import type {
  AgentCommandResult,
  CreateCommandBatchRequest,
} from "@remote-control-hub/contracts";
import type { DeviceRuntime } from "../devices/device-runtime.js";
import type { ServerConfig } from "../config.js";
import {
  MySqlCommandPersistence,
  type CommandPersistence,
} from "./command-persistence.js";
import {
  CommandCoordinator,
  digestCommandRequest,
  type CoordinatedBatch,
  type CoordinatedCommand,
} from "./coordinator.js";

export type CommandStatusEvent = {
  batchId: string;
  commandId: string;
  deviceId: string;
  ownerUserId: string;
  status: CoordinatedCommand["status"];
};

export class CommandRuntime {
  readonly #coordinator: CommandCoordinator;
  readonly #devices: DeviceRuntime;
  readonly #listeners = new Set<(event: CommandStatusEvent) => void>();
  readonly #persistence: CommandPersistence | undefined;
  readonly #ready: Promise<void>;

  public constructor(
    devices: DeviceRuntime,
    coordinator = new CommandCoordinator(),
    persistence?: CommandPersistence,
  ) {
    this.#devices = devices;
    this.#coordinator = coordinator;
    this.#persistence = persistence;
    this.#ready = this.#recover();
  }

  public async createBatch(
    ownerUserId: string,
    request: CreateCommandBatchRequest,
  ): Promise<CoordinatedBatch> {
    await this.#ready;
    const existing = await this.#persistence?.findBatch(
      ownerUserId,
      request.idempotencyKey,
    );
    if (existing !== undefined) {
      if (existing.requestDigest !== digestCommandRequest(request)) {
        throw new Error("idempotency_conflict");
      }
      return existing;
    }
    const devices = await this.#devices.service.listDevices(ownerUserId);
    for (const device of devices) {
      this.#coordinator.upsertDevice({
        capabilities: device.capabilities,
        id: device.id,
        online: device.online,
        ownerUserId,
      });
    }
    const batch = this.#coordinator.createBatch(ownerUserId, request);
    await this.#persistence?.saveBatch(batch, request.idempotencyKey);
    for (const command of batch.commands) {
      this.#emit(command);
      if (command.status === "created") {
        await this.#dispatch(command.deviceId);
      }
    }
    return batch;
  }

  public async handleAgentResult(
    deviceId: string,
    result: AgentCommandResult,
  ): Promise<CoordinatedCommand> {
    await this.#ready;
    const command = this.#coordinator.handleAgentResult(
      deviceId,
      result.commandId,
      result.status,
      result.errorCode,
    );
    await this.#persistence?.updateCommand(command);
    this.#emit(command);
    if (
      command.status === "succeeded" ||
      command.status === "failed" ||
      command.status === "expired" ||
      command.status === "outcome_unknown"
    ) {
      await this.#dispatch(deviceId);
    }
    return command;
  }

  public async findBatch(
    ownerUserId: string,
    batchId: string,
  ): Promise<CoordinatedBatch | undefined> {
    await this.#ready;
    return this.#persistence?.findBatchById(ownerUserId, batchId);
  }

  public async onDeviceConnected(deviceId: string): Promise<void> {
    await this.#ready;
    await this.#dispatch(deviceId);
  }

  public subscribe(
    ownerUserId: string,
    listener: (event: CommandStatusEvent) => void,
  ): () => void {
    const filtered = (event: CommandStatusEvent): void => {
      if (event.ownerUserId === ownerUserId) {
        listener(event);
      }
    };
    this.#listeners.add(filtered);
    return () => this.#listeners.delete(filtered);
  }

  async #dispatch(deviceId: string): Promise<void> {
    const command = this.#coordinator.dispatchNext(deviceId);
    if (command === undefined) {
      return;
    }
    await this.#persistence?.updateCommand(command);
    this.#emit(command);
    const sent = this.#devices.connections.send(deviceId, {
      commandId: command.commandId,
      commandType: command.commandType,
      createdAt: command.createdAt,
      deviceId: command.deviceId,
      expiresAt: command.expiresAt,
      initiatedByUserId: command.initiatedByUserId,
      type: "command.execute",
    });
    if (!sent) {
      const failed = this.#coordinator.transition(
        command.commandId,
        "failed",
        "device_offline",
      );
      await this.#persistence?.updateCommand(failed);
      this.#emit(failed);
    }
  }

  async #recover(): Promise<void> {
    const commands = await this.#persistence?.loadRecoverable();
    if (commands === undefined) {
      return;
    }
    for (const command of commands) {
      this.#coordinator.restore(command);
    }
    for (const command of this.#coordinator.expire()) {
      await this.#persistence?.updateCommand(command);
    }
  }

  #emit(command: CoordinatedCommand): void {
    const event: CommandStatusEvent = {
      batchId: command.batchId,
      commandId: command.commandId,
      deviceId: command.deviceId,
      ownerUserId: command.ownerUserId,
      status: command.status,
    };
    for (const listener of this.#listeners) {
      listener(event);
    }
  }
}

export const createCommandRuntime = (
  devices: DeviceRuntime,
  config: ServerConfig,
): CommandRuntime =>
  new CommandRuntime(
    devices,
    new CommandCoordinator(),
    new MySqlCommandPersistence(config),
  );
