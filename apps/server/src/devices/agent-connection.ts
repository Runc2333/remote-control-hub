import { createPublicKey, randomBytes, randomUUID, verify } from "node:crypto";
import {
  AGENT_PROTOCOL_VERSION,
  buildAgentAuthenticationPayload,
  type AgentAuthenticate,
  type AgentChallenge,
  type AgentHello,
  type AgentHeartbeat,
} from "@remote-control-hub/contracts";
import { DeviceConnectionRegistry } from "./device-service.js";

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const CHALLENGE_TTL_MILLISECONDS = 30_000;
const MAX_PENDING_CHALLENGES = 1_000;

export type AgentAuthenticationDevice = {
  active: boolean;
  id: string;
  publicKey: Buffer;
};

export type AgentConnectionRepository = {
  findAuthenticationDevice: (
    deviceId: string,
  ) => Promise<AgentAuthenticationDevice | undefined>;
  recordAuthenticated: (
    hello: AgentHello,
    remoteAddress: string,
    sessionId: string,
  ) => Promise<number>;
  recordDisconnected: (sessionId: string, reason: string) => Promise<void>;
  recordHeartbeat: (deviceId: string, sessionId: string) => Promise<void>;
};

type PendingChallenge = {
  challenge: AgentChallenge;
  hello: AgentHello;
  publicKey: Buffer;
};

export type AuthenticatedAgentConnection = {
  deviceId: string;
  generation: number;
  lastMessageSequence: number;
  sessionId: string;
};

export class AgentConnectionCoordinator {
  readonly #connections: DeviceConnectionRegistry;
  readonly #now: () => Date;
  readonly #pending = new Map<string, PendingChallenge>();
  readonly #repository: AgentConnectionRepository;

  public constructor(
    repository: AgentConnectionRepository,
    connections: DeviceConnectionRegistry,
    now: () => Date = () => new Date(),
  ) {
    this.#repository = repository;
    this.#connections = connections;
    this.#now = now;
  }

  public async begin(hello: AgentHello): Promise<AgentChallenge> {
    this.#deleteExpired();
    if (
      hello.protocolVersion !== AGENT_PROTOCOL_VERSION ||
      hello.messageSequence !== 0
    ) {
      throw new Error("agent_hello_invalid");
    }
    if (this.#pending.size >= MAX_PENDING_CHALLENGES) {
      throw new Error("agent_challenge_capacity_exceeded");
    }
    const device = await this.#repository.findAuthenticationDevice(
      hello.deviceId,
    );
    if (
      device === undefined ||
      !device.active ||
      device.publicKey.length !== 32
    ) {
      throw new Error("device_authentication_failed");
    }
    const challenge: AgentChallenge = {
      deviceId: hello.deviceId,
      expiresAt: new Date(
        this.#now().getTime() + CHALLENGE_TTL_MILLISECONDS,
      ).toISOString(),
      messageSequence: 0,
      nonce: randomBytes(32).toString("base64url"),
      protocolVersion: AGENT_PROTOCOL_VERSION,
      sessionId: randomUUID(),
      type: "agent.challenge",
    };
    this.#pending.set(challenge.sessionId, {
      challenge,
      hello,
      publicKey: device.publicKey,
    });
    return challenge;
  }

  public async authenticate(
    message: AgentAuthenticate,
    remoteAddress: string,
  ): Promise<AuthenticatedAgentConnection> {
    const pending = this.#pending.get(message.sessionId);
    this.#pending.delete(message.sessionId);
    if (
      pending === undefined ||
      message.protocolVersion !== AGENT_PROTOCOL_VERSION ||
      message.messageSequence !== 1 ||
      message.deviceId !== pending.challenge.deviceId ||
      message.nonce !== pending.challenge.nonce ||
      message.expiresAt !== pending.challenge.expiresAt ||
      Date.parse(message.expiresAt) <= this.#now().getTime()
    ) {
      throw new Error("device_authentication_failed");
    }
    const payload = buildAgentAuthenticationPayload({
      deviceId: message.deviceId,
      expiresAt: message.expiresAt,
      nonce: message.nonce,
      sessionId: message.sessionId,
    });
    const publicKey = createPublicKey({
      format: "der",
      key: Buffer.concat([ED25519_SPKI_PREFIX, pending.publicKey]),
      type: "spki",
    });
    if (
      !verify(
        null,
        Buffer.from(payload, "utf8"),
        publicKey,
        Buffer.from(message.signature, "base64url"),
      )
    ) {
      throw new Error("device_authentication_failed");
    }
    const generation = await this.#repository.recordAuthenticated(
      pending.hello,
      remoteAddress.slice(0, 64),
      message.sessionId,
    );
    try {
      this.#connections.connect(message.deviceId, generation);
    } catch (error: unknown) {
      await this.#repository
        .recordDisconnected(message.sessionId, "connection_rejected")
        .catch(() => undefined);
      throw error;
    }
    return {
      deviceId: message.deviceId,
      generation,
      lastMessageSequence: message.messageSequence,
      sessionId: message.sessionId,
    };
  }

  public async heartbeat(
    connection: AuthenticatedAgentConnection,
    message: AgentHeartbeat,
  ): Promise<void> {
    if (
      !this.#connections.isCurrent(
        connection.deviceId,
        connection.generation,
      ) ||
      message.deviceId !== connection.deviceId ||
      message.protocolVersion !== AGENT_PROTOCOL_VERSION ||
      message.messageSequence <= connection.lastMessageSequence
    ) {
      throw new Error("agent_heartbeat_invalid");
    }
    connection.lastMessageSequence = message.messageSequence;
    await this.#repository.recordHeartbeat(
      connection.deviceId,
      connection.sessionId,
    );
  }

  public async disconnect(
    connection: AuthenticatedAgentConnection,
    reason: string,
  ): Promise<void> {
    this.#connections.disconnect(connection.deviceId, connection.generation);
    await this.#repository.recordDisconnected(
      connection.sessionId,
      reason.slice(0, 128),
    );
  }

  #deleteExpired(): void {
    const now = this.#now().getTime();
    for (const [sessionId, pending] of this.#pending) {
      if (Date.parse(pending.challenge.expiresAt) <= now) {
        this.#pending.delete(sessionId);
      }
    }
  }
}
