import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  buildAgentAuthenticationPayload,
  type AgentAuthenticate,
  type AgentHello,
} from "@remote-control-hub/contracts";
import {
  AgentConnectionCoordinator,
  type AgentConnectionRepository,
} from "./agent-connection.js";
import { DeviceConnectionRegistry } from "./device-service.js";

const DEVICE_ID = "11111111-1111-4111-8111-111111111111";
const HELLO: AgentHello = {
  capabilities: ["display.turn_off"],
  deviceId: DEVICE_ID,
  messageSequence: 0,
  protocolVersion: 1,
  serviceVersion: "0.1.0",
  sessionVersion: "0.1.0",
  type: "agent.hello",
};

const createFixture = (active = true) => {
  const keys = generateKeyPairSync("ed25519");
  const publicDer = keys.publicKey.export({ format: "der", type: "spki" });
  const publicKey = Buffer.from(publicDer).subarray(-32);
  let nextGeneration = 0;
  const recordAuthenticated = vi.fn(async () => {
    nextGeneration += 1;
    return nextGeneration;
  });
  const recordDisconnected = vi.fn(async () => undefined);
  const recordHeartbeat = vi.fn(async () => undefined);
  const repository: AgentConnectionRepository = {
    findAuthenticationDevice: async (deviceId) =>
      deviceId === DEVICE_ID
        ? { active, deleted: false, id: deviceId, publicKey }
        : undefined,
    recordAuthenticated,
    recordDisconnected,
    recordHeartbeat,
  };
  const connections = new DeviceConnectionRegistry();
  const coordinator = new AgentConnectionCoordinator(
    repository,
    connections,
    () => new Date("2026-08-17T00:00:00.000+08:00"),
  );
  return {
    connections,
    coordinator,
    privateKey: keys.privateKey,
    recordAuthenticated,
    recordDisconnected,
    recordHeartbeat,
  };
};

const authenticateMessage = async (
  fixture: ReturnType<typeof createFixture>,
): Promise<AgentAuthenticate> => {
  const challenge = await fixture.coordinator.begin(HELLO);
  const payload = buildAgentAuthenticationPayload(challenge);
  return {
    deviceId: challenge.deviceId,
    expiresAt: challenge.expiresAt,
    messageSequence: 1,
    nonce: challenge.nonce,
    protocolVersion: 1,
    sessionId: challenge.sessionId,
    signature: sign(
      null,
      Buffer.from(payload, "utf8"),
      fixture.privateKey,
    ).toString("base64url"),
    type: "agent.authenticate",
  };
};

describe("agent connection coordinator", () => {
  it("authenticates an Ed25519 challenge once and records the generation", async () => {
    const fixture = createFixture();
    const message = await authenticateMessage(fixture);

    const connection = await fixture.coordinator.authenticate(
      message,
      "127.0.0.1",
    );

    expect(
      fixture.connections.isCurrent(DEVICE_ID, connection.generation),
    ).toBe(true);
    expect(fixture.recordAuthenticated).toHaveBeenCalledWith(
      HELLO,
      "127.0.0.1",
      message.sessionId,
    );
    await expect(
      fixture.coordinator.authenticate(message, "127.0.0.1"),
    ).rejects.toThrow("device_authentication_failed");
  });

  it("rejects a signature from another key", async () => {
    const fixture = createFixture();
    const message = await authenticateMessage(fixture);
    const other = generateKeyPairSync("ed25519");
    message.signature = sign(
      null,
      Buffer.from(buildAgentAuthenticationPayload(message), "utf8"),
      other.privateKey,
    ).toString("base64url");

    await expect(
      fixture.coordinator.authenticate(message, "127.0.0.1"),
    ).rejects.toThrow("device_authentication_failed");
    expect(fixture.connections.isOnline(DEVICE_ID)).toBe(false);
  });

  it("authenticates unregistration for an inactive device", async () => {
    const fixture = createFixture(false);
    const challenge = await fixture.coordinator.beginUnregistration(HELLO);
    const message: AgentAuthenticate = {
      deviceId: challenge.deviceId,
      expiresAt: challenge.expiresAt,
      messageSequence: 1,
      nonce: challenge.nonce,
      protocolVersion: 1,
      sessionId: challenge.sessionId,
      signature: sign(
        null,
        Buffer.from(buildAgentAuthenticationPayload(challenge), "utf8"),
        fixture.privateKey,
      ).toString("base64url"),
      type: "agent.authenticate",
    };

    expect(fixture.coordinator.authenticateUnregistration(message)).toBe(
      DEVICE_ID,
    );
    await expect(fixture.coordinator.begin(HELLO)).rejects.toThrow(
      "device_authentication_failed",
    );
  });

  it("does not let a stale generation disconnect the replacement", async () => {
    const fixture = createFixture();
    const first = await fixture.coordinator.authenticate(
      await authenticateMessage(fixture),
      "127.0.0.1",
    );
    const second = await fixture.coordinator.authenticate(
      await authenticateMessage(fixture),
      "127.0.0.1",
    );

    await fixture.coordinator.disconnect(first, "replaced");

    expect(fixture.connections.isCurrent(DEVICE_ID, second.generation)).toBe(
      true,
    );
    expect(fixture.recordDisconnected).toHaveBeenCalledWith(
      first.sessionId,
      "replaced",
    );
  });

  it("accepts only increasing heartbeats from the current generation", async () => {
    const fixture = createFixture();
    const connection = await fixture.coordinator.authenticate(
      await authenticateMessage(fixture),
      "127.0.0.1",
    );
    const heartbeat = {
      deviceId: DEVICE_ID,
      messageSequence: 2,
      protocolVersion: 1 as const,
      sentAt: "2026-08-17T00:00:01.000+08:00",
      type: "agent.heartbeat" as const,
    };

    await fixture.coordinator.heartbeat(connection, heartbeat);

    expect(fixture.recordHeartbeat).toHaveBeenCalledWith(
      DEVICE_ID,
      connection.sessionId,
    );
    await expect(
      fixture.coordinator.heartbeat(connection, heartbeat),
    ).rejects.toThrow("agent_heartbeat_invalid");
  });
});
