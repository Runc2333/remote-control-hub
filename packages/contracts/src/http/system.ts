import { Type, type Static } from "typebox";
import {
  API_VERSION,
  ISO_DATE_TIME_SCHEMA,
  WORKER_PROTOCOL_VERSION,
} from "../common.js";

export const DEPLOYMENT_MODE_SCHEMA = Type.Union([
  Type.Literal("compose"),
  Type.Literal("standalone"),
]);
export const SETUP_STEP_SCHEMA = Type.Union([
  Type.Literal("unconfigured"),
  Type.Literal("config_staged"),
  Type.Literal("migrating"),
  Type.Literal("schema_ready"),
  Type.Literal("admin_created"),
  Type.Literal("installed"),
]);
export const HEALTH_RESPONSE_SCHEMA = Type.Object(
  {
    status: Type.Literal("ok"),
    timestamp: ISO_DATE_TIME_SCHEMA,
  },
  { additionalProperties: false },
);
export const OPERATIONAL_UNAVAILABLE_RESPONSE_SCHEMA = Type.Object(
  {
    reason: Type.Union([
      Type.Literal("setup_incomplete"),
      Type.Literal("dependency_unavailable"),
    ]),
    status: Type.Literal("unavailable"),
    timestamp: ISO_DATE_TIME_SCHEMA,
  },
  { additionalProperties: false },
);
export const META_VERSION_RESPONSE_SCHEMA = Type.Object(
  {
    apiVersion: Type.Literal(API_VERSION),
    minimumWebRelease: Type.String({ minLength: 1 }),
    releaseId: Type.String({ minLength: 1 }),
    workerProtocolVersion: Type.Literal(WORKER_PROTOCOL_VERSION),
  },
  { additionalProperties: false },
);
export const SETUP_STATUS_RESPONSE_SCHEMA = Type.Object(
  {
    deploymentMode: DEPLOYMENT_MODE_SCHEMA,
    installed: Type.Boolean(),
    step: SETUP_STEP_SCHEMA,
  },
  { additionalProperties: false },
);
export const ADMIN_SYSTEM_SUMMARY_RESPONSE_SCHEMA = Type.Object(
  {
    activeBrowserSessions: Type.Integer({ minimum: 0 }),
    agentVersions: Type.Array(
      Type.Object(
        {
          online: Type.Integer({ minimum: 0 }),
          registered: Type.Integer({ minimum: 0 }),
          serviceVersion: Type.String({ minLength: 1, maxLength: 64 }),
          sessionVersion: Type.String({ minLength: 1, maxLength: 64 }),
        },
        { additionalProperties: false },
      ),
      { maxItems: 1000 },
    ),
    capacityWarnings: Type.Array(
      Type.Union([
        Type.Literal("active_browser_sessions"),
        Type.Literal("online_agents"),
        Type.Literal("registered_devices"),
      ]),
      { uniqueItems: true },
    ),
    checkedAt: ISO_DATE_TIME_SCHEMA,
    onlineAgents: Type.Integer({ minimum: 0 }),
    registeredDevices: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);

export type DeploymentMode = Static<typeof DEPLOYMENT_MODE_SCHEMA>;
export type HealthResponse = Static<typeof HEALTH_RESPONSE_SCHEMA>;
export type MetaVersionResponse = Static<typeof META_VERSION_RESPONSE_SCHEMA>;
export type OperationalUnavailableResponse = Static<
  typeof OPERATIONAL_UNAVAILABLE_RESPONSE_SCHEMA
>;
export type SetupStatusResponse = Static<typeof SETUP_STATUS_RESPONSE_SCHEMA>;
export type AdminSystemSummaryResponse = Static<
  typeof ADMIN_SYSTEM_SUMMARY_RESPONSE_SCHEMA
>;
export type SetupStep = Static<typeof SETUP_STEP_SCHEMA>;
