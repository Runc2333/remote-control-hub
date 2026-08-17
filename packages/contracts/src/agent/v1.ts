import { Type, type Static } from "typebox";
import { AGENT_PROTOCOL_VERSION, ISO_DATE_TIME_SCHEMA } from "../common.js";
import {
  COMMAND_ERROR_CODE_SCHEMA,
  COMMAND_STATUS_SCHEMA,
} from "../http/commands.js";
import { DEVICE_CAPABILITY_SCHEMA } from "../http/devices.js";

export const AGENT_AUTHENTICATION_DOMAIN = "REMOTE_CONTROL_HUB_AGENT_AUTH_V1";

export const buildAgentAuthenticationPayload = (value: {
  deviceId: string;
  expiresAt: string;
  nonce: string;
  sessionId: string;
}): string =>
  [
    AGENT_AUTHENTICATION_DOMAIN,
    value.sessionId,
    value.deviceId,
    value.nonce,
    value.expiresAt,
  ].join("\n");

const AGENT_MESSAGE_BASE = {
  messageSequence: Type.Integer({ minimum: 0 }),
  protocolVersion: Type.Literal(AGENT_PROTOCOL_VERSION),
};
export const AGENT_HELLO_SCHEMA = Type.Object(
  {
    ...AGENT_MESSAGE_BASE,
    capabilities: Type.Array(DEVICE_CAPABILITY_SCHEMA, { uniqueItems: true }),
    deviceId: Type.String({ format: "uuid" }),
    serviceVersion: Type.String({ minLength: 1, maxLength: 64 }),
    sessionVersion: Type.String({ minLength: 1, maxLength: 64 }),
    type: Type.Literal("agent.hello"),
  },
  { additionalProperties: false },
);
export const AGENT_CHALLENGE_SCHEMA = Type.Object(
  {
    ...AGENT_MESSAGE_BASE,
    deviceId: Type.String({ format: "uuid" }),
    expiresAt: ISO_DATE_TIME_SCHEMA,
    nonce: Type.String({ pattern: "^[A-Za-z0-9_-]{43}$" }),
    sessionId: Type.String({ format: "uuid" }),
    type: Type.Literal("agent.challenge"),
  },
  { additionalProperties: false },
);
export const AGENT_AUTHENTICATE_SCHEMA = Type.Object(
  {
    ...AGENT_MESSAGE_BASE,
    deviceId: Type.String({ format: "uuid" }),
    expiresAt: ISO_DATE_TIME_SCHEMA,
    nonce: Type.String({ pattern: "^[A-Za-z0-9_-]{43}$" }),
    sessionId: Type.String({ format: "uuid" }),
    signature: Type.String({ pattern: "^[A-Za-z0-9_-]{86}$" }),
    type: Type.Literal("agent.authenticate"),
  },
  { additionalProperties: false },
);
export const AGENT_AUTHENTICATED_SCHEMA = Type.Object(
  {
    ...AGENT_MESSAGE_BASE,
    deviceId: Type.String({ format: "uuid" }),
    generation: Type.Integer({ minimum: 1 }),
    sessionId: Type.String({ format: "uuid" }),
    type: Type.Literal("agent.authenticated"),
  },
  { additionalProperties: false },
);
export const AGENT_HEARTBEAT_SCHEMA = Type.Object(
  {
    ...AGENT_MESSAGE_BASE,
    deviceId: Type.String({ format: "uuid" }),
    sentAt: ISO_DATE_TIME_SCHEMA,
    type: Type.Literal("agent.heartbeat"),
  },
  { additionalProperties: false },
);
export const AGENT_HEARTBEAT_ACK_SCHEMA = Type.Object(
  {
    ...AGENT_MESSAGE_BASE,
    deviceId: Type.String({ format: "uuid" }),
    receivedAt: ISO_DATE_TIME_SCHEMA,
    type: Type.Literal("agent.heartbeat_ack"),
  },
  { additionalProperties: false },
);
export const AGENT_COMMAND_SCHEMA = Type.Object(
  {
    ...AGENT_MESSAGE_BASE,
    commandId: Type.String({ format: "uuid" }),
    commandType: DEVICE_CAPABILITY_SCHEMA,
    createdAt: ISO_DATE_TIME_SCHEMA,
    deviceId: Type.String({ format: "uuid" }),
    expiresAt: ISO_DATE_TIME_SCHEMA,
    initiatedByUserId: Type.String({ format: "uuid" }),
    type: Type.Literal("command.execute"),
  },
  { additionalProperties: false },
);
export const AGENT_COMMAND_RESULT_SCHEMA = Type.Object(
  {
    ...AGENT_MESSAGE_BASE,
    commandId: Type.String({ format: "uuid" }),
    errorCode: Type.Optional(COMMAND_ERROR_CODE_SCHEMA),
    status: COMMAND_STATUS_SCHEMA,
    type: Type.Literal("command.result"),
  },
  { additionalProperties: false },
);

export type AgentCommand = Static<typeof AGENT_COMMAND_SCHEMA>;
export type AgentCommandResult = Static<typeof AGENT_COMMAND_RESULT_SCHEMA>;
export type AgentAuthenticate = Static<typeof AGENT_AUTHENTICATE_SCHEMA>;
export type AgentChallenge = Static<typeof AGENT_CHALLENGE_SCHEMA>;
export type AgentHello = Static<typeof AGENT_HELLO_SCHEMA>;
export type AgentHeartbeat = Static<typeof AGENT_HEARTBEAT_SCHEMA>;
