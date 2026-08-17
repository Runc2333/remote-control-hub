import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { FileSetupStateStore } from "./setup-state.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map(async (directory) =>
        rm(directory, { force: true, recursive: true }),
      ),
  );
});

const createStore = async (): Promise<FileSetupStateStore> => {
  const directory = await mkdtemp(join(tmpdir(), "remote-control-hub-"));
  temporaryDirectories.push(directory);
  return new FileSetupStateStore(
    join(directory, "setup-state.json"),
    "standalone",
  );
};

describe("FileSetupStateStore", () => {
  it("fences an older installer", async () => {
    const store = await createStore();
    const first = await store.acquire();
    const second = await store.acquire();

    await expect(
      store.transition(first.fencingToken, "config_staged"),
    ).rejects.toThrow("setup_lock_lost");
    await expect(
      store.transition(second.fencingToken, "config_staged"),
    ).resolves.toMatchObject({
      step: "config_staged",
    });
  });

  it("rejects skipped states", async () => {
    const store = await createStore();
    const state = await store.acquire();

    await expect(
      store.transition(state.fencingToken, "schema_ready"),
    ).rejects.toThrow("setup_transition_invalid");
  });
});
