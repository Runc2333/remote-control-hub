import { Type, type Static } from "typebox";
import {
  IDENTIFIER_TYPE_SCHEMA,
  ISO_DATE_TIME_SCHEMA,
  USER_ROLE_SCHEMA,
} from "../common.js";

export const LOGIN_REQUEST_SCHEMA = Type.Object(
  {
    identifier: Type.String({ minLength: 3, maxLength: 320 }),
    identifierType: IDENTIFIER_TYPE_SCHEMA,
    password: Type.String({ minLength: 1, maxLength: 256 }),
  },
  { additionalProperties: false },
);
export const TOTP_LOGIN_REQUEST_SCHEMA = Type.Union([
  Type.Object(
    {
      code: Type.String({ pattern: "^[0-9]{6}$" }),
      type: Type.Literal("totp"),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      recoveryCode: Type.String({ minLength: 16, maxLength: 64 }),
      type: Type.Literal("recovery_code"),
    },
    { additionalProperties: false },
  ),
]);
export const TOTP_ENROLLMENT_BEGIN_RESPONSE_SCHEMA = Type.Object(
  {
    expiresAt: ISO_DATE_TIME_SCHEMA,
    otpauthUri: Type.String({ maxLength: 2048, pattern: "^otpauth://totp/" }),
    secret: Type.String({ minLength: 16, maxLength: 128 }),
  },
  { additionalProperties: false },
);
export const TOTP_ENROLLMENT_CONFIRM_REQUEST_SCHEMA = Type.Object(
  { code: Type.String({ pattern: "^[0-9]{6}$" }) },
  { additionalProperties: false },
);
export const TOTP_ENROLLMENT_CONFIRM_RESPONSE_SCHEMA = Type.Object(
  {
    recoveryCodes: Type.Array(Type.String({ minLength: 16, maxLength: 64 }), {
      minItems: 1,
      maxItems: 20,
    }),
  },
  { additionalProperties: false },
);
export const TOTP_STATUS_RESPONSE_SCHEMA = Type.Object(
  {
    enabled: Type.Boolean(),
    lastUsedAt: Type.Optional(ISO_DATE_TIME_SCHEMA),
    remainingRecoveryCodes: Type.Integer({ minimum: 0, maximum: 20 }),
  },
  { additionalProperties: false },
);
const BASE64URL_SCHEMA = Type.String({
  maxLength: 4096,
  minLength: 1,
  pattern: "^[A-Za-z0-9_-]+$",
});
const AUTHENTICATOR_ATTACHMENT_SCHEMA = Type.Union([
  Type.Literal("cross-platform"),
  Type.Literal("platform"),
]);
const AUTHENTICATOR_TRANSPORT_SCHEMA = Type.Union([
  Type.Literal("ble"),
  Type.Literal("cable"),
  Type.Literal("hybrid"),
  Type.Literal("internal"),
  Type.Literal("nfc"),
  Type.Literal("smart-card"),
  Type.Literal("usb"),
]);
const CLIENT_EXTENSION_RESULTS_SCHEMA = Type.Record(
  Type.String({ maxLength: 128 }),
  Type.Unknown(),
);
export const WEBAUTHN_REGISTRATION_RESPONSE_SCHEMA = Type.Object(
  {
    authenticatorAttachment: Type.Optional(AUTHENTICATOR_ATTACHMENT_SCHEMA),
    clientExtensionResults: CLIENT_EXTENSION_RESULTS_SCHEMA,
    id: BASE64URL_SCHEMA,
    rawId: BASE64URL_SCHEMA,
    response: Type.Object(
      {
        attestationObject: BASE64URL_SCHEMA,
        authenticatorData: Type.Optional(BASE64URL_SCHEMA),
        clientDataJSON: BASE64URL_SCHEMA,
        publicKey: Type.Optional(BASE64URL_SCHEMA),
        publicKeyAlgorithm: Type.Optional(Type.Integer()),
        transports: Type.Optional(Type.Array(AUTHENTICATOR_TRANSPORT_SCHEMA)),
      },
      { additionalProperties: false },
    ),
    type: Type.Literal("public-key"),
  },
  { additionalProperties: false },
);
export const WEBAUTHN_AUTHENTICATION_RESPONSE_SCHEMA = Type.Object(
  {
    authenticatorAttachment: Type.Optional(AUTHENTICATOR_ATTACHMENT_SCHEMA),
    clientExtensionResults: CLIENT_EXTENSION_RESULTS_SCHEMA,
    id: BASE64URL_SCHEMA,
    rawId: BASE64URL_SCHEMA,
    response: Type.Object(
      {
        authenticatorData: BASE64URL_SCHEMA,
        clientDataJSON: BASE64URL_SCHEMA,
        signature: BASE64URL_SCHEMA,
        userHandle: Type.Optional(BASE64URL_SCHEMA),
      },
      { additionalProperties: false },
    ),
    type: Type.Literal("public-key"),
  },
  { additionalProperties: false },
);
export const WEBAUTHN_OPTIONS_RESPONSE_SCHEMA = Type.Object(
  { options: Type.Record(Type.String(), Type.Unknown()) },
  { additionalProperties: false },
);
export const PASSKEY_REGISTRATION_VERIFY_REQUEST_SCHEMA = Type.Object(
  {
    name: Type.String({ maxLength: 128, minLength: 1 }),
    response: WEBAUTHN_REGISTRATION_RESPONSE_SCHEMA,
  },
  { additionalProperties: false },
);
export const PASSKEY_AUTHENTICATION_VERIFY_REQUEST_SCHEMA = Type.Object(
  { response: WEBAUTHN_AUTHENTICATION_RESPONSE_SCHEMA },
  { additionalProperties: false },
);
export const PASSKEY_SCHEMA = Type.Object(
  {
    backedUp: Type.Boolean(),
    createdAt: ISO_DATE_TIME_SCHEMA,
    deviceType: Type.Union([
      Type.Literal("singleDevice"),
      Type.Literal("multiDevice"),
    ]),
    id: Type.String({ maxLength: 1024, minLength: 1 }),
    lastUsedAt: Type.Optional(ISO_DATE_TIME_SCHEMA),
    name: Type.String({ maxLength: 128, minLength: 1 }),
    transports: Type.Array(AUTHENTICATOR_TRANSPORT_SCHEMA),
  },
  { additionalProperties: false },
);
export const PASSKEY_LIST_RESPONSE_SCHEMA = Type.Object(
  { passkeys: Type.Array(PASSKEY_SCHEMA, { maxItems: 20 }) },
  { additionalProperties: false },
);
export const PASSKEY_ID_PARAMS_SCHEMA = Type.Object(
  { passkeyId: Type.String({ maxLength: 1024, minLength: 1 }) },
  { additionalProperties: false },
);
export const PASSKEY_RENAME_REQUEST_SCHEMA = Type.Object(
  { name: Type.String({ maxLength: 128, minLength: 1 }) },
  { additionalProperties: false },
);
export const REGISTER_REQUEST_SCHEMA = Type.Object(
  {
    identifier: Type.String({ minLength: 3, maxLength: 320 }),
    identifierType: IDENTIFIER_TYPE_SCHEMA,
    password: Type.String({ minLength: 12, maxLength: 256 }),
  },
  { additionalProperties: false },
);
export const REGISTER_RESPONSE_SCHEMA = Type.Object(
  { userId: Type.String({ format: "uuid" }) },
  { additionalProperties: false },
);
export const REGISTRATION_MODE_SCHEMA = Type.Union([
  Type.Literal("open"),
  Type.Literal("closed"),
]);
export const REGISTRATION_MODE_RESPONSE_SCHEMA = Type.Object(
  { mode: REGISTRATION_MODE_SCHEMA },
  { additionalProperties: false },
);
export const UPDATE_REGISTRATION_MODE_REQUEST_SCHEMA = Type.Object(
  {
    confirmationToken: Type.String({ minLength: 32, maxLength: 128 }),
    mode: REGISTRATION_MODE_SCHEMA,
  },
  { additionalProperties: false },
);
export const ACTION_CONFIRMATION_REQUEST_SCHEMA = Type.Object(
  {
    action: Type.String({ maxLength: 128, minLength: 1 }),
    payload: Type.Record(Type.String({ maxLength: 128 }), Type.Unknown()),
    targetId: Type.String({ maxLength: 1024, minLength: 1 }),
  },
  { additionalProperties: false },
);
export const ACTION_CONFIRMATION_RESPONSE_SCHEMA = Type.Object(
  {
    expiresAt: ISO_DATE_TIME_SCHEMA,
    token: Type.String({ minLength: 32, maxLength: 128 }),
  },
  { additionalProperties: false },
);
export const ADMIN_CREATE_USER_REQUEST_SCHEMA = Type.Object(
  {
    identifier: Type.String({ minLength: 3, maxLength: 320 }),
    identifierType: IDENTIFIER_TYPE_SCHEMA,
  },
  { additionalProperties: false },
);
export const ADMIN_CREATE_USER_RESPONSE_SCHEMA = Type.Object(
  {
    temporaryPassword: Type.String({ minLength: 12, maxLength: 256 }),
    temporaryPasswordExpiresAt: ISO_DATE_TIME_SCHEMA,
    userId: Type.String({ format: "uuid" }),
  },
  { additionalProperties: false },
);
export const ADMIN_USER_SCHEMA = Type.Object(
  {
    createdAt: ISO_DATE_TIME_SCHEMA,
    displayIdentifier: Type.String({ maxLength: 320 }),
    id: Type.String({ format: "uuid" }),
    identifierType: IDENTIFIER_TYPE_SCHEMA,
    mustChangePassword: Type.Boolean(),
    role: USER_ROLE_SCHEMA,
    status: Type.Union([
      Type.Literal("active"),
      Type.Literal("disabled"),
      Type.Literal("deleted"),
    ]),
  },
  { additionalProperties: false },
);
export const ADMIN_USER_LIST_RESPONSE_SCHEMA = Type.Object(
  { users: Type.Array(ADMIN_USER_SCHEMA, { maxItems: 1000 }) },
  { additionalProperties: false },
);
export const ADMIN_USER_ID_PARAMS_SCHEMA = Type.Object(
  { userId: Type.String({ format: "uuid" }) },
  { additionalProperties: false },
);
export const ADMIN_UPDATE_USER_REQUEST_SCHEMA = Type.Object(
  {
    confirmationToken: Type.String({ minLength: 32, maxLength: 128 }),
    identifier: Type.Optional(Type.String({ minLength: 3, maxLength: 320 })),
    identifierType: Type.Optional(IDENTIFIER_TYPE_SCHEMA),
    identityVerificationReference: Type.Optional(
      Type.String({ minLength: 1, maxLength: 256 }),
    ),
    role: Type.Optional(USER_ROLE_SCHEMA),
    status: Type.Optional(
      Type.Union([Type.Literal("active"), Type.Literal("disabled")]),
    ),
  },
  { additionalProperties: false },
);
export const ADMIN_CONFIRMED_ACTION_REQUEST_SCHEMA = Type.Object(
  {
    confirmationToken: Type.String({ minLength: 32, maxLength: 128 }),
    identityVerificationReference: Type.Optional(
      Type.String({ minLength: 1, maxLength: 256 }),
    ),
  },
  { additionalProperties: false },
);
export const CONFIRMED_ACTION_REQUEST_SCHEMA = Type.Object(
  { confirmationToken: Type.String({ minLength: 32, maxLength: 128 }) },
  { additionalProperties: false },
);
export const ADMIN_RESET_PASSWORD_RESPONSE_SCHEMA = Type.Object(
  {
    temporaryPassword: Type.String({ minLength: 12, maxLength: 256 }),
    temporaryPasswordExpiresAt: ISO_DATE_TIME_SCHEMA,
  },
  { additionalProperties: false },
);
export const STEP_UP_PASSWORD_REQUEST_SCHEMA = Type.Object(
  {
    password: Type.String({ minLength: 1, maxLength: 256 }),
    totpCode: Type.Optional(Type.String({ pattern: "^\\d{6}$" })),
  },
  { additionalProperties: false },
);
export const CHANGE_PASSWORD_REQUEST_SCHEMA = Type.Object(
  {
    currentPassword: Type.String({ minLength: 1, maxLength: 256 }),
    newPassword: Type.String({ minLength: 12, maxLength: 256 }),
  },
  { additionalProperties: false },
);
export const COMPLETE_TEMPORARY_PASSWORD_REQUEST_SCHEMA = Type.Object(
  { newPassword: Type.String({ minLength: 12, maxLength: 256 }) },
  { additionalProperties: false },
);
export const AUTH_STRENGTH_SCHEMA = Type.Union([
  Type.Literal("password"),
  Type.Literal("password_totp"),
  Type.Literal("password_recovery"),
  Type.Literal("passkey"),
]);
export const SESSION_SCHEMA = Type.Object(
  {
    authStrength: AUTH_STRENGTH_SCHEMA,
    browser: Type.String({ maxLength: 128 }),
    createdAt: ISO_DATE_TIME_SCHEMA,
    current: Type.Boolean(),
    deviceType: Type.String({ maxLength: 64 }),
    expiresAt: ISO_DATE_TIME_SCHEMA,
    id: Type.String({ format: "uuid" }),
    ipAddress: Type.String({ maxLength: 64 }),
    lastActiveAt: ISO_DATE_TIME_SCHEMA,
    location: Type.String({ maxLength: 128 }),
    operatingSystem: Type.String({ maxLength: 128 }),
    role: USER_ROLE_SCHEMA,
  },
  { additionalProperties: false },
);
export const LOGIN_RESPONSE_SCHEMA = Type.Object(
  {
    requiresPasswordChange: Type.Boolean(),
    requiresTotp: Type.Boolean(),
    role: USER_ROLE_SCHEMA,
    session: Type.Optional(SESSION_SCHEMA),
  },
  { additionalProperties: false },
);
export const SESSION_LIST_RESPONSE_SCHEMA = Type.Object(
  { sessions: Type.Array(SESSION_SCHEMA, { maxItems: 200 }) },
  { additionalProperties: false },
);
export const CSRF_TOKEN_RESPONSE_SCHEMA = Type.Object(
  { csrfToken: Type.String({ minLength: 1, maxLength: 512 }) },
  { additionalProperties: false },
);
export const SESSION_ID_PARAMS_SCHEMA = Type.Object(
  { sessionId: Type.String({ format: "uuid" }) },
  { additionalProperties: false },
);
export const AUTH_ACTION_RESPONSE_SCHEMA = Type.Object(
  { success: Type.Literal(true) },
  { additionalProperties: false },
);
export const REVOKE_OTHERS_RESPONSE_SCHEMA = Type.Object(
  { revokedCount: Type.Integer({ minimum: 0, maximum: 199 }) },
  { additionalProperties: false },
);

export type AuthStrength = Static<typeof AUTH_STRENGTH_SCHEMA>;
export type AdminCreateUserRequest = Static<
  typeof ADMIN_CREATE_USER_REQUEST_SCHEMA
>;
export type AdminCreateUserResponse = Static<
  typeof ADMIN_CREATE_USER_RESPONSE_SCHEMA
>;
export type AdminUser = Static<typeof ADMIN_USER_SCHEMA>;
export type AdminUserIdParams = Static<typeof ADMIN_USER_ID_PARAMS_SCHEMA>;
export type AdminUserListResponse = Static<
  typeof ADMIN_USER_LIST_RESPONSE_SCHEMA
>;
export type AdminUpdateUserRequest = Static<
  typeof ADMIN_UPDATE_USER_REQUEST_SCHEMA
>;
export type AdminConfirmedActionRequest = Static<
  typeof ADMIN_CONFIRMED_ACTION_REQUEST_SCHEMA
>;
export type ConfirmedActionRequest = Static<
  typeof CONFIRMED_ACTION_REQUEST_SCHEMA
>;
export type LoginRequest = Static<typeof LOGIN_REQUEST_SCHEMA>;
export type LoginResponse = Static<typeof LOGIN_RESPONSE_SCHEMA>;
export type TotpLoginRequest = Static<typeof TOTP_LOGIN_REQUEST_SCHEMA>;
export type TotpEnrollmentBeginResponse = Static<
  typeof TOTP_ENROLLMENT_BEGIN_RESPONSE_SCHEMA
>;
export type TotpEnrollmentConfirmResponse = Static<
  typeof TOTP_ENROLLMENT_CONFIRM_RESPONSE_SCHEMA
>;
export type TotpStatusResponse = Static<typeof TOTP_STATUS_RESPONSE_SCHEMA>;
export type WebauthnAuthenticationResponse = Static<
  typeof WEBAUTHN_AUTHENTICATION_RESPONSE_SCHEMA
>;
export type WebauthnRegistrationResponse = Static<
  typeof WEBAUTHN_REGISTRATION_RESPONSE_SCHEMA
>;
export type WebauthnOptionsResponse = Static<
  typeof WEBAUTHN_OPTIONS_RESPONSE_SCHEMA
>;
export type Passkey = Static<typeof PASSKEY_SCHEMA>;
export type PasskeyListResponse = Static<typeof PASSKEY_LIST_RESPONSE_SCHEMA>;
export type PasskeyIdParams = Static<typeof PASSKEY_ID_PARAMS_SCHEMA>;
export type RegisterRequest = Static<typeof REGISTER_REQUEST_SCHEMA>;
export type RegistrationMode = Static<typeof REGISTRATION_MODE_SCHEMA>;
export type Session = Static<typeof SESSION_SCHEMA>;
export type SessionIdParams = Static<typeof SESSION_ID_PARAMS_SCHEMA>;
export type SessionListResponse = Static<typeof SESSION_LIST_RESPONSE_SCHEMA>;
export type ActionConfirmationRequest = Static<
  typeof ACTION_CONFIRMATION_REQUEST_SCHEMA
>;
export type ActionConfirmationResponse = Static<
  typeof ACTION_CONFIRMATION_RESPONSE_SCHEMA
>;
export type AdminResetPasswordResponse = Static<
  typeof ADMIN_RESET_PASSWORD_RESPONSE_SCHEMA
>;
export type StepUpPasswordRequest = Static<
  typeof STEP_UP_PASSWORD_REQUEST_SCHEMA
>;
