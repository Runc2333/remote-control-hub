import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AGENT_AUTHENTICATE_SCHEMA,
  AGENT_AUTHENTICATED_SCHEMA,
  AGENT_CHALLENGE_SCHEMA,
  AGENT_COMMAND_RESULT_SCHEMA,
  AGENT_COMMAND_SCHEMA,
  AGENT_HELLO_SCHEMA,
  AGENT_HEARTBEAT_ACK_SCHEMA,
  AGENT_HEARTBEAT_SCHEMA,
  ADMIN_CREATE_USER_REQUEST_SCHEMA,
  ADMIN_CREATE_USER_RESPONSE_SCHEMA,
  CHANGE_PASSWORD_REQUEST_SCHEMA,
  COMMAND_BATCH_RESPONSE_SCHEMA,
  CREATE_COMMAND_BATCH_REQUEST_SCHEMA,
  CREATE_ENROLLMENT_TOKEN_RESPONSE_SCHEMA,
  CSRF_TOKEN_RESPONSE_SCHEMA,
  DEVICE_LIST_RESPONSE_SCHEMA,
  HEALTH_RESPONSE_SCHEMA,
  LOGIN_REQUEST_SCHEMA,
  LOGIN_RESPONSE_SCHEMA,
  META_VERSION_RESPONSE_SCHEMA,
  OPERATIONAL_UNAVAILABLE_RESPONSE_SCHEMA,
  REGISTER_AGENT_REQUEST_SCHEMA,
  REGISTER_AGENT_RESPONSE_SCHEMA,
  REGISTER_REQUEST_SCHEMA,
  REGISTER_RESPONSE_SCHEMA,
  REGISTRATION_MODE_RESPONSE_SCHEMA,
  SETUP_STATUS_RESPONSE_SCHEMA,
  TEST_DATA_SERVICE_REQUEST_SCHEMA,
  TEST_DATA_SERVICE_RESPONSE_SCHEMA,
  UPDATE_REGISTRATION_MODE_REQUEST_SCHEMA,
  COMPLETE_SETUP_REQUEST_SCHEMA,
} from "../src/index.js";

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(SCRIPT_DIRECTORY, "../../..");

const writeJson = async (
  relativePath: string,
  value: unknown,
): Promise<void> => {
  const absolutePath = resolve(REPOSITORY_ROOT, relativePath);
  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
};

await writeJson(
  "api/schemas/agent/v1/agent-authenticated.schema.json",
  AGENT_AUTHENTICATED_SCHEMA,
);
await writeJson(
  "api/schemas/agent/v1/agent-authenticate.schema.json",
  AGENT_AUTHENTICATE_SCHEMA,
);
await writeJson(
  "api/schemas/agent/v1/agent-challenge.schema.json",
  AGENT_CHALLENGE_SCHEMA,
);
await writeJson(
  "api/schemas/agent/v1/agent-hello.schema.json",
  AGENT_HELLO_SCHEMA,
);
await writeJson(
  "api/schemas/agent/v1/agent-heartbeat.schema.json",
  AGENT_HEARTBEAT_SCHEMA,
);
await writeJson(
  "api/schemas/agent/v1/agent-heartbeat-ack.schema.json",
  AGENT_HEARTBEAT_ACK_SCHEMA,
);
await writeJson(
  "api/schemas/agent/v1/command.schema.json",
  AGENT_COMMAND_SCHEMA,
);
await writeJson(
  "api/schemas/agent/v1/command-result.schema.json",
  AGENT_COMMAND_RESULT_SCHEMA,
);
await writeJson("api/openapi/openapi.json", {
  openapi: "3.1.0",
  info: { title: "Remote Control Hub API", version: "1.0.0" },
  paths: {
    "/api/v1/admin/registration": {
      get: { responses: { 200: { description: "Registration policy" } } },
      put: {
        responses: { 200: { description: "Updated registration policy" } },
      },
    },
    "/api/v1/admin/users": {
      post: { responses: { 200: { description: "Created user" } } },
    },
    "/api/v1/agent/register": {
      post: { responses: { 200: { description: "Registered agent" } } },
    },
    "/api/v1/auth/csrf": {
      get: { responses: { 200: { description: "CSRF token" } } },
    },
    "/api/v1/auth/login": {
      post: { responses: { 200: { description: "Authenticated" } } },
    },
    "/api/v1/auth/register": {
      post: { responses: { 200: { description: "Registered user" } } },
    },
    "/api/v1/commands": {
      post: { responses: { 200: { description: "Created command batch" } } },
    },
    "/api/v1/devices": {
      get: { responses: { 200: { description: "Owned devices" } } },
    },
    "/api/v1/enrollment-tokens": {
      post: { responses: { 200: { description: "Created enrollment token" } } },
    },
    "/api/v1/meta/version": {
      get: { responses: { 200: { description: "Version metadata" } } },
    },
    "/api/v1/setup/status": {
      get: { responses: { 200: { description: "Setup status" } } },
    },
    "/api/v1/setup/test-data-service": {
      post: { responses: { 200: { description: "Data service test result" } } },
    },
    "/api/v1/setup/complete": {
      post: { responses: { 200: { description: "Completed setup status" } } },
    },
    "/healthz": {
      get: { responses: { 200: { description: "Process health" } } },
    },
    "/operationalz": {
      get: {
        responses: {
          200: { description: "Operational" },
          503: { description: "Not operational" },
        },
      },
    },
  },
  "x-schemas": {
    adminCreateUserRequest: ADMIN_CREATE_USER_REQUEST_SCHEMA,
    adminCreateUserResponse: ADMIN_CREATE_USER_RESPONSE_SCHEMA,
    changePasswordRequest: CHANGE_PASSWORD_REQUEST_SCHEMA,
    commandBatchResponse: COMMAND_BATCH_RESPONSE_SCHEMA,
    createCommandBatchRequest: CREATE_COMMAND_BATCH_REQUEST_SCHEMA,
    createEnrollmentTokenResponse: CREATE_ENROLLMENT_TOKEN_RESPONSE_SCHEMA,
    csrfTokenResponse: CSRF_TOKEN_RESPONSE_SCHEMA,
    deviceListResponse: DEVICE_LIST_RESPONSE_SCHEMA,
    health: HEALTH_RESPONSE_SCHEMA,
    loginRequest: LOGIN_REQUEST_SCHEMA,
    loginResponse: LOGIN_RESPONSE_SCHEMA,
    metaVersion: META_VERSION_RESPONSE_SCHEMA,
    operationalUnavailable: OPERATIONAL_UNAVAILABLE_RESPONSE_SCHEMA,
    registerAgentRequest: REGISTER_AGENT_REQUEST_SCHEMA,
    registerAgentResponse: REGISTER_AGENT_RESPONSE_SCHEMA,
    registerRequest: REGISTER_REQUEST_SCHEMA,
    registerResponse: REGISTER_RESPONSE_SCHEMA,
    registrationModeResponse: REGISTRATION_MODE_RESPONSE_SCHEMA,
    setupCompleteRequest: COMPLETE_SETUP_REQUEST_SCHEMA,
    setupStatus: SETUP_STATUS_RESPONSE_SCHEMA,
    testDataServiceRequest: TEST_DATA_SERVICE_REQUEST_SCHEMA,
    testDataServiceResponse: TEST_DATA_SERVICE_RESPONSE_SCHEMA,
    updateRegistrationModeRequest: UPDATE_REGISTRATION_MODE_REQUEST_SCHEMA,
  },
});
