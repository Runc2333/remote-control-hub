import { Type, type Static } from "typebox";
import { ISO_DATE_TIME_SCHEMA } from "../common.js";
import { DEVICE_CAPABILITY_SCHEMA } from "./devices.js";

export const COMMAND_STATUS_SCHEMA = Type.Union([
  Type.Literal("created"),
  Type.Literal("sent"),
  Type.Literal("accepted"),
  Type.Literal("executing"),
  Type.Literal("succeeded"),
  Type.Literal("failed"),
  Type.Literal("expired"),
  Type.Literal("outcome_unknown"),
]);
export const COMMAND_ERROR_CODE_SCHEMA = Type.Union([
  Type.Literal("device_offline"),
  Type.Literal("unsupported"),
  Type.Literal("interactive_session_unavailable"),
  Type.Literal("multiple_sessions_unsupported"),
  Type.Literal("local_user_mismatch"),
  Type.Literal("device_disabled"),
  Type.Literal("device_credentials_revoked"),
  Type.Literal("device_deleted"),
  Type.Literal("owner_deleted"),
  Type.Literal("execution_failed"),
]);
export const CREATE_COMMAND_BATCH_REQUEST_SCHEMA = Type.Object(
  {
    commandType: DEVICE_CAPABILITY_SCHEMA,
    deviceIds: Type.Array(Type.String({ format: "uuid" }), {
      minItems: 1,
      maxItems: 100,
      uniqueItems: true,
    }),
    idempotencyKey: Type.String({ minLength: 16, maxLength: 128 }),
  },
  { additionalProperties: false },
);
export const COMMAND_RESULT_SCHEMA = Type.Object(
  {
    commandId: Type.String({ format: "uuid" }),
    completedAt: Type.Optional(ISO_DATE_TIME_SCHEMA),
    deviceId: Type.String({ format: "uuid" }),
    errorCode: Type.Optional(COMMAND_ERROR_CODE_SCHEMA),
    status: COMMAND_STATUS_SCHEMA,
  },
  { additionalProperties: false },
);
export const COMMAND_BATCH_RESPONSE_SCHEMA = Type.Object(
  {
    batchId: Type.String({ format: "uuid" }),
    results: Type.Array(COMMAND_RESULT_SCHEMA, { maxItems: 100 }),
  },
  { additionalProperties: false },
);
export const COMMAND_BATCH_PARAMS_SCHEMA = Type.Object(
  { batchId: Type.String({ format: "uuid" }) },
  { additionalProperties: false },
);

export type CommandErrorCode = Static<typeof COMMAND_ERROR_CODE_SCHEMA>;
export type CommandStatus = Static<typeof COMMAND_STATUS_SCHEMA>;
export type CommandBatchResponse = Static<typeof COMMAND_BATCH_RESPONSE_SCHEMA>;
export type CommandBatchParams = Static<typeof COMMAND_BATCH_PARAMS_SCHEMA>;
export type CreateCommandBatchRequest = Static<
  typeof CREATE_COMMAND_BATCH_REQUEST_SCHEMA
>;
