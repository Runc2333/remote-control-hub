import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AGENT_HELLO_SCHEMA,
  buildAgentAuthenticationPayload,
  type AgentChallenge,
  type AgentHello,
} from "@remote-control-hub/contracts";
import Value from "typebox/value";
import { buildApp } from "../app.js";
import { CommandRuntime } from "../commands/command-runtime.js";
import type { ServerConfig } from "../config.js";
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

const DEVICE_ID = "11111111-1111-4111-8111-111111111111";
const OWNER_ID = "22222222-2222-4222-8222-222222222222";
const apps: ReturnType<typeof buildApp>[] = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map(async (app) => app.close()));
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map(async (path) => rm(path, { force: true, recursive: true })),
  );
});

const createConfig = async (): Promise<ServerConfig> => {
  const directory = await mkdtemp(join(tmpdir(), "rch-device-routes-"));
  temporaryDirectories.push(directory);
  const setupStateFile = join(directory, "setup-state.json");
  await writeFile(
    setupStateFile,
    `${JSON.stringify({
      deploymentMode: "standalone",
      fencingToken: 1,
      step: "installed",
      updatedAt: "2026-08-17T00:00:00.000+08:00",
    })}\n`,
  );
  return {
    appOrigin: "https://hub.example.com",
    cookieSecret: "0123456789abcdef0123456789abcdef",
    deploymentMode: "standalone",
    host: "127.0.0.1",
    migrationsFolder: "apps/server/drizzle",
    mysqlConnection: {
      database: "remote_control_hub",
      host: "127.0.0.1",
      password: "database-password",
      port: 3306,
      tls: true,
      username: "remote_control_hub",
    },
    port: 3000,
    redisConnection: {
      database: 0,
      host: "127.0.0.1",
      password: "redis-password",
      port: 6379,
      tls: true,
    },
    releaseId: "test-release",
    setupConfigFile: join(directory, "setup-config.json"),
    setupStateFile,
  };
};

const createRuntime = () => {
  const keys = generateKeyPairSync("ed25519");
  const publicDer = keys.publicKey.export({ format: "der", type: "spki" });
  const recordAuthenticated = vi.fn(async () => undefined);
  const recordHeartbeat = vi.fn(async () => undefined);
  const agentRepository: AgentConnectionRepository = {
    findAuthenticationDevice: async () => ({
      active: true,
      id: DEVICE_ID,
      publicKey: Buffer.from(publicDer).subarray(-32),
    }),
    recordAuthenticated,
    recordDisconnected: vi.fn(async () => undefined),
    recordHeartbeat,
  };
  const deviceRepository: DeviceRepository = {
    createEnrollmentToken: vi.fn(async () => undefined),
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
  const connections = new DeviceConnectionRegistry();
  const runtime: DeviceRuntime = {
    admin: {
      delete: vi.fn(async () => undefined),
      list: vi.fn(async () => []),
      revokeCredentials: vi.fn(async () => undefined),
      setDisabled: vi.fn(async () => undefined),
    },
    agentConnections: new AgentConnectionCoordinator(
      agentRepository,
      connections,
      () => new Date("2026-08-17T00:00:00.000+08:00"),
    ),
    connections,
    service: new DeviceService(deviceRepository, connections),
  };
  const commands = new CommandRuntime(runtime);
  return {
    commands,
    privateKey: keys.privateKey,
    recordAuthenticated,
    recordHeartbeat,
    runtime,
  };
};

type InjectedSocket = Awaited<
  ReturnType<ReturnType<typeof buildApp>["injectWS"]>
>;

const nextMessage = (socket: InjectedSocket): Promise<string> =>
  new Promise((resolve, reject) => {
    socket.once("message", (data) => resolve(data.toString()));
    socket.once("close", (code, reason) =>
      reject(new Error(`socket_closed_${code}_${reason.toString()}`)),
    );
    socket.once("error", reject);
  });

describe("device routes", () => {
  it("completes the websocket challenge and returns a connection generation", async () => {
    const fixture = createRuntime();
    const app = buildApp(await createConfig(), {
      createAuditService: () => ({ record: vi.fn(async () => undefined) }),
      createCommandRuntime: () => fixture.commands,
      createDeviceRuntime: () => fixture.runtime,
    });
    apps.push(app);
    await app.ready();
    const socket = await app.injectWS("/api/v1/agent/connect");
    const hello: AgentHello = {
      capabilities: ["display.turn_off"],
      deviceId: DEVICE_ID,
      messageSequence: 0,
      protocolVersion: 1,
      serviceVersion: "0.1.0",
      sessionVersion: "0.1.0",
      type: "agent.hello",
    };
    const challengeMessage = nextMessage(socket);
    expect(Value.Check(AGENT_HELLO_SCHEMA, hello)).toBe(true);
    socket.send(JSON.stringify(hello));
    const challenge = JSON.parse(await challengeMessage) as AgentChallenge;
    const authenticatedMessage = nextMessage(socket);
    socket.send(
      JSON.stringify({
        ...challenge,
        messageSequence: 1,
        signature: sign(
          null,
          Buffer.from(buildAgentAuthenticationPayload(challenge), "utf8"),
          fixture.privateKey,
        ).toString("base64url"),
        type: "agent.authenticate",
      }),
    );

    const authenticated: unknown = JSON.parse(await authenticatedMessage);

    expect(authenticated).toMatchObject({
      deviceId: DEVICE_ID,
      generation: 1,
      protocolVersion: 1,
      type: "agent.authenticated",
    });
    expect(fixture.recordAuthenticated).toHaveBeenCalledOnce();
    const heartbeatAck = nextMessage(socket);
    socket.send(
      JSON.stringify({
        deviceId: DEVICE_ID,
        messageSequence: 2,
        protocolVersion: 1,
        sentAt: "2026-08-17T00:00:01.000+08:00",
        type: "agent.heartbeat",
      }),
    );
    await expect(heartbeatAck).resolves.toContain("agent.heartbeat_ack");
    expect(fixture.recordHeartbeat).toHaveBeenCalledOnce();
    const commandMessage = nextMessage(socket);
    const batch = await fixture.commands.createBatch(OWNER_ID, {
      commandType: "display.turn_off",
      deviceIds: [DEVICE_ID],
      idempotencyKey: "idempotency-key-0001",
    });
    const command = batch.commands[0];
    if (command === undefined) {
      throw new Error("command_missing");
    }
    await expect(commandMessage).resolves.toContain(command.commandId);
    for (const [messageSequence, status] of [
      [3, "accepted"],
      [4, "executing"],
      [5, "succeeded"],
    ] as const) {
      socket.send(
        JSON.stringify({
          commandId: command.commandId,
          messageSequence,
          protocolVersion: 1,
          status,
          type: "command.result",
        }),
      );
    }
    await vi.waitFor(() => expect(command.status).toBe("succeeded"));
    socket.terminate();
  });
});
