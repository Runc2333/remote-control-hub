import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { DeploymentMode, SetupStep } from "@remote-control-hub/contracts";

export type SetupState = {
  deploymentMode: DeploymentMode;
  fencingToken: number;
  step: SetupStep;
  updatedAt: string;
};

const TRANSITIONS: Record<SetupStep, readonly SetupStep[]> = {
  unconfigured: ["config_staged"],
  config_staged: ["migrating"],
  migrating: ["schema_ready"],
  schema_ready: ["admin_created"],
  admin_created: ["installed"],
  installed: [],
};

const isSetupState = (value: unknown): value is SetupState => {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    (record.deploymentMode === "compose" ||
      record.deploymentMode === "standalone") &&
    typeof record.fencingToken === "number" &&
    Number.isSafeInteger(record.fencingToken) &&
    typeof record.updatedAt === "string" &&
    typeof record.step === "string" &&
    Object.hasOwn(TRANSITIONS, record.step)
  );
};

export class FileSetupStateStore {
  readonly #deploymentMode: DeploymentMode;
  readonly #path: string;

  public constructor(path: string, deploymentMode: DeploymentMode) {
    this.#path = path;
    this.#deploymentMode = deploymentMode;
  }

  public async read(): Promise<SetupState> {
    try {
      const value: unknown = JSON.parse(await readFile(this.#path, "utf8"));
      if (
        !isSetupState(value) ||
        value.deploymentMode !== this.#deploymentMode
      ) {
        throw new Error("setup_state_invalid");
      }
      return value;
    } catch (error: unknown) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return this.#initialState();
      }
      throw error;
    }
  }

  public async acquire(): Promise<SetupState> {
    const current = await this.read();
    const locked = {
      ...current,
      fencingToken: current.fencingToken + 1,
      updatedAt: new Date().toISOString(),
    };
    await this.#write(locked);
    return locked;
  }

  public async transition(
    fencingToken: number,
    nextStep: SetupStep,
  ): Promise<SetupState> {
    const current = await this.read();
    if (current.fencingToken !== fencingToken) {
      throw new Error("setup_lock_lost");
    }
    if (!TRANSITIONS[current.step].includes(nextStep)) {
      throw new Error("setup_transition_invalid");
    }
    const next = {
      ...current,
      step: nextStep,
      updatedAt: new Date().toISOString(),
    };
    await this.#write(next);
    return next;
  }

  public async reconcile(
    databaseHasAdministrator: boolean,
  ): Promise<SetupState> {
    const current = await this.read();
    if (current.step === "admin_created" && databaseHasAdministrator) {
      const installed = {
        ...current,
        step: "installed" as const,
        updatedAt: new Date().toISOString(),
      };
      await this.#write(installed);
      return installed;
    }
    if (current.step === "installed" && !databaseHasAdministrator) {
      throw new Error("setup_database_inconsistent");
    }
    return current;
  }

  #initialState(): SetupState {
    return {
      deploymentMode: this.#deploymentMode,
      fencingToken: 0,
      step: "unconfigured",
      updatedAt: new Date(0).toISOString(),
    };
  }

  async #write(state: SetupState): Promise<void> {
    await mkdir(dirname(this.#path), { recursive: true });
    const temporaryPath = `${this.#path}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(state)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporaryPath, this.#path);
  }
}
