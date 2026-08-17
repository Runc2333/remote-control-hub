import { describe, expect, it, vi } from "vitest";
import { ApiClient } from "./index.js";

describe("ApiClient", () => {
  it("requests the health endpoint", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          status: "ok",
          timestamp: "2026-08-17T00:00:00+08:00",
        }),
        { status: 200 },
      ),
    );
    const client = new ApiClient({ baseUrl: "https://hub.example.com", fetch });

    await expect(client.getHealth()).resolves.toMatchObject({ status: "ok" });
    expect(fetch).toHaveBeenCalledWith(
      "https://hub.example.com/healthz",
      expect.objectContaining({ credentials: "include" }),
    );
  });

  it("sends setup secrets only in a JSON request body", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(
        new Response(JSON.stringify({ ok: true }), { status: 200 }),
      );
    const client = new ApiClient({ baseUrl: "https://hub.example.com", fetch });

    await client.testDataService({
      service: "mysql",
      setupSecret: "0123456789abcdef",
    });

    expect(fetch).toHaveBeenCalledWith(
      "https://hub.example.com/api/v1/setup/test-data-service",
      expect.objectContaining({
        body: JSON.stringify({
          service: "mysql",
          setupSecret: "0123456789abcdef",
        }),
        method: "POST",
      }),
    );
  });

  it("fetches and reuses a CSRF token for state-changing requests", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ csrfToken: "csrf-token" }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            requiresPasswordChange: false,
            requiresTotp: false,
            role: "user",
          }),
          { status: 200 },
        ),
      );
    const client = new ApiClient({ baseUrl: "https://hub.example.com", fetch });

    await client.login({
      identifier: "user@example.com",
      identifierType: "email",
      password: "password",
    });

    expect(fetch).toHaveBeenNthCalledWith(
      2,
      "https://hub.example.com/api/v1/auth/login",
      expect.objectContaining({
        headers: expect.objectContaining({ "csrf-token": "csrf-token" }),
        method: "POST",
      }),
    );
  });
});
