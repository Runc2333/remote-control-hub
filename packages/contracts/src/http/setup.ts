import { Type, type Static } from "typebox";
import { IDENTIFIER_TYPE_SCHEMA } from "../common.js";

export const MYSQL_CONNECTION_SCHEMA = Type.Object(
  {
    database: Type.String({ minLength: 1, maxLength: 64 }),
    host: Type.String({ minLength: 1, maxLength: 255 }),
    password: Type.String({ minLength: 1, maxLength: 1024 }),
    port: Type.Integer({ minimum: 1, maximum: 65535 }),
    tls: Type.Boolean(),
    username: Type.String({ minLength: 1, maxLength: 128 }),
  },
  { additionalProperties: false },
);
export const REDIS_CONNECTION_SCHEMA = Type.Object(
  {
    database: Type.Integer({ minimum: 0, maximum: 15 }),
    host: Type.String({ minLength: 1, maxLength: 255 }),
    password: Type.Optional(Type.String({ minLength: 1, maxLength: 1024 })),
    port: Type.Integer({ minimum: 1, maximum: 65535 }),
    tls: Type.Boolean(),
    username: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
  },
  { additionalProperties: false },
);
export const TEST_DATA_SERVICE_REQUEST_SCHEMA = Type.Union([
  Type.Object(
    {
      connection: Type.Optional(MYSQL_CONNECTION_SCHEMA),
      service: Type.Literal("mysql"),
      setupSecret: Type.String({ minLength: 16, maxLength: 512 }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      connection: Type.Optional(REDIS_CONNECTION_SCHEMA),
      service: Type.Literal("redis"),
      setupSecret: Type.String({ minLength: 16, maxLength: 512 }),
    },
    { additionalProperties: false },
  ),
]);
export const TEST_DATA_SERVICE_RESPONSE_SCHEMA = Type.Object(
  {
    category: Type.Optional(
      Type.Union([
        Type.Literal("dns"),
        Type.Literal("network"),
        Type.Literal("tls"),
        Type.Literal("authentication"),
        Type.Literal("permissions"),
        Type.Literal("version"),
      ]),
    ),
    ok: Type.Boolean(),
  },
  { additionalProperties: false },
);
export const COMPLETE_SETUP_REQUEST_SCHEMA = Type.Object(
  {
    administrator: Type.Object(
      {
        identifier: Type.String({ minLength: 3, maxLength: 320 }),
        identifierType: IDENTIFIER_TYPE_SCHEMA,
        password: Type.String({ minLength: 12, maxLength: 256 }),
      },
      { additionalProperties: false },
    ),
    idempotencyKey: Type.String({ minLength: 16, maxLength: 128 }),
    connections: Type.Optional(
      Type.Object(
        {
          mysql: MYSQL_CONNECTION_SCHEMA,
          redis: REDIS_CONNECTION_SCHEMA,
        },
        { additionalProperties: false },
      ),
    ),
    setupSecret: Type.String({ minLength: 16, maxLength: 512 }),
  },
  { additionalProperties: false },
);

export type CompleteSetupRequest = Static<typeof COMPLETE_SETUP_REQUEST_SCHEMA>;
export type MysqlConnection = Static<typeof MYSQL_CONNECTION_SCHEMA>;
export type RedisConnection = Static<typeof REDIS_CONNECTION_SCHEMA>;
export type TestDataServiceRequest = Static<
  typeof TEST_DATA_SERVICE_REQUEST_SCHEMA
>;
export type TestDataServiceResponse = Static<
  typeof TEST_DATA_SERVICE_RESPONSE_SCHEMA
>;
