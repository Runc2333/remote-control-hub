import {
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

describe("server configuration", () => {
  it("uses port 51692 by default", () => {
    expect(loadConfig({}).port).toBe(51692);
  });

  it("creates and reuses persistent application secrets", () => {
    const directory = mkdtempSync(join(tmpdir(), "rch-config-"));
    const cookieSecretFile = join(directory, "cookie-secret");
    const setupStateFile = join(directory, "setup-state.json");
    const totpKeyringFile = join(directory, "totp-keyring.json");
    try {
      const environment = {
        COOKIE_SECRET_FILE: cookieSecretFile,
        SETUP_STATE_FILE: setupStateFile,
        TOTP_KEYRING_FILE: totpKeyringFile,
      };
      const initial = loadConfig(environment);
      const repeated = loadConfig(environment);

      expect(initial.cookieSecret).toHaveLength(64);
      expect(repeated.cookieSecret).toBe(initial.cookieSecret);
      expect(repeated.totpKeyring?.currentVersion).toBe(1);
      expect(
        Buffer.from(repeated.totpKeyring?.keys.get(1) ?? []).byteLength,
      ).toBe(32);
      expect(JSON.parse(readFileSync(totpKeyringFile, "utf8"))).toMatchObject({
        currentVersion: 1,
      });
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("refuses to recreate secrets after setup state exists", () => {
    const directory = mkdtempSync(join(tmpdir(), "rch-config-"));
    const cookieSecretFile = join(directory, "cookie-secret");
    const setupStateFile = join(directory, "setup-state.json");
    try {
      const environment = {
        COOKIE_SECRET_FILE: cookieSecretFile,
        SETUP_STATE_FILE: setupStateFile,
      };
      loadConfig(environment);
      unlinkSync(cookieSecretFile);
      writeFileSync(setupStateFile, "{}\n", "utf8");

      expect(() => loadConfig(environment)).toThrow(
        "Refusing to recreate missing secret file",
      );
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("accepts only explicit trusted proxy IP addresses and CIDRs", () => {
    const config = loadConfig({
      TRUSTED_PROXIES: JSON.stringify(["127.0.0.1", "10.0.0.0/8", "::1/128"]),
    });

    expect(config.trustedProxies).toEqual([
      "127.0.0.1",
      "10.0.0.0/8",
      "::1/128",
    ]);
    expect(() =>
      loadConfig({ TRUSTED_PROXIES: JSON.stringify(["all"]) }),
    ).toThrow("TRUSTED_PROXIES entries must be IP addresses or CIDRs");
    expect(() =>
      loadConfig({ TRUSTED_PROXIES: JSON.stringify(["10.0.0.0/99"]) }),
    ).toThrow("TRUSTED_PROXIES entries must be IP addresses or CIDRs");
  });
});
