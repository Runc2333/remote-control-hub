import { Type, type Static } from "typebox";

export const API_VERSION = "v1";
export const WORKER_PROTOCOL_VERSION = 1;
export const AGENT_PROTOCOL_VERSION = 1;

export const EMPTY_OBJECT_SCHEMA = Type.Object(
  {},
  { additionalProperties: false },
);
export const ISO_DATE_TIME_SCHEMA = Type.String({ format: "date-time" });
export const IDENTIFIER_TYPE_SCHEMA = Type.Union([
  Type.Literal("email"),
  Type.Literal("phone"),
]);
export const USER_ROLE_SCHEMA = Type.Union([
  Type.Literal("admin"),
  Type.Literal("user"),
]);
export const USER_STATUS_SCHEMA = Type.Union([
  Type.Literal("active"),
  Type.Literal("disabled"),
  Type.Literal("deleted"),
]);
export const ERROR_RESPONSE_SCHEMA = Type.Object(
  {
    code: Type.String({ minLength: 1, maxLength: 64 }),
    message: Type.String({ minLength: 1, maxLength: 256 }),
    requestId: Type.String({ minLength: 1, maxLength: 128 }),
  },
  { additionalProperties: false },
);

export type ErrorResponse = Static<typeof ERROR_RESPONSE_SCHEMA>;
export type IdentifierType = Static<typeof IDENTIFIER_TYPE_SCHEMA>;
export type UserRole = Static<typeof USER_ROLE_SCHEMA>;
