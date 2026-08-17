import { describe, expect, it } from "vitest";
import {
  buildAgentAuthenticationPayload,
  AGENT_COMMAND_SCHEMA,
  COMMAND_STATUS_SCHEMA,
  SETUP_STATUS_RESPONSE_SCHEMA,
} from "./index.js";

describe("public contracts", () => {
  it("builds a deterministic domain-separated authentication payload", () => {
    expect(
      buildAgentAuthenticationPayload({
        deviceId: "11111111-1111-4111-8111-111111111111",
        expiresAt: "2026-08-17T00:00:30.000+08:00",
        nonce: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        sessionId: "22222222-2222-4222-8222-222222222222",
      }),
    ).toBe(
      [
        "REMOTE_CONTROL_HUB_AGENT_AUTH_V1",
        "22222222-2222-4222-8222-222222222222",
        "11111111-1111-4111-8111-111111111111",
        "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        "2026-08-17T00:00:30.000+08:00",
      ].join("\n"),
    );
  });

  it("rejects additional properties at trust boundaries", () => {
    expect(JSON.stringify(AGENT_COMMAND_SCHEMA)).toContain(
      '"additionalProperties":false',
    );
    expect(JSON.stringify(SETUP_STATUS_RESPONSE_SCHEMA)).toContain(
      '"additionalProperties":false',
    );
  });

  it("keeps outcome_unknown separate from error codes", () => {
    expect(JSON.stringify(COMMAND_STATUS_SCHEMA)).toContain("outcome_unknown");
  });
});
