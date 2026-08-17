import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ServerConfig } from "../config.js";
import {
  getSetupManagementStatus,
  issueSetupSecret,
} from "./setup-management.js";

type TestConfig = ServerConfig &
  Required<Pick<ServerConfig, "operationsAuditFile" | "setupSecretFile">>;

const TEMPORARY_DIRECTORIES: string[] = [];

const createConfig = async (): Promise<TestConfig> => {
  const directory = await mkdtemp(join(tmpdir(), "rch-setup-management-"));
  TEMPORARY_DIRECTORIES.push(directory);
  return {
    deploymentMode: "standalone",
    host: "127.0.0.1",
    migrationsFolder: join(directory, "migrations"),
    operationsAuditFile: join(directory, "operations-audit.jsonl"),
    port: 3000,
    releaseId: "test-release",
    setupConfigFile: join(directory, "setup-config.json"),
    setupSecretFile: join(directory, "setup-secret.json"),
    setupStateFile: join(directory, "setup-state.json"),
  };
};

afterEach(async () => {
  await Promise.all(
    TEMPORARY_DIRECTORIES.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
});

describe("setup management", () => {
  it("issues a short-lived secret and reports only its active state", async () => {
    const config = await createConfig();
    const issued = await issueSetupSecret(config, false, 60);
    const document: unknown = JSON.parse(
      await readFile(config.setupSecretFile, "utf8"),
    );

    expect(document).toMatchObject({
      digest: createHash("sha256")
        .update(issued.setupSecret, "utf8")
        .digest("hex"),
      expiresAt: issued.expiresAt,
    });
    expect(JSON.stringify(document)).not.toContain(issued.setupSecret);
    await expect(getSetupManagementStatus(config)).resolves.toMatchObject({
      deploymentMode: "standalone",
      setupSecretActive: true,
      step: "unconfigured",
    });
    expect(await readFile(config.operationsAuditFile, "utf8")).toContain(
      '"action":"setup-secret.issue"',
    );
  });

  it("requires an explicit rotation while an issued secret is active", async () => {
    const config = await createConfig();
    const first = await issueSetupSecret(config, false, 60);

    await expect(issueSetupSecret(config, false, 60)).rejects.toThrow(
      "setup_secret_already_active",
    );
    const second = await issueSetupSecret(config, true, 60);

    expect(second.setupSecret).not.toBe(first.setupSecret);
    expect(await readFile(config.operationsAuditFile, "utf8")).toContain(
      '"action":"setup-secret.rotate"',
    );
  });

  it("rejects unsafe secret lifetimes", async () => {
    const config = await createConfig();

    await expect(issueSetupSecret(config, false, 59)).rejects.toThrow(
      "setup_secret_ttl_invalid",
    );
    await expect(issueSetupSecret(config, false, 3_601)).rejects.toThrow(
      "setup_secret_ttl_invalid",
    );
  });
});
