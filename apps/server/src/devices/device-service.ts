import { createHash, randomBytes } from "node:crypto";
import type {
  Device,
  DeviceCapability,
  RegisterAgentRequest,
} from "@remote-control-hub/contracts";

export type StoredDevice = {
  capabilities: DeviceCapability[];
  computerName: string;
  id: string;
  lastSeenAt?: string;
  ownerUserId: string;
  serviceVersion: string;
  sessionVersion: string;
};

export type DeviceRepository = {
  createEnrollmentToken: (
    ownerUserId: string,
    tokenHash: Buffer,
    expiresAt: string,
  ) => Promise<void>;
  listDevices: (ownerUserId: string) => Promise<StoredDevice[]>;
  registerDevice: (
    tokenHash: Buffer,
    request: Omit<RegisterAgentRequest, "enrollmentToken">,
  ) => Promise<string>;
};

export type DeviceConnectionEvent = {
  deviceId: string;
  online: boolean;
};

export class DeviceConnectionRegistry {
  readonly #connections = new Map<
    string,
    {
      close?: (reason: string) => void;
      generation: number;
      sender?: (payload: Record<string, unknown>) => void;
    }
  >();
  readonly #listeners = new Set<(event: DeviceConnectionEvent) => void>();
  readonly #maximumConnections: number;

  public constructor(maximumConnections = 500) {
    this.#maximumConnections = maximumConnections;
  }

  public connect(deviceId: string, persistedGeneration?: number): number {
    if (
      !this.#connections.has(deviceId) &&
      this.#connections.size >= this.#maximumConnections
    ) {
      throw new Error("agent_connection_capacity_exceeded");
    }
    const currentGeneration = this.#connections.get(deviceId)?.generation ?? 0;
    const generation = persistedGeneration ?? currentGeneration + 1;
    if (
      !Number.isSafeInteger(generation) ||
      generation <= 0 ||
      generation <= currentGeneration
    ) {
      throw new Error("agent_generation_invalid");
    }
    this.#connections.set(deviceId, { generation });
    this.#emit({ deviceId, online: true });
    return generation;
  }

  public attachSender(
    deviceId: string,
    generation: number,
    sender: (payload: Record<string, unknown>) => void,
    close?: (reason: string) => void,
  ): boolean {
    if (!this.isCurrent(deviceId, generation)) {
      return false;
    }
    this.#connections.set(deviceId, {
      ...(close === undefined ? {} : { close }),
      generation,
      sender,
    });
    return true;
  }

  public forceDisconnect(deviceId: string, reason: string): boolean {
    const connection = this.#connections.get(deviceId);
    if (connection === undefined) {
      return false;
    }
    this.#connections.delete(deviceId);
    this.#emit({ deviceId, online: false });
    connection.close?.(reason);
    return true;
  }

  public disconnect(deviceId: string, generation: number): void {
    if (this.#connections.get(deviceId)?.generation === generation) {
      this.#connections.delete(deviceId);
      this.#emit({ deviceId, online: false });
    }
  }

  public isCurrent(deviceId: string, generation: number): boolean {
    return this.#connections.get(deviceId)?.generation === generation;
  }

  public isOnline(deviceId: string): boolean {
    return this.#connections.has(deviceId);
  }

  public send(deviceId: string, payload: Record<string, unknown>): boolean {
    const sender = this.#connections.get(deviceId)?.sender;
    if (sender === undefined) {
      return false;
    }
    sender(payload);
    return true;
  }

  public subscribe(
    listener: (event: DeviceConnectionEvent) => void,
  ): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #emit(event: DeviceConnectionEvent): void {
    for (const listener of this.#listeners) {
      listener(event);
    }
  }
}

export class DeviceService {
  readonly #connections: DeviceConnectionRegistry;
  readonly #now: () => Date;
  readonly #repository: DeviceRepository;

  public constructor(
    repository: DeviceRepository,
    connections: DeviceConnectionRegistry,
    now: () => Date = () => new Date(),
  ) {
    this.#repository = repository;
    this.#connections = connections;
    this.#now = now;
  }

  public async createEnrollmentToken(ownerUserId: string): Promise<{
    expiresAt: string;
    token: string;
  }> {
    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(
      this.#now().getTime() + 10 * 60 * 1_000,
    ).toISOString();
    await this.#repository.createEnrollmentToken(
      ownerUserId,
      createHash("sha256").update(token, "utf8").digest(),
      expiresAt,
    );
    return { expiresAt, token };
  }

  public async listDevices(ownerUserId: string): Promise<Device[]> {
    return (await this.#repository.listDevices(ownerUserId)).map((device) => ({
      capabilities: device.capabilities,
      computerName: device.computerName,
      id: device.id,
      ...(device.lastSeenAt === undefined
        ? {}
        : { lastActiveAt: device.lastSeenAt }),
      online: this.#connections.isOnline(device.id),
      serviceVersion: device.serviceVersion,
      sessionVersion: device.sessionVersion,
    }));
  }

  public registerDevice(request: RegisterAgentRequest): Promise<string> {
    const { enrollmentToken, ...device } = request;
    return this.#repository.registerDevice(
      createHash("sha256").update(enrollmentToken, "utf8").digest(),
      device,
    );
  }
}
