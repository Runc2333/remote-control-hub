import { Type, type Static } from "typebox";
import { ISO_DATE_TIME_SCHEMA } from "../common.js";

export const AUDIT_RESULT_SCHEMA = Type.Union([
  Type.Literal("success"),
  Type.Literal("failure"),
]);
export const AUDIT_VISIBILITY_SCHEMA = Type.Union([
  Type.Literal("owner"),
  Type.Literal("admin"),
  Type.Literal("system"),
]);
export const AUDIT_SOURCE_ADDRESS_CLASS_SCHEMA = Type.Union([
  Type.Literal("loopback"),
  Type.Literal("private"),
  Type.Literal("public"),
  Type.Literal("unknown"),
]);
export const AUDIT_EVENT_SCHEMA = Type.Object(
  {
    action: Type.String({ minLength: 1, maxLength: 128 }),
    actorId: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
    actorType: Type.Union([
      Type.Literal("user"),
      Type.Literal("agent"),
      Type.Literal("system"),
    ]),
    errorCategory: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
    id: Type.String({ format: "uuid" }),
    occurredAt: ISO_DATE_TIME_SCHEMA,
    requestId: Type.String({ minLength: 1, maxLength: 128 }),
    result: AUDIT_RESULT_SCHEMA,
    sourceAddressClass: AUDIT_SOURCE_ADDRESS_CLASS_SCHEMA,
    subjectId: Type.String({ minLength: 1, maxLength: 64 }),
    subjectType: Type.String({ minLength: 1, maxLength: 64 }),
    visibility: AUDIT_VISIBILITY_SCHEMA,
  },
  { additionalProperties: false },
);
export const AUDIT_EVENT_QUERY_SCHEMA = Type.Object(
  {
    action: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
    cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
    from: Type.Optional(ISO_DATE_TIME_SCHEMA),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
    result: Type.Optional(AUDIT_RESULT_SCHEMA),
    to: Type.Optional(ISO_DATE_TIME_SCHEMA),
  },
  { additionalProperties: false },
);
export const AUDIT_EVENT_LIST_RESPONSE_SCHEMA = Type.Object(
  {
    events: Type.Array(AUDIT_EVENT_SCHEMA, { maxItems: 100 }),
    nextCursor: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
  },
  { additionalProperties: false },
);

export type AuditEvent = Static<typeof AUDIT_EVENT_SCHEMA>;
export type AuditEventQuery = Static<typeof AUDIT_EVENT_QUERY_SCHEMA>;
export type AuditEventListResponse = Static<
  typeof AUDIT_EVENT_LIST_RESPONSE_SCHEMA
>;
