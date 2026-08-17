import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type AuthenticatorTransportFuture,
  type Base64URLString,
  type CredentialDeviceType,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import type { UserRole } from "@remote-control-hub/contracts";
import type { ServerConfig } from "../config.js";
import type {
  CreatedSession,
  SessionManager,
  SessionMetadata,
} from "./session-store.js";
import type { WebauthnChallengeManager } from "./webauthn-challenge.js";

export type WebauthnUser = {
  displayIdentifier: string;
  handle: Uint8Array;
  id: string;
  role: UserRole;
  status: "active" | "disabled" | "deleted";
};

export type StoredWebauthnCredential = {
  backedUp: boolean;
  counter: number;
  createdAt: string;
  deviceType: CredentialDeviceType;
  id: string;
  lastUsedAt?: string;
  name: string;
  publicKey: Uint8Array;
  transports: AuthenticatorTransportFuture[];
  user: WebauthnUser;
};

export type WebauthnRepository = {
  deleteCredential: (userId: string, credentialId: string) => Promise<boolean>;
  findCredential: (
    credentialId: string,
  ) => Promise<StoredWebauthnCredential | undefined>;
  findUser: (userId: string) => Promise<WebauthnUser | undefined>;
  listCredentials: (userId: string) => Promise<StoredWebauthnCredential[]>;
  renameCredential: (
    userId: string,
    credentialId: string,
    name: string,
  ) => Promise<boolean>;
  saveCredential: (credential: StoredWebauthnCredential) => Promise<void>;
  updateCounter: (
    credentialId: string,
    previousCounter: number,
    newCounter: number,
    backedUp: boolean,
    usedAt: Date,
  ) => Promise<boolean>;
};

export type PublicPasskey = {
  backedUp: boolean;
  createdAt: string;
  deviceType: CredentialDeviceType;
  id: string;
  lastUsedAt?: string;
  name: string;
  transports: AuthenticatorTransportFuture[];
};

type WebauthnConfiguration = NonNullable<ServerConfig["webauthn"]>;

const toPublicPasskey = (
  credential: StoredWebauthnCredential,
): PublicPasskey => ({
  backedUp: credential.backedUp,
  createdAt: credential.createdAt,
  deviceType: credential.deviceType,
  id: credential.id,
  ...(credential.lastUsedAt === undefined
    ? {}
    : { lastUsedAt: credential.lastUsedAt }),
  name: credential.name,
  transports: credential.transports,
});

export class WebauthnService {
  readonly #challenges: Pick<WebauthnChallengeManager, "consume" | "create">;
  readonly #configuration: WebauthnConfiguration | undefined;
  readonly #now: () => Date;
  readonly #repository: WebauthnRepository;
  readonly #sessions: Pick<SessionManager, "create" | "revokeByAuthenticator">;

  public constructor(
    repository: WebauthnRepository,
    challenges: Pick<WebauthnChallengeManager, "consume" | "create">,
    sessions: Pick<SessionManager, "create" | "revokeByAuthenticator">,
    configuration: WebauthnConfiguration | undefined,
    now: () => Date = () => new Date(),
  ) {
    this.#repository = repository;
    this.#challenges = challenges;
    this.#sessions = sessions;
    this.#configuration = configuration;
    this.#now = now;
  }

  public async beginAuthentication(): Promise<{
    options: PublicKeyCredentialRequestOptionsJSON;
    token: string;
  }> {
    const configuration = this.#requireConfiguration();
    const options = await generateAuthenticationOptions({
      rpID: configuration.rpId,
      timeout: 60_000,
      userVerification: "required",
    });
    return {
      options,
      token: await this.#challenges.create({
        challenge: options.challenge,
        kind: "authentication",
      }),
    };
  }

  public async beginRegistration(userId: string): Promise<{
    options: PublicKeyCredentialCreationOptionsJSON;
    token: string;
  }> {
    const configuration = this.#requireConfiguration();
    const user = await this.#repository.findUser(userId);
    if (user === undefined || user.status !== "active") {
      throw new Error("user_not_found");
    }
    const existing = await this.#repository.listCredentials(userId);
    const options = await generateRegistrationOptions({
      attestationType: "none",
      authenticatorSelection: {
        residentKey: "required",
        userVerification: "required",
      },
      excludeCredentials: existing.map((credential) => ({
        id: credential.id as Base64URLString,
        transports: credential.transports,
      })),
      rpID: configuration.rpId,
      rpName: configuration.rpName,
      timeout: 60_000,
      userDisplayName: user.displayIdentifier,
      userID: new Uint8Array(user.handle),
      userName: user.displayIdentifier,
    });
    return {
      options,
      token: await this.#challenges.create({
        challenge: options.challenge,
        kind: "registration",
        userId,
      }),
    };
  }

  public async beginStepUp(userId: string): Promise<{
    options: PublicKeyCredentialRequestOptionsJSON;
    token: string;
  }> {
    const configuration = this.#requireConfiguration();
    const user = await this.#repository.findUser(userId);
    if (user === undefined || user.status !== "active") {
      throw new Error("passkey_step_up_invalid");
    }
    const credentials = await this.#repository.listCredentials(userId);
    if (credentials.length === 0) {
      throw new Error("passkey_step_up_unavailable");
    }
    const options = await generateAuthenticationOptions({
      allowCredentials: credentials.map((credential) => ({
        id: credential.id as Base64URLString,
        transports: credential.transports,
      })),
      rpID: configuration.rpId,
      timeout: 60_000,
      userVerification: "required",
    });
    return {
      options,
      token: await this.#challenges.create({
        challenge: options.challenge,
        kind: "step_up",
        userId,
      }),
    };
  }

  public async completeAuthentication(
    token: string,
    response: AuthenticationResponseJSON,
    metadata: SessionMetadata,
  ): Promise<CreatedSession> {
    const challenge = await this.#challenges.consume(token);
    if (challenge?.kind !== "authentication") {
      throw new Error("passkey_authentication_invalid");
    }
    const credential = await this.#verifyAuthentication(
      challenge.challenge,
      response,
    );
    return this.#sessions.create(
      credential.user.id,
      credential.user.role,
      "passkey",
      metadata,
      credential.id,
    );
  }

  public async completeStepUp(
    token: string,
    userId: string,
    response: AuthenticationResponseJSON,
  ): Promise<void> {
    const challenge = await this.#challenges.consume(token);
    if (challenge?.kind !== "step_up" || challenge.userId !== userId) {
      throw new Error("passkey_step_up_invalid");
    }
    await this.#verifyAuthentication(challenge.challenge, response, userId);
  }

  public async completeRegistration(
    token: string,
    userId: string,
    name: string,
    response: RegistrationResponseJSON,
  ): Promise<PublicPasskey> {
    const configuration = this.#requireConfiguration();
    const challenge = await this.#challenges.consume(token);
    if (challenge?.kind !== "registration" || challenge.userId !== userId) {
      throw new Error("passkey_registration_invalid");
    }
    const user = await this.#repository.findUser(userId);
    if (user === undefined || user.status !== "active") {
      throw new Error("passkey_registration_invalid");
    }
    const verification = await verifyRegistrationResponse({
      expectedChallenge: challenge.challenge,
      expectedOrigin: [...configuration.origins],
      expectedRPID: configuration.rpId,
      requireUserVerification: true,
      response,
    });
    const information = verification.registrationInfo;
    if (!verification.verified || information === undefined) {
      throw new Error("passkey_registration_invalid");
    }
    const now = this.#now().toISOString();
    const credential: StoredWebauthnCredential = {
      backedUp: information.credentialBackedUp,
      counter: information.credential.counter,
      createdAt: now,
      deviceType: information.credentialDeviceType,
      id: information.credential.id,
      name: name.trim(),
      publicKey: information.credential.publicKey,
      transports: information.credential.transports ?? [],
      user,
    };
    if (credential.name.length < 1 || credential.name.length > 128) {
      throw new Error("passkey_name_invalid");
    }
    await this.#repository.saveCredential(credential);
    return toPublicPasskey(credential);
  }

  public async list(userId: string): Promise<PublicPasskey[]> {
    return (await this.#repository.listCredentials(userId)).map(
      toPublicPasskey,
    );
  }

  public async delete(userId: string, credentialId: string): Promise<void> {
    if (!(await this.#repository.deleteCredential(userId, credentialId))) {
      throw new Error("passkey_not_found");
    }
    await this.#sessions.revokeByAuthenticator(userId, credentialId);
  }

  public async rename(
    userId: string,
    credentialId: string,
    name: string,
  ): Promise<PublicPasskey> {
    const normalizedName = name.trim();
    if (normalizedName.length < 1 || normalizedName.length > 128) {
      throw new Error("passkey_name_invalid");
    }
    if (
      !(await this.#repository.renameCredential(
        userId,
        credentialId,
        normalizedName,
      ))
    ) {
      throw new Error("passkey_not_found");
    }
    const credential = (await this.#repository.listCredentials(userId)).find(
      (candidate) => candidate.id === credentialId,
    );
    if (credential === undefined) {
      throw new Error("passkey_not_found");
    }
    return toPublicPasskey(credential);
  }

  #requireConfiguration(): WebauthnConfiguration {
    if (this.#configuration === undefined) {
      throw new Error("webauthn_unavailable");
    }
    return this.#configuration;
  }

  async #verifyAuthentication(
    expectedChallenge: string,
    response: AuthenticationResponseJSON,
    expectedUserId?: string,
  ): Promise<StoredWebauthnCredential> {
    const configuration = this.#requireConfiguration();
    const credential = await this.#repository.findCredential(response.id);
    if (
      credential === undefined ||
      credential.user.status !== "active" ||
      (expectedUserId !== undefined && credential.user.id !== expectedUserId)
    ) {
      throw new Error("passkey_authentication_invalid");
    }
    const verification = await verifyAuthenticationResponse({
      credential: {
        counter: credential.counter,
        id: credential.id as Base64URLString,
        publicKey: new Uint8Array(credential.publicKey),
        transports: credential.transports,
      },
      expectedChallenge,
      expectedOrigin: [...configuration.origins],
      expectedRPID: configuration.rpId,
      requireUserVerification: true,
      response,
    });
    if (
      !verification.verified ||
      !(await this.#repository.updateCounter(
        credential.id,
        credential.counter,
        verification.authenticationInfo.newCounter,
        verification.authenticationInfo.credentialBackedUp,
        this.#now(),
      ))
    ) {
      throw new Error("passkey_authentication_invalid");
    }
    return credential;
  }
}
