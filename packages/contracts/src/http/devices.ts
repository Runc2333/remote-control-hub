import { Type, type Static } from "typebox";
import { ISO_DATE_TIME_SCHEMA } from "../common.js";

export const DEVICE_CAPABILITY_SCHEMA = Type.Union([
  Type.Literal("display.turn_off"),
  Type.Literal("media.volume_up"),
  Type.Literal("media.volume_down"),
  Type.Literal("media.volume_mute_toggle"),
  Type.Literal("media.play_pause"),
  Type.Literal("media.previous_track"),
  Type.Literal("media.next_track"),
  Type.Literal("media.stop"),
]);
export const DEVICE_SCHEMA = Type.Object(
  {
    capabilities: Type.Array(DEVICE_CAPABILITY_SCHEMA, { uniqueItems: true }),
    computerName: Type.String({ minLength: 1, maxLength: 255 }),
    id: Type.String({ format: "uuid" }),
    lastActiveAt: Type.Optional(ISO_DATE_TIME_SCHEMA),
    online: Type.Boolean(),
    serviceVersion: Type.String({ minLength: 1, maxLength: 64 }),
    sessionVersion: Type.String({ minLength: 1, maxLength: 64 }),
  },
  { additionalProperties: false },
);
export const DEVICE_LIST_RESPONSE_SCHEMA = Type.Object(
  { devices: Type.Array(DEVICE_SCHEMA, { maxItems: 1000 }) },
  { additionalProperties: false },
);
export const ADMIN_DEVICE_SCHEMA = Type.Object(
  {
    capabilities: Type.Array(DEVICE_CAPABILITY_SCHEMA, { uniqueItems: true }),
    computerName: Type.String({ minLength: 1, maxLength: 255 }),
    credentialStatus: Type.Union([
      Type.Literal("active"),
      Type.Literal("revoked"),
    ]),
    disabled: Type.Boolean(),
    id: Type.String({ format: "uuid" }),
    lastActiveAt: Type.Optional(ISO_DATE_TIME_SCHEMA),
    online: Type.Boolean(),
    ownerDisplayIdentifier: Type.String({ maxLength: 320 }),
    ownerUserId: Type.String({ format: "uuid" }),
    serviceVersion: Type.String({ minLength: 1, maxLength: 64 }),
    sessionVersion: Type.String({ minLength: 1, maxLength: 64 }),
  },
  { additionalProperties: false },
);
export const ADMIN_DEVICE_LIST_RESPONSE_SCHEMA = Type.Object(
  { devices: Type.Array(ADMIN_DEVICE_SCHEMA, { maxItems: 1000 }) },
  { additionalProperties: false },
);
export const ADMIN_DEVICE_ID_PARAMS_SCHEMA = Type.Object(
  { deviceId: Type.String({ format: "uuid" }) },
  { additionalProperties: false },
);
export const ADMIN_UPDATE_DEVICE_REQUEST_SCHEMA = Type.Object(
  { disabled: Type.Boolean() },
  { additionalProperties: false },
);
export const ADMIN_CONFIRMED_DEVICE_ACTION_REQUEST_SCHEMA = Type.Object(
  { confirmationToken: Type.String({ minLength: 32, maxLength: 128 }) },
  { additionalProperties: false },
);
export const CREATE_ENROLLMENT_TOKEN_RESPONSE_SCHEMA = Type.Object(
  {
    expiresAt: ISO_DATE_TIME_SCHEMA,
    token: Type.String({ pattern: "^[A-Za-z0-9_-]{43}$" }),
  },
  { additionalProperties: false },
);
export const REGISTER_AGENT_REQUEST_SCHEMA = Type.Object(
  {
    capabilities: Type.Array(DEVICE_CAPABILITY_SCHEMA, {
      maxItems: 32,
      uniqueItems: true,
    }),
    computerName: Type.String({ minLength: 1, maxLength: 255 }),
    enrollmentToken: Type.String({ pattern: "^[A-Za-z0-9_-]{43}$" }),
    platform: Type.Literal("windows"),
    publicKey: Type.String({ pattern: "^[A-Za-z0-9_-]{43}$" }),
    serviceVersion: Type.String({ minLength: 1, maxLength: 64 }),
    sessionVersion: Type.String({ minLength: 1, maxLength: 64 }),
  },
  { additionalProperties: false },
);
export const REGISTER_AGENT_RESPONSE_SCHEMA = Type.Object(
  { deviceId: Type.String({ format: "uuid" }) },
  { additionalProperties: false },
);

export type Device = Static<typeof DEVICE_SCHEMA>;
export type DeviceCapability = Static<typeof DEVICE_CAPABILITY_SCHEMA>;
export type DeviceListResponse = Static<typeof DEVICE_LIST_RESPONSE_SCHEMA>;
export type AdminDevice = Static<typeof ADMIN_DEVICE_SCHEMA>;
export type AdminDeviceIdParams = Static<typeof ADMIN_DEVICE_ID_PARAMS_SCHEMA>;
export type AdminDeviceListResponse = Static<
  typeof ADMIN_DEVICE_LIST_RESPONSE_SCHEMA
>;
export type AdminUpdateDeviceRequest = Static<
  typeof ADMIN_UPDATE_DEVICE_REQUEST_SCHEMA
>;
export type AdminConfirmedDeviceActionRequest = Static<
  typeof ADMIN_CONFIRMED_DEVICE_ACTION_REQUEST_SCHEMA
>;
export type CreateEnrollmentTokenResponse = Static<
  typeof CREATE_ENROLLMENT_TOKEN_RESPONSE_SCHEMA
>;
export type RegisterAgentRequest = Static<typeof REGISTER_AGENT_REQUEST_SCHEMA>;
