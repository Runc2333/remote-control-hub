import type {
  CompleteSetupRequest,
  SetupStep,
} from "@remote-control-hub/contracts";
import type { SetupState } from "./setup-state.js";

export type SetupStateRepository = {
  acquire: () => Promise<SetupState>;
  read: () => Promise<SetupState>;
  transition: (
    fencingToken: number,
    nextStep: SetupStep,
  ) => Promise<SetupState>;
};

export type SetupActions = {
  administratorExists: () => Promise<boolean>;
  ensureAdministrator: (
    administrator: CompleteSetupRequest["administrator"],
    idempotencyKey: string,
  ) => Promise<void>;
  migrate: () => Promise<void>;
  stageConfiguration: () => Promise<void>;
  testConnections: () => Promise<void>;
};

export class SetupCoordinator {
  readonly #actions: SetupActions;
  readonly #stateRepository: SetupStateRepository;

  public constructor(
    stateRepository: SetupStateRepository,
    actions: SetupActions,
  ) {
    this.#stateRepository = stateRepository;
    this.#actions = actions;
  }

  public async complete(
    request: Pick<CompleteSetupRequest, "administrator" | "idempotencyKey">,
  ): Promise<SetupState> {
    let state = await this.#stateRepository.acquire();
    if (state.step === "installed") {
      return state;
    }
    if (state.step === "unconfigured") {
      await this.#actions.testConnections();
      await this.#actions.stageConfiguration();
      state = await this.#stateRepository.transition(
        state.fencingToken,
        "config_staged",
      );
    }
    if (state.step === "config_staged") {
      state = await this.#stateRepository.transition(
        state.fencingToken,
        "migrating",
      );
    }
    if (state.step === "migrating") {
      await this.#actions.migrate();
      state = await this.#stateRepository.transition(
        state.fencingToken,
        "schema_ready",
      );
    }
    if (state.step === "schema_ready") {
      await this.#actions.ensureAdministrator(
        request.administrator,
        request.idempotencyKey,
      );
      state = await this.#stateRepository.transition(
        state.fencingToken,
        "admin_created",
      );
    }
    if (state.step === "admin_created") {
      if (!(await this.#actions.administratorExists())) {
        throw new Error("setup_administrator_missing");
      }
      state = await this.#stateRepository.transition(
        state.fencingToken,
        "installed",
      );
    }
    return state;
  }
}
