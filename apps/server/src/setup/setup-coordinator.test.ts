import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SetupCoordinator, type SetupActions } from "./setup-coordinator.js";
import { FileSetupStateStore } from "./setup-state.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map(async (path) => rm(path, { force: true, recursive: true })),
  );
});

const createFixture = async (): Promise<{
  actions: SetupActions;
  coordinator: SetupCoordinator;
  migrate: ReturnType<typeof vi.fn<() => Promise<void>>>;
  store: FileSetupStateStore;
}> => {
  const directory = await mkdtemp(join(tmpdir(), "rch-setup-coordinator-"));
  temporaryDirectories.push(directory);
  const store = new FileSetupStateStore(
    join(directory, "setup-state.json"),
    "standalone",
  );
  let administratorExists = false;
  const migrate = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
  const actions: SetupActions = {
    administratorExists: async () => administratorExists,
    ensureAdministrator: async () => {
      administratorExists = true;
    },
    migrate,
    stageConfiguration: async () => undefined,
    testConnections: async () => undefined,
  };
  return {
    actions,
    coordinator: new SetupCoordinator(store, actions),
    migrate,
    store,
  };
};

const REQUEST = {
  administrator: {
    identifier: "admin@example.com",
    identifierType: "email" as const,
    password: "a-secure-password",
  },
  idempotencyKey: "0123456789abcdef",
};

describe("setup coordinator", () => {
  it("completes every durable setup transition", async () => {
    const fixture = await createFixture();

    const state = await fixture.coordinator.complete(REQUEST);

    expect(state.step).toBe("installed");
    expect(fixture.migrate).toHaveBeenCalledOnce();
  });

  it("resumes migration with a new fencing token after a crash", async () => {
    const fixture = await createFixture();
    fixture.migrate.mockRejectedValueOnce(new Error("migration_interrupted"));

    await expect(fixture.coordinator.complete(REQUEST)).rejects.toThrow(
      "migration_interrupted",
    );
    const interrupted = await fixture.store.read();
    expect(interrupted.step).toBe("migrating");

    const recovered = await fixture.coordinator.complete(REQUEST);
    expect(recovered.step).toBe("installed");
    expect(recovered.fencingToken).toBeGreaterThan(interrupted.fencingToken);
    expect(fixture.migrate).toHaveBeenCalledTimes(2);
  });

  it("does not mark installation complete without an administrator", async () => {
    const fixture = await createFixture();
    fixture.actions.ensureAdministrator = async () => undefined;
    const coordinator = new SetupCoordinator(fixture.store, fixture.actions);

    await expect(coordinator.complete(REQUEST)).rejects.toThrow(
      "setup_administrator_missing",
    );
    expect((await fixture.store.read()).step).toBe("admin_created");
  });
});
