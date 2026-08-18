import { describe, expect, it, vi } from "vitest";
import type { RegisterAgentRequest } from "@remote-control-hub/contracts";
import {
  DeviceConnectionRegistry,
  DeviceService,
  type DeviceRepository,
  type StoredDevice,
} from "./device-service.js";

class MemoryDeviceRepository implements DeviceRepository {
  readonly devices: StoredDevice[] = [];
  readonly tokens = new Map<
    string,
    { expiresAt: string; ownerUserId: string }
  >();

  public async createEnrollmentToken(
    ownerUserId: string,
    tokenHash: Buffer,
    expiresAt: string,
  ): Promise<void> {
    this.tokens.set(tokenHash.toString("hex"), { expiresAt, ownerUserId });
  }

  public async listDevices(ownerUserId: string): Promise<StoredDevice[]> {
    return this.devices.filter((device) => device.ownerUserId === ownerUserId);
  }

  public async deleteDevice(
    deviceId: string,
    ownerUserId: string | undefined,
  ): Promise<void> {
    const index = this.devices.findIndex(
      (device) =>
        device.id === deviceId &&
        (ownerUserId === undefined || device.ownerUserId === ownerUserId),
    );
    if (index === -1) {
      throw new Error("device_not_found");
    }
    this.devices.splice(index, 1);
  }

  public async registerDevice(
    tokenHash: Buffer,
    request: Omit<RegisterAgentRequest, "enrollmentToken">,
  ): Promise<string> {
    const key = tokenHash.toString("hex");
    const enrollment = this.tokens.get(key);
    if (enrollment === undefined) {
      throw new Error("enrollment_token_invalid");
    }
    this.tokens.delete(key);
    const id = "11111111-1111-4111-8111-111111111111";
    this.devices.push({
      capabilities: request.capabilities,
      computerName: request.computerName,
      id,
      ownerUserId: enrollment.ownerUserId,
      serviceVersion: request.serviceVersion,
      sessionVersion: request.sessionVersion,
    });
    return id;
  }
}

const REGISTRATION: RegisterAgentRequest = {
  capabilities: ["display.turn_off", "media.play_pause"],
  computerName: "DESKTOP-TEST",
  enrollmentToken: "A".repeat(43),
  platform: "windows",
  publicKey: "B".repeat(43),
  serviceVersion: "0.1.0",
  sessionVersion: "0.1.0",
};

describe("device service", () => {
  it("binds a single-use enrollment token to its owner", async () => {
    const repository = new MemoryDeviceRepository();
    const service = new DeviceService(
      repository,
      new DeviceConnectionRegistry(),
      () => new Date("2026-08-17T00:00:00.000+08:00"),
    );
    const enrollment = await service.createEnrollmentToken("owner-1");

    const deviceId = await service.registerDevice({
      ...REGISTRATION,
      enrollmentToken: enrollment.token,
    });

    expect(enrollment.expiresAt).toBe("2026-08-16T16:10:00.000Z");
    expect(repository.devices[0]).toMatchObject({
      id: deviceId,
      ownerUserId: "owner-1",
    });
    await expect(
      service.registerDevice({
        ...REGISTRATION,
        enrollmentToken: enrollment.token,
      }),
    ).rejects.toThrow("enrollment_token_invalid");
  });

  it("derives online state only from the current connection generation", async () => {
    const repository = new MemoryDeviceRepository();
    repository.devices.push({
      capabilities: REGISTRATION.capabilities,
      computerName: REGISTRATION.computerName,
      id: "11111111-1111-4111-8111-111111111111",
      lastSeenAt: "2026-08-16T16:00:00.000Z",
      ownerUserId: "owner-1",
      serviceVersion: REGISTRATION.serviceVersion,
      sessionVersion: REGISTRATION.sessionVersion,
    });
    const connections = new DeviceConnectionRegistry();
    const service = new DeviceService(repository, connections);
    const device = repository.devices[0];
    if (device === undefined) {
      throw new Error("device_missing");
    }

    const first = connections.connect(device.id);
    const second = connections.connect(device.id);
    connections.disconnect(device.id, first);
    expect((await service.listDevices("owner-1"))[0]?.online).toBe(true);
    connections.disconnect(device.id, second);
    expect((await service.listDevices("owner-1"))[0]?.online).toBe(false);
    expect(await service.listDevices("another-owner")).toEqual([]);
  });

  it("deletes an owned device and forcibly disconnects it", async () => {
    const repository = new MemoryDeviceRepository();
    repository.devices.push({
      capabilities: REGISTRATION.capabilities,
      computerName: REGISTRATION.computerName,
      id: "11111111-1111-4111-8111-111111111111",
      ownerUserId: "owner-1",
      serviceVersion: REGISTRATION.serviceVersion,
      sessionVersion: REGISTRATION.sessionVersion,
    });
    const connections = new DeviceConnectionRegistry();
    const close = vi.fn();
    const device = repository.devices[0];
    if (device === undefined) {
      throw new Error("device_missing");
    }
    const generation = connections.connect(device.id);
    connections.attachSender(device.id, generation, vi.fn(), close);
    const service = new DeviceService(repository, connections);

    await service.deleteDevice("owner-1", device.id);

    expect(repository.devices).toEqual([]);
    expect(close).toHaveBeenCalledWith("device_deleted");
  });

  it("publishes status changes only for the effective generation", () => {
    const connections = new DeviceConnectionRegistry();
    const events: { deviceId: string; online: boolean }[] = [];
    const unsubscribe = connections.subscribe((event) => events.push(event));

    const first = connections.connect("device-1");
    const second = connections.connect("device-1");
    connections.disconnect("device-1", first);
    connections.disconnect("device-1", second);
    unsubscribe();
    connections.connect("device-2");

    expect(events).toEqual([
      { deviceId: "device-1", online: true },
      { deviceId: "device-1", online: true },
      { deviceId: "device-1", online: false },
    ]);
  });

  it("accepts a persisted generation after restart and rejects stale values", () => {
    const connections = new DeviceConnectionRegistry();

    expect(connections.connect("device-1", 42)).toBe(42);
    expect(() => connections.connect("device-1", 42)).toThrow(
      "agent_generation_invalid",
    );
    expect(connections.connect("device-1", 43)).toBe(43);
  });

  it("forcibly closes and removes an active connection", () => {
    const connections = new DeviceConnectionRegistry();
    const close = vi.fn();
    const generation = connections.connect("device-1");
    connections.attachSender("device-1", generation, vi.fn(), close);

    expect(connections.forceDisconnect("device-1", "device_disabled")).toBe(
      true,
    );
    expect(close).toHaveBeenCalledWith("device_disabled");
    expect(connections.isOnline("device-1")).toBe(false);
    expect(connections.forceDisconnect("device-1", "duplicate")).toBe(false);
  });
});
