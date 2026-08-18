import type {
  ActionConfirmationRequest,
  ActionConfirmationResponse,
  AdminConfirmedActionRequest,
  AdminConfirmedDeviceActionRequest,
  AdminCreateUserRequest,
  AdminCreateUserResponse,
  AdminDeviceListResponse,
  AdminResetPasswordResponse,
  AdminSystemSummaryResponse,
  AdminUpdateDeviceRequest,
  AdminUpdateUserRequest,
  AdminUser,
  AdminUserListResponse,
  AuditEventListResponse,
  AuditEventQuery,
  CommandBatchResponse,
  CommandBatchListResponse,
  CompleteSetupRequest,
  ConfirmedActionRequest,
  CreateCommandBatchRequest,
  CreateEnrollmentTokenResponse,
  DeviceListResponse,
  HealthResponse,
  MetaVersionResponse,
  LoginRequest,
  LoginResponse,
  RegisterRequest,
  RegistrationMode,
  SessionListResponse,
  SetupStatusResponse,
  StepUpPasswordRequest,
  TestDataServiceRequest,
  TestDataServiceResponse,
  TotpLoginRequest,
  TotpEnrollmentBeginResponse,
  TotpEnrollmentConfirmResponse,
  TotpStatusResponse,
  Passkey,
  PasskeyListResponse,
  WebauthnAuthenticationResponse,
  WebauthnOptionsResponse,
  WebauthnRegistrationResponse,
} from "@remote-control-hub/contracts";

export type ApiClientOptions = {
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
};

export class ApiError extends Error {
  public readonly status: number;

  public constructor(status: number) {
    super(`Request failed with status ${status}`);
    this.name = "ApiError";
    this.status = status;
  }
}

export class ApiClient {
  readonly #baseUrl: string;
  readonly #fetch: typeof globalThis.fetch;
  #csrfToken: string | undefined;

  public constructor(options: ApiClientOptions = {}) {
    this.#baseUrl = options.baseUrl ?? "";
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  public getHealth(): Promise<HealthResponse> {
    return this.#request<HealthResponse>("/healthz");
  }

  public getSetupStatus(): Promise<SetupStatusResponse> {
    return this.#request<SetupStatusResponse>("/api/v1/setup/status");
  }

  public getVersion(): Promise<MetaVersionResponse> {
    return this.#request<MetaVersionResponse>("/api/v1/meta/version");
  }

  public testDataService(
    request: TestDataServiceRequest,
  ): Promise<TestDataServiceResponse> {
    return this.#request<TestDataServiceResponse>(
      "/api/v1/setup/test-data-service",
      {
        body: JSON.stringify(request),
        headers: { "content-type": "application/json" },
        method: "POST",
      },
    );
  }

  public completeSetup(
    request: CompleteSetupRequest,
  ): Promise<SetupStatusResponse> {
    return this.#request<SetupStatusResponse>("/api/v1/setup/complete", {
      body: JSON.stringify(request),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
  }

  public async login(request: LoginRequest): Promise<LoginResponse> {
    return this.#mutation<LoginResponse>("/api/v1/auth/login", request);
  }

  public completeTemporaryPassword(
    newPassword: string,
  ): Promise<LoginResponse> {
    return this.#mutation<LoginResponse>("/api/v1/auth/temporary-password", {
      newPassword,
    });
  }

  public completeSecondFactor(
    request: TotpLoginRequest,
  ): Promise<LoginResponse> {
    return this.#mutation<LoginResponse>("/api/v1/auth/totp/login", request);
  }

  public getTotpStatus(): Promise<TotpStatusResponse> {
    return this.#request<TotpStatusResponse>("/api/v1/auth/totp");
  }

  public beginTotpEnrollment(): Promise<TotpEnrollmentBeginResponse> {
    return this.#mutation<TotpEnrollmentBeginResponse>(
      "/api/v1/auth/totp/enrollment",
      {},
    );
  }

  public confirmTotpEnrollment(
    code: string,
  ): Promise<TotpEnrollmentConfirmResponse> {
    return this.#mutation<TotpEnrollmentConfirmResponse>(
      "/api/v1/auth/totp/enrollment/confirm",
      { code },
    );
  }

  public async disableTotp(request: ConfirmedActionRequest): Promise<void> {
    await this.#mutate<{ success: true }>(
      "/api/v1/auth/totp",
      request,
      "DELETE",
    );
  }

  public regenerateRecoveryCodes(
    request: ConfirmedActionRequest,
  ): Promise<TotpEnrollmentConfirmResponse> {
    return this.#mutation<TotpEnrollmentConfirmResponse>(
      "/api/v1/auth/totp/recovery-codes",
      request,
    );
  }

  public beginPasskeyAuthentication(): Promise<WebauthnOptionsResponse> {
    return this.#mutation<WebauthnOptionsResponse>(
      "/api/v1/auth/passkeys/authentication/options",
      {},
    );
  }

  public async stepUpPassword(request: StepUpPasswordRequest): Promise<void> {
    await this.#mutation<{ success: true }>(
      "/api/v1/auth/step-up/password",
      request,
    );
  }

  public beginPasskeyStepUp(): Promise<WebauthnOptionsResponse> {
    return this.#mutation<WebauthnOptionsResponse>(
      "/api/v1/auth/step-up/passkey/options",
      {},
    );
  }

  public async completePasskeyStepUp(
    response: WebauthnAuthenticationResponse,
  ): Promise<void> {
    await this.#mutation<{ success: true }>(
      "/api/v1/auth/step-up/passkey/verify",
      { response },
    );
  }

  public completePasskeyAuthentication(
    response: WebauthnAuthenticationResponse,
  ): Promise<LoginResponse> {
    return this.#mutation<LoginResponse>(
      "/api/v1/auth/passkeys/authentication/verify",
      { response },
    );
  }

  public getPasskeys(): Promise<PasskeyListResponse> {
    return this.#request<PasskeyListResponse>("/api/v1/auth/passkeys");
  }

  public beginPasskeyRegistration(): Promise<WebauthnOptionsResponse> {
    return this.#mutation<WebauthnOptionsResponse>(
      "/api/v1/auth/passkeys/registration/options",
      {},
    );
  }

  public completePasskeyRegistration(
    name: string,
    response: WebauthnRegistrationResponse,
  ): Promise<Passkey> {
    return this.#mutation<Passkey>(
      "/api/v1/auth/passkeys/registration/verify",
      { name, response },
    );
  }

  public renamePasskey(passkeyId: string, name: string): Promise<Passkey> {
    return this.#mutate<Passkey>(
      `/api/v1/auth/passkeys/${encodeURIComponent(passkeyId)}`,
      { name },
      "PATCH",
    );
  }

  public async deletePasskey(passkeyId: string): Promise<void> {
    await this.#mutate<{ success: true }>(
      `/api/v1/auth/passkeys/${encodeURIComponent(passkeyId)}`,
      undefined,
      "DELETE",
    );
  }

  public async register(request: RegisterRequest): Promise<{ userId: string }> {
    return this.#mutation<{ userId: string }>("/api/v1/auth/register", request);
  }

  public getPublicRegistrationMode(): Promise<{ mode: RegistrationMode }> {
    return this.#request<{ mode: RegistrationMode }>(
      "/api/v1/auth/registration",
    );
  }

  public getSessions(): Promise<SessionListResponse> {
    return this.#request<SessionListResponse>("/api/v1/auth/sessions");
  }

  public async logout(): Promise<void> {
    await this.#mutation<{ success: true }>("/api/v1/auth/logout", {});
    this.#csrfToken = undefined;
  }

  public revokeOtherSessions(): Promise<{ revokedCount: number }> {
    return this.#mutation<{ revokedCount: number }>(
      "/api/v1/auth/sessions/revoke-others",
      {},
    );
  }

  public async revokeSession(sessionId: string): Promise<void> {
    await this.#mutate<{ success: true }>(
      `/api/v1/auth/sessions/${encodeURIComponent(sessionId)}`,
      undefined,
      "DELETE",
    );
  }

  public getDevices(): Promise<DeviceListResponse> {
    return this.#request<DeviceListResponse>("/api/v1/devices");
  }

  public createEnrollmentToken(): Promise<CreateEnrollmentTokenResponse> {
    return this.#mutation<CreateEnrollmentTokenResponse>(
      "/api/v1/enrollment-tokens",
      {},
    );
  }

  public issueActionConfirmation(
    request: ActionConfirmationRequest,
  ): Promise<ActionConfirmationResponse> {
    return this.#mutation<ActionConfirmationResponse>(
      "/api/v1/auth/action-confirmations",
      request,
    );
  }

  public getRegistrationMode(): Promise<{ mode: RegistrationMode }> {
    return this.#request<{ mode: RegistrationMode }>(
      "/api/v1/admin/registration",
    );
  }

  public updateRegistrationMode(
    mode: RegistrationMode,
    confirmationToken: string,
  ): Promise<{ mode: RegistrationMode }> {
    return this.#mutate<{ mode: RegistrationMode }>(
      "/api/v1/admin/registration",
      { confirmationToken, mode },
      "PUT",
    );
  }

  public getAdminUsers(): Promise<AdminUserListResponse> {
    return this.#request<AdminUserListResponse>("/api/v1/admin/users");
  }

  public createAdminUser(
    request: AdminCreateUserRequest,
  ): Promise<AdminCreateUserResponse> {
    return this.#mutation<AdminCreateUserResponse>(
      "/api/v1/admin/users",
      request,
    );
  }

  public updateAdminUser(
    userId: string,
    request: AdminUpdateUserRequest,
  ): Promise<AdminUser> {
    return this.#mutate<AdminUser>(
      `/api/v1/admin/users/${encodeURIComponent(userId)}`,
      request,
      "PATCH",
    );
  }

  public resetAdminUserPassword(
    userId: string,
    request: AdminConfirmedActionRequest,
  ): Promise<AdminResetPasswordResponse> {
    return this.#mutation<AdminResetPasswordResponse>(
      `/api/v1/admin/users/${encodeURIComponent(userId)}/reset-password`,
      request,
    );
  }

  public async resetAdminUserAuthentication(
    userId: string,
    request: AdminConfirmedActionRequest,
  ): Promise<void> {
    await this.#mutation<{ success: true }>(
      `/api/v1/admin/users/${encodeURIComponent(userId)}/reset-authentication`,
      request,
    );
  }

  public async deleteAdminUser(
    userId: string,
    request: AdminConfirmedActionRequest,
  ): Promise<void> {
    await this.#mutate<{ success: true }>(
      `/api/v1/admin/users/${encodeURIComponent(userId)}`,
      request,
      "DELETE",
    );
  }

  public getAdminDevices(): Promise<AdminDeviceListResponse> {
    return this.#request<AdminDeviceListResponse>("/api/v1/admin/devices");
  }

  public getAdminSystemSummary(): Promise<AdminSystemSummaryResponse> {
    return this.#request<AdminSystemSummaryResponse>(
      "/api/v1/admin/system-summary",
    );
  }

  public getAuditEvents(
    query: AuditEventQuery = {},
  ): Promise<AuditEventListResponse> {
    return this.#request<AuditEventListResponse>(
      this.#queryPath("/api/v1/audit-events", query),
    );
  }

  public getAdminAuditEvents(
    query: AuditEventQuery = {},
  ): Promise<AuditEventListResponse> {
    return this.#request<AuditEventListResponse>(
      this.#queryPath("/api/v1/admin/audit-events", query),
    );
  }

  public async updateAdminDevice(
    deviceId: string,
    request: AdminUpdateDeviceRequest,
  ): Promise<void> {
    await this.#mutate<{ success: true }>(
      `/api/v1/admin/devices/${encodeURIComponent(deviceId)}`,
      request,
      "PATCH",
    );
  }

  public async revokeAdminDeviceCredentials(
    deviceId: string,
    request: AdminConfirmedDeviceActionRequest,
  ): Promise<void> {
    await this.#mutation<{ success: true }>(
      `/api/v1/admin/devices/${encodeURIComponent(deviceId)}/credentials/revoke`,
      request,
    );
  }

  public async deleteAdminDevice(
    deviceId: string,
    request: AdminConfirmedDeviceActionRequest,
  ): Promise<void> {
    await this.#mutate<{ success: true }>(
      `/api/v1/admin/devices/${encodeURIComponent(deviceId)}`,
      request,
      "DELETE",
    );
  }

  public createCommand(
    request: CreateCommandBatchRequest,
  ): Promise<CommandBatchResponse> {
    return this.#mutation<CommandBatchResponse>("/api/v1/commands", request);
  }

  public getCommandBatch(batchId: string): Promise<CommandBatchResponse> {
    return this.#request<CommandBatchResponse>(
      `/api/v1/command-batches/${encodeURIComponent(batchId)}`,
    );
  }

  public getCommandBatches(limit = 50): Promise<CommandBatchListResponse> {
    const parameters = new URLSearchParams({ limit: String(limit) });
    return this.#request<CommandBatchListResponse>(
      `/api/v1/command-batches?${parameters.toString()}`,
    );
  }

  async #csrf(): Promise<string> {
    if (this.#csrfToken !== undefined) {
      return this.#csrfToken;
    }
    const response = await this.#request<{ csrfToken: string }>(
      "/api/v1/auth/csrf",
    );
    this.#csrfToken = response.csrfToken;
    return response.csrfToken;
  }

  #queryPath(path: string, query: AuditEventQuery): string {
    const parameters = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) {
        parameters.set(key, String(value));
      }
    }
    const serialized = parameters.toString();
    return serialized.length === 0 ? path : `${path}?${serialized}`;
  }

  async #mutation<Response>(path: string, body: unknown): Promise<Response> {
    return this.#mutate<Response>(path, body, "POST");
  }

  async #mutate<Response>(
    path: string,
    body: unknown,
    method: "DELETE" | "PATCH" | "POST" | "PUT",
  ): Promise<Response> {
    const csrfToken = await this.#csrf();
    return this.#request<Response>(path, {
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      headers: {
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        "csrf-token": csrfToken,
      },
      method,
    });
  }

  async #request<Response>(
    path: string,
    init: RequestInit = {},
  ): Promise<Response> {
    const response = await this.#fetch(`${this.#baseUrl}${path}`, {
      ...init,
      credentials: "include",
      headers: { accept: "application/json", ...init.headers },
    });
    if (!response.ok) {
      throw new ApiError(response.status);
    }
    return (await response.json()) as Response;
  }
}
