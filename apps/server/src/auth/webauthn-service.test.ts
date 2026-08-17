import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
  VerifiedAuthenticationResponse,
  VerifiedRegistrationResponse,
} from "@simplewebauthn/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionMetadata } from "./session-store.js";
import type { WebauthnChallenge } from "./webauthn-challenge.js";

const mocks = vi.hoisted(() => ({
  generateAuthenticationOptions: vi.fn(),
  generateRegistrationOptions: vi.fn(),
  verifyAuthenticationResponse: vi.fn(),
  verifyRegistrationResponse: vi.fn(),
}));

vi.mock("@simplewebauthn/server", () => mocks);

const { WebauthnService } = await import("./webauthn-service.js");
type StoredWebauthnCredential =
  import("./webauthn-service.js").StoredWebauthnCredential;
type WebauthnRepository = import("./webauthn-service.js").WebauthnRepository;
type WebauthnUser = import("./webauthn-service.js").WebauthnUser;

const NOW = new Date("2026-08-17T00:00:00.000Z");
const USER: WebauthnUser = {
  displayIdentifier: "user@example.com",
  handle: new Uint8Array(32).fill(7),
  id: "user-1",
  role: "user",
  status: "active",
};
const METADATA: SessionMetadata = {
  browser: "test",
  deviceType: "desktop",
  ipAddress: "127.0.0.1",
  location: "local",
  operatingSystem: "test",
};
const CONFIGURATION = {
  origins: ["https://hub.example.com"],
  rpId: "hub.example.com",
  rpName: "Remote Control Hub",
};

class MemoryRepository implements WebauthnRepository {
  credentials: StoredWebauthnCredential[] = [];

  public async findCredential(
    credentialId: string,
  ): Promise<StoredWebauthnCredential | undefined> {
    return this.credentials.find(
      (credential) => credential.id === credentialId,
    );
  }

  public async findUser(userId: string): Promise<WebauthnUser | undefined> {
    return userId === USER.id ? USER : undefined;
  }

  public async listCredentials(
    userId: string,
  ): Promise<StoredWebauthnCredential[]> {
    return this.credentials.filter(
      (credential) => credential.user.id === userId,
    );
  }

  public async saveCredential(
    credential: StoredWebauthnCredential,
  ): Promise<void> {
    this.credentials.push(credential);
  }

  public async updateCounter(
    credentialId: string,
    previousCounter: number,
    newCounter: number,
    backedUp: boolean,
    usedAt: Date,
  ): Promise<boolean> {
    const credential = this.credentials.find(
      (candidate) =>
        candidate.id === credentialId && candidate.counter === previousCounter,
    );
    if (credential === undefined) {
      return false;
    }
    credential.counter = newCounter;
    credential.backedUp = backedUp;
    credential.lastUsedAt = usedAt.toISOString();
    return true;
  }
}

const createChallenges = () => {
  let challenge: WebauthnChallenge | undefined;
  return {
    consume: vi.fn(async () => {
      const current = challenge;
      challenge = undefined;
      return current;
    }),
    create: vi.fn(async (value: WebauthnChallenge) => {
      challenge = value;
      return "challenge-token";
    }),
  };
};

const createSessions = () => ({
  create: vi.fn(
    async (
      userId: string,
      role: "admin" | "user",
      authStrength: "passkey",
      metadata: SessionMetadata,
    ) => ({
      session: {
        ...metadata,
        absoluteExpiresAt: NOW.toISOString(),
        authStrength,
        createdAt: NOW.toISOString(),
        id: "session-1",
        idleExpiresAt: NOW.toISOString(),
        lastActiveAt: NOW.toISOString(),
        role,
        userId,
      },
      token: "session-token",
    }),
  ),
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("WebAuthn service", () => {
  it("creates discoverable registration options and stores the verified public key", async () => {
    const options = {
      challenge: "registration-challenge",
    } as unknown as PublicKeyCredentialCreationOptionsJSON;
    mocks.generateRegistrationOptions.mockResolvedValue(options);
    mocks.verifyRegistrationResponse.mockResolvedValue({
      registrationInfo: {
        credential: {
          counter: 0,
          id: "credential-1",
          publicKey: new Uint8Array([1, 2, 3]),
          transports: ["internal"],
        },
        credentialBackedUp: true,
        credentialDeviceType: "multiDevice",
      },
      verified: true,
    } as unknown as VerifiedRegistrationResponse);
    const repository = new MemoryRepository();
    const challenges = createChallenges();
    const service = new WebauthnService(
      repository,
      challenges,
      createSessions(),
      CONFIGURATION,
      () => NOW,
    );

    const begun = await service.beginRegistration(USER.id);
    const passkey = await service.completeRegistration(
      begun.token,
      USER.id,
      "Windows Hello",
      { id: "credential-1" } as unknown as RegistrationResponseJSON,
    );

    expect(begun.options).toBe(options);
    expect(mocks.generateRegistrationOptions).toHaveBeenCalledWith(
      expect.objectContaining({
        authenticatorSelection: {
          residentKey: "required",
          userVerification: "required",
        },
        rpID: CONFIGURATION.rpId,
      }),
    );
    expect(mocks.verifyRegistrationResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedChallenge: "registration-challenge",
        expectedOrigin: CONFIGURATION.origins,
        expectedRPID: CONFIGURATION.rpId,
        requireUserVerification: true,
      }),
    );
    expect(passkey).toMatchObject({
      backedUp: true,
      id: "credential-1",
      name: "Windows Hello",
    });
    expect(repository.credentials).toHaveLength(1);
  });

  it("updates the signature counter before creating a passkey session", async () => {
    const options = {
      challenge: "authentication-challenge",
    } as unknown as PublicKeyCredentialRequestOptionsJSON;
    mocks.generateAuthenticationOptions.mockResolvedValue(options);
    mocks.verifyAuthenticationResponse.mockResolvedValue({
      authenticationInfo: {
        credentialBackedUp: true,
        newCounter: 8,
      },
      verified: true,
    } as unknown as VerifiedAuthenticationResponse);
    const repository = new MemoryRepository();
    repository.credentials.push({
      backedUp: false,
      counter: 7,
      createdAt: NOW.toISOString(),
      deviceType: "singleDevice",
      id: "credential-1",
      name: "Security key",
      publicKey: new Uint8Array([1, 2, 3]),
      transports: ["usb"],
      user: USER,
    });
    const challenges = createChallenges();
    const sessions = createSessions();
    const service = new WebauthnService(
      repository,
      challenges,
      sessions,
      CONFIGURATION,
      () => NOW,
    );
    const begun = await service.beginAuthentication();

    const created = await service.completeAuthentication(
      begun.token,
      { id: "credential-1" } as unknown as AuthenticationResponseJSON,
      METADATA,
    );

    expect(created.session.authStrength).toBe("passkey");
    expect(repository.credentials[0]?.counter).toBe(8);
    expect(mocks.verifyAuthenticationResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedOrigin: CONFIGURATION.origins,
        expectedRPID: CONFIGURATION.rpId,
        requireUserVerification: true,
      }),
    );
  });

  it("rejects use when trusted RP configuration is absent", async () => {
    const service = new WebauthnService(
      new MemoryRepository(),
      createChallenges(),
      createSessions(),
      undefined,
    );

    await expect(service.beginAuthentication()).rejects.toThrow(
      "webauthn_unavailable",
    );
  });

  it("binds passkey step-up to the authenticated user", async () => {
    mocks.generateAuthenticationOptions.mockResolvedValue({
      challenge: "step-up-challenge",
    } as unknown as PublicKeyCredentialRequestOptionsJSON);
    mocks.verifyAuthenticationResponse.mockResolvedValue({
      authenticationInfo: {
        credentialBackedUp: true,
        newCounter: 2,
      },
      verified: true,
    } as unknown as VerifiedAuthenticationResponse);
    const repository = new MemoryRepository();
    repository.credentials.push({
      backedUp: false,
      counter: 1,
      createdAt: NOW.toISOString(),
      deviceType: "singleDevice",
      id: "credential-1",
      name: "Security key",
      publicKey: new Uint8Array([1, 2, 3]),
      transports: ["usb"],
      user: USER,
    });
    const challenges = createChallenges();
    const sessions = createSessions();
    const service = new WebauthnService(
      repository,
      challenges,
      sessions,
      CONFIGURATION,
      () => NOW,
    );

    const begun = await service.beginStepUp(USER.id);
    await service.completeStepUp(begun.token, USER.id, {
      id: "credential-1",
    } as unknown as AuthenticationResponseJSON);

    expect(challenges.create).toHaveBeenCalledWith({
      challenge: "step-up-challenge",
      kind: "step_up",
      userId: USER.id,
    });
    expect(repository.credentials[0]?.counter).toBe(2);
    expect(sessions.create).not.toHaveBeenCalled();
  });
});
