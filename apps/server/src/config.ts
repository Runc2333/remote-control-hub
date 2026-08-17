import { join } from "node:path";
import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { existsSync, readFileSync } from "node:fs";
import type {
  DeploymentMode,
  MysqlConnection,
  RedisConnection,
} from "@remote-control-hub/contracts";

export type ServerConfig = {
  appOrigin?: string;
  cookieSecret?: string;
  deploymentMode: DeploymentMode;
  geoIpDatabase?: string;
  host: string;
  port: number;
  releaseId: string;
  migrationsFolder: string;
  mysqlConnection?: MysqlConnection;
  redisConnection?: RedisConnection;
  setupSecretDigest?: string;
  setupSecretExpiresAt?: string;
  setupSecretFile?: string;
  operationsAuditFile?: string;
  setupConfigFile: string;
  setupStateFile: string;
  trustedProxies?: readonly string[];
  totpKeyring?: {
    currentVersion: number;
    keys: ReadonlyMap<number, Uint8Array>;
  };
  totpKeyringFile?: string;
  webauthn?: {
    origins: readonly string[];
    rpId: string;
    rpName: string;
  };
  webRoot?: string;
};

const parsePort = (value: string | undefined): number => {
  const parsed = Number.parseInt(value ?? "3000", 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error("PORT must be an integer between 1 and 65535");
  }
  return parsed;
};

const parseDatabase = (value: string | undefined): number => {
  const parsed = Number.parseInt(value ?? "0", 10);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 15) {
    throw new Error("REDIS_DATABASE must be an integer between 0 and 15");
  }
  return parsed;
};

const parseTrustedProxies = (
  value: string | undefined,
): readonly string[] | undefined => {
  if (value === undefined) {
    return undefined;
  }
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > 16) {
    throw new Error("TRUSTED_PROXIES must be a non-empty JSON array");
  }
  return parsed.map((entry: unknown) => {
    if (typeof entry !== "string") {
      throw new Error("TRUSTED_PROXIES entries must be strings");
    }
    const [address, prefix, extra] = entry.split("/");
    if (address === undefined) {
      throw new Error("TRUSTED_PROXIES entries must be IP addresses or CIDRs");
    }
    const version = isIP(address);
    const maximumPrefix = version === 4 ? 32 : 128;
    const parsedPrefix = prefix === undefined ? maximumPrefix : Number(prefix);
    if (
      extra !== undefined ||
      version === 0 ||
      !Number.isInteger(parsedPrefix) ||
      parsedPrefix < 0 ||
      parsedPrefix > maximumPrefix
    ) {
      throw new Error("TRUSTED_PROXIES entries must be IP addresses or CIDRs");
    }
    return prefix === undefined ? address : `${address}/${parsedPrefix}`;
  });
};

const parseTotpKeyring = (
  serialized: string | undefined,
  currentVersionValue: string | undefined,
): ServerConfig["totpKeyring"] => {
  if (serialized === undefined && currentVersionValue === undefined) {
    return undefined;
  }
  if (serialized === undefined || currentVersionValue === undefined) {
    throw new Error(
      "TOTP_KEYRING and TOTP_CURRENT_KEY_VERSION must be configured together",
    );
  }
  const currentVersion = Number.parseInt(currentVersionValue, 10);
  if (!Number.isSafeInteger(currentVersion) || currentVersion < 1) {
    throw new Error("TOTP_CURRENT_KEY_VERSION must be a positive integer");
  }
  const parsed: unknown = JSON.parse(serialized);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("TOTP_KEYRING must be a JSON object");
  }
  const keys = new Map<number, Uint8Array>();
  for (const [versionText, encoded] of Object.entries(parsed)) {
    const version = Number.parseInt(versionText, 10);
    if (
      !Number.isSafeInteger(version) ||
      version < 1 ||
      version.toString() !== versionText ||
      typeof encoded !== "string"
    ) {
      throw new Error("TOTP_KEYRING contains an invalid key version");
    }
    const key = Buffer.from(encoded, "base64");
    if (key.byteLength !== 32 || key.toString("base64") !== encoded) {
      throw new Error("TOTP_KEYRING keys must be canonical 32-byte base64");
    }
    keys.set(version, key);
  }
  if (!keys.has(currentVersion)) {
    throw new Error("TOTP_KEYRING does not contain the current key version");
  }
  return { currentVersion, keys };
};

const parseWebauthn = (
  rpIdValue: string | undefined,
  originsValue: string | undefined,
  rpNameValue: string | undefined,
): ServerConfig["webauthn"] => {
  if (
    rpIdValue === undefined &&
    originsValue === undefined &&
    rpNameValue === undefined
  ) {
    return undefined;
  }
  if (rpIdValue === undefined || originsValue === undefined) {
    throw new Error(
      "WEBAUTHN_RP_ID and WEBAUTHN_ORIGINS must be configured together",
    );
  }
  const rpId = rpIdValue.toLowerCase();
  if (
    !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(
      rpId,
    )
  ) {
    throw new Error("WEBAUTHN_RP_ID must be a valid DNS name");
  }
  const parsed: unknown = JSON.parse(originsValue);
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > 8) {
    throw new Error("WEBAUTHN_ORIGINS must be a non-empty JSON array");
  }
  const origins = parsed.map((value: unknown) => {
    if (typeof value !== "string") {
      throw new Error("WEBAUTHN_ORIGINS entries must be strings");
    }
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.origin !== value ||
      (url.hostname !== rpId && !url.hostname.endsWith(`.${rpId}`))
    ) {
      throw new Error(
        "WEBAUTHN_ORIGINS entries must be HTTPS origins within the RP ID",
      );
    }
    return url.origin;
  });
  return {
    origins: [...new Set(origins)],
    rpId,
    rpName: rpNameValue?.trim() || "Remote Control Hub",
  };
};

export const loadConfig = (environment = process.env): ServerConfig => {
  const deploymentMode = environment.DEPLOYMENT_MODE ?? "standalone";
  if (deploymentMode !== "compose" && deploymentMode !== "standalone") {
    throw new Error("DEPLOYMENT_MODE must be compose or standalone");
  }
  const config: ServerConfig = {
    deploymentMode,
    host: environment.HOST ?? "0.0.0.0",
    migrationsFolder:
      environment.MIGRATIONS_FOLDER ?? join(process.cwd(), "drizzle"),
    port: parsePort(environment.PORT),
    releaseId: environment.RELEASE_ID ?? "development",
    setupStateFile:
      environment.SETUP_STATE_FILE ??
      join(process.cwd(), "state", "setup-state.json"),
    setupConfigFile:
      environment.SETUP_CONFIG_FILE ??
      join(process.cwd(), "state", "setup-config.json"),
    setupSecretFile:
      environment.SETUP_SECRET_FILE ??
      join(process.cwd(), "state", "setup-secret.json"),
    operationsAuditFile:
      environment.OPERATIONS_AUDIT_FILE ??
      join(process.cwd(), "state", "operations-audit.jsonl"),
  };
  if (environment.APP_ORIGIN !== undefined) {
    const origin = new URL(environment.APP_ORIGIN);
    if (
      origin.protocol !== "https:" ||
      origin.origin !== origin.href.replace(/\/$/u, "")
    ) {
      throw new Error("APP_ORIGIN must be an HTTPS origin without a path");
    }
    config.appOrigin = origin.origin;
  }
  if (environment.COOKIE_SECRET !== undefined) {
    if (environment.COOKIE_SECRET.length < 32) {
      throw new Error("COOKIE_SECRET must contain at least 32 characters");
    }
    config.cookieSecret = environment.COOKIE_SECRET;
  }
  if (environment.WEB_ROOT !== undefined) {
    config.webRoot = environment.WEB_ROOT;
  }
  if (environment.GEOIP_DATABASE !== undefined) {
    config.geoIpDatabase = environment.GEOIP_DATABASE;
  }
  const trustedProxies = parseTrustedProxies(environment.TRUSTED_PROXIES);
  if (trustedProxies !== undefined) {
    config.trustedProxies = trustedProxies;
  }
  if (
    environment.TOTP_KEYRING_FILE !== undefined &&
    (environment.TOTP_KEYRING !== undefined ||
      environment.TOTP_CURRENT_KEY_VERSION !== undefined)
  ) {
    throw new Error(
      "TOTP_KEYRING_FILE cannot be combined with TOTP_KEYRING environment values",
    );
  }
  let serializedKeyring = environment.TOTP_KEYRING;
  let currentKeyVersion = environment.TOTP_CURRENT_KEY_VERSION;
  if (environment.TOTP_KEYRING_FILE !== undefined) {
    const document: unknown = JSON.parse(
      readFileSync(environment.TOTP_KEYRING_FILE, "utf8"),
    );
    if (typeof document !== "object" || document === null) {
      throw new Error("TOTP_KEYRING_FILE must contain a JSON object");
    }
    const record = document as Record<string, unknown>;
    if (
      !Number.isSafeInteger(record.currentVersion) ||
      typeof record.currentVersion !== "number" ||
      typeof record.keys !== "object" ||
      record.keys === null
    ) {
      throw new Error("TOTP_KEYRING_FILE must contain currentVersion and keys");
    }
    serializedKeyring = JSON.stringify(record.keys);
    currentKeyVersion = record.currentVersion.toString();
    config.totpKeyringFile = environment.TOTP_KEYRING_FILE;
  }
  const totpKeyring = parseTotpKeyring(serializedKeyring, currentKeyVersion);
  if (totpKeyring !== undefined) {
    config.totpKeyring = totpKeyring;
  }
  const webauthn = parseWebauthn(
    environment.WEBAUTHN_RP_ID,
    environment.WEBAUTHN_ORIGINS,
    environment.WEBAUTHN_RP_NAME,
  );
  if (webauthn !== undefined) {
    config.webauthn = webauthn;
  }
  if (environment.SETUP_SECRET !== undefined) {
    config.setupSecretDigest = createHash("sha256")
      .update(environment.SETUP_SECRET, "utf8")
      .digest("hex");
  } else if (
    config.setupSecretFile !== undefined &&
    existsSync(config.setupSecretFile)
  ) {
    const document: unknown = JSON.parse(
      readFileSync(config.setupSecretFile, "utf8"),
    );
    if (typeof document !== "object" || document === null) {
      throw new Error("SETUP_SECRET_FILE must contain a JSON object");
    }
    const record = document as Record<string, unknown>;
    if (
      typeof record.digest !== "string" ||
      !/^[a-f0-9]{64}$/u.test(record.digest) ||
      typeof record.expiresAt !== "string" ||
      !Number.isFinite(Date.parse(record.expiresAt))
    ) {
      throw new Error("SETUP_SECRET_FILE is invalid");
    }
    config.setupSecretDigest = record.digest;
    config.setupSecretExpiresAt = record.expiresAt;
  }
  if (
    environment.MYSQL_DATABASE !== undefined &&
    environment.MYSQL_HOST !== undefined &&
    environment.MYSQL_PASSWORD !== undefined &&
    environment.MYSQL_USER !== undefined
  ) {
    config.mysqlConnection = {
      database: environment.MYSQL_DATABASE,
      host: environment.MYSQL_HOST,
      password: environment.MYSQL_PASSWORD,
      port: parsePort(environment.MYSQL_PORT ?? "3306"),
      tls: environment.MYSQL_TLS === "true",
      username: environment.MYSQL_USER,
    };
  }
  if (
    environment.REDIS_HOST !== undefined &&
    environment.REDIS_PASSWORD !== undefined
  ) {
    config.redisConnection = {
      database: parseDatabase(environment.REDIS_DATABASE),
      host: environment.REDIS_HOST,
      password: environment.REDIS_PASSWORD,
      port: parsePort(environment.REDIS_PORT ?? "6379"),
      tls: environment.REDIS_TLS === "true",
      ...(environment.REDIS_USER === undefined
        ? {}
        : { username: environment.REDIS_USER }),
    };
  }
  return config;
};
