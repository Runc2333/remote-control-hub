import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readTotpKeyringFile } from "./totp-key-rotation.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map(async (path) => rm(path, { recursive: true })),
  );
});

describe("TOTP key rotation", () => {
  it("reads a versioned keyring without exposing or changing key bytes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rch-totp-keyring-"));
    directories.push(directory);
    const path = join(directory, "keyring.json");
    const first = randomBytes(32);
    const second = randomBytes(32);
    await writeFile(
      path,
      JSON.stringify({
        currentVersion: 2,
        keys: { 1: first.toString("base64"), 2: second.toString("base64") },
      }),
    );

    const keyring = await readTotpKeyringFile(path);

    expect(keyring.currentVersion).toBe(2);
    expect(Buffer.from(keyring.keys.get(1) ?? []).equals(first)).toBe(true);
    expect(Buffer.from(keyring.keys.get(2) ?? []).equals(second)).toBe(true);
  });

  it("rejects malformed key material", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rch-totp-keyring-"));
    directories.push(directory);
    const path = join(directory, "keyring.json");
    await writeFile(
      path,
      JSON.stringify({ currentVersion: 1, keys: { 1: "not-a-key" } }),
    );

    await expect(readTotpKeyringFile(path)).rejects.toThrow(
      "totp_keyring_file_invalid",
    );
  });
});
