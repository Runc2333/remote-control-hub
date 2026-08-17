import type { FastifyRequest } from "fastify";
import { describe, expect, it } from "vitest";
import type { ServerConfig } from "../config.js";
import { SessionMetadataResolver } from "./session-metadata.js";

const CONFIG: ServerConfig = {
  deploymentMode: "standalone",
  host: "127.0.0.1",
  migrationsFolder: "apps/server/drizzle",
  port: 3000,
  releaseId: "test-release",
  setupConfigFile: "setup-config.json",
  setupStateFile: "setup-state.json",
};

describe("session metadata resolver", () => {
  it("normalizes the address and parses bounded UA metadata", async () => {
    const resolver = new SessionMetadataResolver(CONFIG);
    const request = {
      headers: {
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36",
      },
      ip: "::ffff:127.0.0.1",
    } as FastifyRequest;

    const metadata = await resolver.resolve(request);

    expect(metadata).toMatchObject({
      browser: expect.stringContaining("Chrome"),
      deviceType: "desktop",
      ipAddress: "127.0.0.1",
      location: "本机",
      operatingSystem: expect.stringContaining("Windows"),
    });
  });

  it("degrades a public address to unknown without a local database", async () => {
    const resolver = new SessionMetadataResolver(CONFIG);
    const request = {
      headers: {},
      ip: "8.8.8.8",
    } as FastifyRequest;

    await expect(resolver.resolve(request)).resolves.toMatchObject({
      ipAddress: "8.8.8.8",
      location: "未知位置",
    });
  });
});
