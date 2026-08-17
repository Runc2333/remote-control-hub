import type {
  IdentifierType,
  LoginRequest,
  Session,
} from "@remote-control-hub/contracts";
import { normalizeIdentifier } from "./identifiers.js";
import { verifyPassword } from "./password.js";
import type {
  SessionManager,
  SessionMetadata,
  StoredSession,
} from "./session-store.js";

export type LoginUser = {
  id: string;
  mustChangePassword: boolean;
  passwordHash: string;
  role: "admin" | "user";
  status: "active" | "disabled" | "deleted";
  temporaryPasswordExpiresAt?: string;
  totpEnabled: boolean;
};

export type LoginUserRepository = {
  findByIdentifier: (
    identifierType: IdentifierType,
    normalizedIdentifier: string,
  ) => Promise<LoginUser | undefined>;
};

export type LoginResult =
  | {
      kind: "password_change_required";
      role: "admin" | "user";
      userId: string;
    }
  | { kind: "totp_required"; role: "admin" | "user"; userId: string }
  | {
      kind: "authenticated";
      role: "admin" | "user";
      session: StoredSession;
      token: string;
    };

const isExpired = (value: string | undefined, now: Date): boolean =>
  value !== undefined && Date.parse(value) <= now.getTime();

export class PasswordAuthService {
  readonly #dummyPasswordHash: string;
  readonly #now: () => Date;
  readonly #sessions: Pick<SessionManager, "create">;
  readonly #users: LoginUserRepository;

  public constructor(
    users: LoginUserRepository,
    sessions: Pick<SessionManager, "create">,
    dummyPasswordHash: string,
    now: () => Date = () => new Date(),
  ) {
    this.#users = users;
    this.#sessions = sessions;
    this.#dummyPasswordHash = dummyPasswordHash;
    this.#now = now;
  }

  public async login(
    request: LoginRequest,
    metadata: SessionMetadata,
  ): Promise<LoginResult> {
    const normalizedIdentifier = normalizeIdentifier(
      request.identifierType,
      request.identifier,
    );
    const user = await this.#users.findByIdentifier(
      request.identifierType,
      normalizedIdentifier,
    );
    const passwordValid = await verifyPassword(
      user?.passwordHash ?? this.#dummyPasswordHash,
      request.password,
    );
    if (user === undefined || !passwordValid || user.status !== "active") {
      throw new Error("credentials_invalid");
    }
    if (isExpired(user.temporaryPasswordExpiresAt, this.#now())) {
      throw new Error("credentials_invalid");
    }
    if (user.mustChangePassword) {
      return {
        kind: "password_change_required",
        role: user.role,
        userId: user.id,
      };
    }
    if (user.totpEnabled) {
      return { kind: "totp_required", role: user.role, userId: user.id };
    }
    const created = await this.#sessions.create(
      user.id,
      user.role,
      "password",
      metadata,
    );
    return {
      kind: "authenticated",
      role: user.role,
      session: created.session,
      token: created.token,
    };
  }
}

export const toPublicSession = (
  session: StoredSession,
  currentSessionId: string,
): Session => ({
  authStrength: session.authStrength,
  browser: session.browser,
  createdAt: session.createdAt,
  current: session.id === currentSessionId,
  deviceType: session.deviceType,
  expiresAt:
    Date.parse(session.absoluteExpiresAt) < Date.parse(session.idleExpiresAt)
      ? session.absoluteExpiresAt
      : session.idleExpiresAt,
  id: session.id,
  ipAddress: session.ipAddress,
  lastActiveAt: session.lastActiveAt,
  location: session.location,
  operatingSystem: session.operatingSystem,
  role: session.role,
});
