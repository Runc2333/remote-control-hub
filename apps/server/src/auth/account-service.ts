import { randomBytes } from "node:crypto";
import type {
  AdminCreateUserRequest,
  IdentifierType,
  RegisterRequest,
  RegistrationMode,
  UserRole,
} from "@remote-control-hub/contracts";
import { normalizeIdentifier } from "./identifiers.js";
import { hashPassword, verifyPassword } from "./password.js";
import type {
  CreatedSession,
  SessionManager,
  SessionMetadata,
} from "./session-store.js";
import type { TemporaryPasswordManager } from "./temporary-password.js";

export type AccountUser = {
  displayIdentifier: string;
  id: string;
  passwordHash: string;
  role: UserRole;
  status: "active" | "disabled" | "deleted";
};

export type NewAccountUser = {
  displayIdentifier: string;
  identifierType: IdentifierType;
  normalizedIdentifier: string;
  passwordHash: string;
  temporaryPasswordExpiresAt?: string;
  mustChangePassword: boolean;
};

export type AccountRepository = {
  createUser: (user: NewAccountUser) => Promise<string>;
  findById: (userId: string) => Promise<AccountUser | undefined>;
  getRegistrationMode: () => Promise<RegistrationMode>;
  invalidateTemporaryPassword: (userId: string) => Promise<boolean>;
  setRegistrationMode: (
    actorUserId: string,
    mode: RegistrationMode,
  ) => Promise<void>;
  updatePassword: (userId: string, passwordHash: string) => Promise<void>;
};

type AccountSessions = Pick<SessionManager, "create" | "revokeAll">;

export class AccountService {
  readonly #now: () => Date;
  readonly #repository: AccountRepository;
  readonly #sessions: AccountSessions;
  readonly #temporaryPasswords: Pick<
    TemporaryPasswordManager,
    "consume" | "create"
  >;

  public constructor(
    repository: AccountRepository,
    sessions: AccountSessions,
    temporaryPasswords: Pick<TemporaryPasswordManager, "consume" | "create">,
    now: () => Date = () => new Date(),
  ) {
    this.#repository = repository;
    this.#sessions = sessions;
    this.#temporaryPasswords = temporaryPasswords;
    this.#now = now;
  }

  public async createTemporaryUser(request: AdminCreateUserRequest): Promise<{
    temporaryPassword: string;
    temporaryPasswordExpiresAt: string;
    userId: string;
  }> {
    const normalizedIdentifier = normalizeIdentifier(
      request.identifierType,
      request.identifier,
    );
    const temporaryPassword = randomBytes(24).toString("base64url");
    const temporaryPasswordExpiresAt = new Date(
      this.#now().getTime() + 24 * 60 * 60 * 1_000,
    ).toISOString();
    const userId = await this.#repository.createUser({
      displayIdentifier: normalizedIdentifier,
      identifierType: request.identifierType,
      mustChangePassword: true,
      normalizedIdentifier,
      passwordHash: await hashPassword(temporaryPassword),
      temporaryPasswordExpiresAt,
    });
    return { temporaryPassword, temporaryPasswordExpiresAt, userId };
  }

  public getRegistrationMode(): Promise<RegistrationMode> {
    return this.#repository.getRegistrationMode();
  }

  public async getTotpLabel(userId: string): Promise<string> {
    const user = await this.#repository.findById(userId);
    if (user === undefined || user.status !== "active") {
      throw new Error("user_not_found");
    }
    return user.displayIdentifier;
  }

  public async verifyCurrentPassword(
    userId: string,
    password: string,
  ): Promise<void> {
    const user = await this.#repository.findById(userId);
    if (
      user === undefined ||
      user.status !== "active" ||
      !(await verifyPassword(user.passwordHash, password))
    ) {
      throw new Error("credentials_invalid");
    }
  }

  public async beginTemporaryPasswordChange(
    userId: string,
    role: UserRole,
  ): Promise<string> {
    if (!(await this.#repository.invalidateTemporaryPassword(userId))) {
      throw new Error("temporary_password_invalid");
    }
    return this.#temporaryPasswords.create({ role, userId });
  }

  public async register(request: RegisterRequest): Promise<string> {
    if ((await this.#repository.getRegistrationMode()) !== "open") {
      throw new Error("registration_closed");
    }
    const normalizedIdentifier = normalizeIdentifier(
      request.identifierType,
      request.identifier,
    );
    return this.#repository.createUser({
      displayIdentifier: normalizedIdentifier,
      identifierType: request.identifierType,
      mustChangePassword: false,
      normalizedIdentifier,
      passwordHash: await hashPassword(request.password),
    });
  }

  public setRegistrationMode(
    actorUserId: string,
    mode: RegistrationMode,
  ): Promise<void> {
    return this.#repository.setRegistrationMode(actorUserId, mode);
  }

  public async changePassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
    metadata: SessionMetadata,
  ): Promise<CreatedSession> {
    const user = await this.#repository.findById(userId);
    if (
      user === undefined ||
      user.status !== "active" ||
      !(await verifyPassword(user.passwordHash, currentPassword))
    ) {
      throw new Error("credentials_invalid");
    }
    if (await verifyPassword(user.passwordHash, newPassword)) {
      throw new Error("password_unchanged");
    }
    const passwordHash = await hashPassword(newPassword);
    await this.#repository.updatePassword(userId, passwordHash);
    await this.#sessions.revokeAll(userId);
    return this.#sessions.create(userId, user.role, "password", metadata);
  }

  public async completeTemporaryPasswordChange(
    token: string,
    newPassword: string,
    metadata: SessionMetadata,
  ): Promise<CreatedSession> {
    const challenge = await this.#temporaryPasswords.consume(token);
    if (challenge === undefined) {
      throw new Error("temporary_password_invalid");
    }
    await this.#repository.updatePassword(
      challenge.userId,
      await hashPassword(newPassword),
    );
    await this.#sessions.revokeAll(challenge.userId);
    return this.#sessions.create(
      challenge.userId,
      challenge.role,
      "password",
      metadata,
    );
  }
}
