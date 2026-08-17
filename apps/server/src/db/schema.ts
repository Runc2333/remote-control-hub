import {
  bigint,
  boolean,
  datetime,
  index,
  int,
  json,
  mysqlEnum,
  mysqlTable,
  primaryKey,
  uniqueIndex,
  varbinary,
  varchar,
} from "drizzle-orm/mysql-core";

const identifierType = mysqlEnum("identifier_type", ["email", "phone"]);
const userRole = mysqlEnum("role", ["admin", "user"]);
const userStatus = mysqlEnum("status", ["active", "disabled", "deleted"]);
const commandStatus = () =>
  mysqlEnum("status", [
    "created",
    "sent",
    "accepted",
    "executing",
    "succeeded",
    "failed",
    "expired",
    "outcome_unknown",
  ]);

export const installationRecords = mysqlTable("installation_records", {
  id: varchar("id", { length: 32 }).primaryKey(),
  deploymentMode: mysqlEnum("deployment_mode", [
    "compose",
    "standalone",
  ]).notNull(),
  installedAt: datetime("installed_at", { mode: "string", fsp: 3 }),
  schemaVersion: varchar("schema_version", { length: 64 }).notNull(),
  state: mysqlEnum("state", [
    "unconfigured",
    "config_staged",
    "migrating",
    "schema_ready",
    "admin_created",
    "installed",
  ]).notNull(),
  fencingToken: bigint("fencing_token", {
    mode: "number",
    unsigned: true,
  }).notNull(),
  updatedAt: datetime("updated_at", { mode: "string", fsp: 3 }).notNull(),
});

export const systemSettings = mysqlTable("system_settings", {
  key: varchar("key", { length: 128 }).primaryKey(),
  value: json("value").$type<unknown>().notNull(),
  updatedByUserId: varchar("updated_by_user_id", { length: 36 }),
  updatedAt: datetime("updated_at", { mode: "string", fsp: 3 }).notNull(),
});

export const users = mysqlTable(
  "users",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    identifierType: identifierType.notNull(),
    normalizedIdentifier: varchar("normalized_identifier", {
      length: 320,
    }).notNull(),
    displayIdentifier: varchar("display_identifier", { length: 320 }).notNull(),
    passwordHash: varchar("password_hash", { length: 512 }).notNull(),
    role: userRole.notNull(),
    status: userStatus.notNull().default("active"),
    mustChangePassword: boolean("must_change_password")
      .notNull()
      .default(false),
    temporaryPasswordExpiresAt: datetime("temporary_password_expires_at", {
      mode: "string",
      fsp: 3,
    }),
    webauthnUserHandle: varbinary("webauthn_user_handle", {
      length: 64,
    })
      .$type<Buffer>()
      .notNull(),
    createdAt: datetime("created_at", { mode: "string", fsp: 3 }).notNull(),
    updatedAt: datetime("updated_at", { mode: "string", fsp: 3 }).notNull(),
    deletedAt: datetime("deleted_at", { mode: "string", fsp: 3 }),
  },
  (table) => [
    uniqueIndex("users_identifier_unique").on(
      table.identifierType,
      table.normalizedIdentifier,
    ),
    index("users_status_role_idx").on(table.status, table.role),
  ],
);

export const webauthnCredentials = mysqlTable(
  "webauthn_credentials",
  {
    id: varchar("id", { length: 512 }).primaryKey(),
    userId: varchar("user_id", { length: 36 })
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    publicKey: varbinary("public_key", { length: 2048 })
      .$type<Buffer>()
      .notNull(),
    counter: bigint("counter", { mode: "number", unsigned: true }).notNull(),
    transports: json("transports").$type<string[]>().notNull(),
    deviceType: varchar("device_type", { length: 32 }).notNull(),
    backedUp: boolean("backed_up").notNull(),
    name: varchar("name", { length: 128 }).notNull(),
    createdAt: datetime("created_at", { mode: "string", fsp: 3 }).notNull(),
    lastUsedAt: datetime("last_used_at", { mode: "string", fsp: 3 }),
  },
  (table) => [index("webauthn_credentials_user_idx").on(table.userId)],
);

export const totpAuthenticators = mysqlTable(
  "totp_authenticators",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    userId: varchar("user_id", { length: 36 })
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    algorithm: varchar("algorithm", { length: 32 }).notNull(),
    keyVersion: int("key_version", { unsigned: true }).notNull(),
    nonce: varbinary("nonce", { length: 32 }).$type<Buffer>().notNull(),
    ciphertext: varbinary("ciphertext", { length: 512 })
      .$type<Buffer>()
      .notNull(),
    enabled: boolean("enabled").notNull().default(false),
    lastSuccessfulCounter: bigint("last_successful_counter", {
      mode: "number",
      unsigned: true,
    }),
    createdAt: datetime("created_at", { mode: "string", fsp: 3 }).notNull(),
    confirmedAt: datetime("confirmed_at", { mode: "string", fsp: 3 }),
    lastUsedAt: datetime("last_used_at", { mode: "string", fsp: 3 }),
  },
  (table) => [uniqueIndex("totp_authenticators_user_unique").on(table.userId)],
);

export const recoveryCodes = mysqlTable(
  "recovery_codes",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    userId: varchar("user_id", { length: 36 })
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    codeHash: varbinary("code_hash", { length: 32 }).$type<Buffer>().notNull(),
    createdAt: datetime("created_at", { mode: "string", fsp: 3 }).notNull(),
    usedAt: datetime("used_at", { mode: "string", fsp: 3 }),
    revoked: boolean("revoked").notNull().default(false),
  },
  (table) => [
    index("recovery_codes_user_active_idx").on(table.userId, table.revoked),
  ],
);

export const enrollmentTokens = mysqlTable(
  "enrollment_tokens",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    ownerUserId: varchar("owner_user_id", { length: 36 })
      .notNull()
      .references(() => users.id),
    tokenHash: varbinary("token_hash", { length: 32 }).notNull(),
    expiresAt: datetime("expires_at", { mode: "string", fsp: 3 }).notNull(),
    usedAt: datetime("used_at", { mode: "string", fsp: 3 }),
    createdAt: datetime("created_at", { mode: "string", fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex("enrollment_tokens_hash_unique").on(table.tokenHash),
    index("enrollment_tokens_owner_expiry_idx").on(
      table.ownerUserId,
      table.expiresAt,
    ),
  ],
);

export const devices = mysqlTable(
  "devices",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    ownerUserId: varchar("owner_user_id", { length: 36 })
      .notNull()
      .references(() => users.id),
    publicKey: varbinary("public_key", { length: 128 }).notNull(),
    computerName: varchar("computer_name", { length: 255 }).notNull(),
    platform: varchar("platform", { length: 64 }).notNull(),
    serviceVersion: varchar("service_version", { length: 64 }).notNull(),
    sessionVersion: varchar("session_version", { length: 64 }).notNull(),
    capabilities: json("capabilities").$type<string[]>().notNull(),
    disabledAt: datetime("disabled_at", { mode: "string", fsp: 3 }),
    credentialRevokedAt: datetime("credential_revoked_at", {
      mode: "string",
      fsp: 3,
    }),
    deletedAt: datetime("deleted_at", { mode: "string", fsp: 3 }),
    lastSeenAt: datetime("last_seen_at", { mode: "string", fsp: 3 }),
    createdAt: datetime("created_at", { mode: "string", fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex("devices_public_key_unique").on(table.publicKey),
    index("devices_owner_last_seen_idx").on(
      table.ownerUserId,
      table.lastSeenAt,
    ),
  ],
);

export const deviceSessions = mysqlTable(
  "device_sessions",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    deviceId: varchar("device_id", { length: 36 })
      .notNull()
      .references(() => devices.id),
    generation: bigint("generation", {
      mode: "number",
      unsigned: true,
    }).notNull(),
    connectedAt: datetime("connected_at", { mode: "string", fsp: 3 }).notNull(),
    disconnectedAt: datetime("disconnected_at", { mode: "string", fsp: 3 }),
    lastHeartbeatAt: datetime("last_heartbeat_at", {
      mode: "string",
      fsp: 3,
    }).notNull(),
    remoteAddress: varchar("remote_address", { length: 64 }).notNull(),
    closeReason: varchar("close_reason", { length: 128 }),
  },
  (table) => [
    uniqueIndex("device_sessions_generation_unique").on(
      table.deviceId,
      table.generation,
    ),
  ],
);

export const deviceGroups = mysqlTable(
  "device_groups",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    ownerUserId: varchar("owner_user_id", { length: 36 })
      .notNull()
      .references(() => users.id),
    name: varchar("name", { length: 128 }).notNull(),
    createdAt: datetime("created_at", { mode: "string", fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex("device_groups_owner_name_unique").on(
      table.ownerUserId,
      table.name,
    ),
  ],
);

export const deviceGroupMembers = mysqlTable(
  "device_group_members",
  {
    groupId: varchar("group_id", { length: 36 })
      .notNull()
      .references(() => deviceGroups.id, { onDelete: "cascade" }),
    deviceId: varchar("device_id", { length: 36 })
      .notNull()
      .references(() => devices.id, { onDelete: "cascade" }),
  },
  (table) => [primaryKey({ columns: [table.groupId, table.deviceId] })],
);

export const commandBatches = mysqlTable(
  "command_batches",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    ownerUserId: varchar("owner_user_id", { length: 36 })
      .notNull()
      .references(() => users.id),
    initiatedByUserId: varchar("initiated_by_user_id", { length: 36 })
      .notNull()
      .references(() => users.id),
    commandType: varchar("command_type", { length: 64 }).notNull(),
    targetCount: int("target_count", { unsigned: true }).notNull(),
    status: commandStatus().notNull(),
    idempotencyKey: varchar("idempotency_key", { length: 128 }).notNull(),
    requestDigest: varbinary("request_digest", { length: 32 }).notNull(),
    createdAt: datetime("created_at", { mode: "string", fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex("command_batches_owner_idempotency_unique").on(
      table.ownerUserId,
      table.idempotencyKey,
    ),
    index("command_batches_owner_created_idx").on(
      table.ownerUserId,
      table.createdAt,
    ),
  ],
);

export const commands = mysqlTable(
  "commands",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    batchId: varchar("batch_id", { length: 36 })
      .notNull()
      .references(() => commandBatches.id),
    ownerUserId: varchar("owner_user_id", { length: 36 })
      .notNull()
      .references(() => users.id),
    deviceId: varchar("device_id", { length: 36 })
      .notNull()
      .references(() => devices.id),
    status: commandStatus().notNull(),
    deviceSequence: bigint("device_sequence", {
      mode: "number",
      unsigned: true,
    }).notNull(),
    parameters: json("parameters").$type<Record<string, unknown>>().notNull(),
    expiresAt: datetime("expires_at", { mode: "string", fsp: 3 }).notNull(),
    createdAt: datetime("created_at", { mode: "string", fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex("commands_batch_device_unique").on(
      table.batchId,
      table.deviceId,
    ),
    uniqueIndex("commands_device_sequence_unique").on(
      table.deviceId,
      table.deviceSequence,
    ),
    index("commands_owner_status_idx").on(table.ownerUserId, table.status),
  ],
);

export const commandResults = mysqlTable(
  "command_results",
  {
    id: bigint("id", { mode: "number", unsigned: true })
      .autoincrement()
      .primaryKey(),
    commandId: varchar("command_id", { length: 36 })
      .notNull()
      .references(() => commands.id),
    status: commandStatus().notNull(),
    errorCode: varchar("error_code", { length: 128 }),
    receivedAt: datetime("received_at", { mode: "string", fsp: 3 }).notNull(),
    completedAt: datetime("completed_at", { mode: "string", fsp: 3 }),
  },
  (table) => [
    index("command_results_command_received_idx").on(
      table.commandId,
      table.receivedAt,
    ),
  ],
);

export const auditEvents = mysqlTable(
  "audit_events",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    occurredAt: datetime("occurred_at", { mode: "string", fsp: 3 }).notNull(),
    actorType: varchar("actor_type", { length: 32 }).notNull(),
    actorId: varchar("actor_id", { length: 64 }),
    subjectType: varchar("subject_type", { length: 64 }).notNull(),
    subjectId: varchar("subject_id", { length: 64 }).notNull(),
    ownerUserId: varchar("owner_user_id", { length: 36 }),
    action: varchar("action", { length: 128 }).notNull(),
    result: varchar("result", { length: 64 }).notNull(),
    errorCategory: varchar("error_category", { length: 64 }),
    requestId: varchar("request_id", { length: 128 }).notNull(),
    sourceAddressClass: varchar("source_address_class", {
      length: 32,
    }).notNull(),
    changeDigest: varbinary("change_digest", { length: 32 }),
    visibility: mysqlEnum("visibility", ["owner", "admin", "system"]).notNull(),
    metadata: json("metadata").$type<Record<string, unknown>>().notNull(),
  },
  (table) => [
    index("audit_events_owner_occurred_idx").on(
      table.ownerUserId,
      table.occurredAt,
    ),
    index("audit_events_action_occurred_idx").on(
      table.action,
      table.occurredAt,
    ),
  ],
);
