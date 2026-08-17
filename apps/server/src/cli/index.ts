import { resolve } from "node:path";
import { loadConfig } from "../config.js";
import {
  applyMigrations,
  getMigrationStatus,
  getSetupManagementStatus,
  issueSetupSecret,
  reconcileSetup,
} from "./setup-management.js";
import { rotateTotpKey } from "./totp-key-rotation.js";

const argumentValue = (name: string): string | undefined => {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
};

const [command, action] = process.argv.slice(2);
const config = loadConfig();
let result: unknown;

if (command === "totp-key" && action === "rotate") {
  const keyringFile = argumentValue("--keyring-file");
  if (
    keyringFile === undefined ||
    argumentValue("--confirm") !== "ROTATE_TOTP_KEY"
  ) {
    throw new Error("totp_key_rotation_confirmation_required");
  }
  result = await rotateTotpKey(config, resolve(keyringFile));
} else if (
  command === "setup-secret" &&
  (action === "issue" || action === "rotate")
) {
  const expectedConfirmation =
    action === "issue" ? "ISSUE_SETUP_SECRET" : "ROTATE_SETUP_SECRET";
  if (argumentValue("--confirm") !== expectedConfirmation) {
    throw new Error("setup_secret_confirmation_required");
  }
  const ttlSeconds = Number.parseInt(
    argumentValue("--ttl-seconds") ?? "600",
    10,
  );
  result = await issueSetupSecret(config, action === "rotate", ttlSeconds);
} else if (command === "setup" && action === "status") {
  result = await getSetupManagementStatus(config);
} else if (command === "setup" && action === "reconcile") {
  const backupReference = argumentValue("--backup-reference");
  if (
    backupReference === undefined ||
    argumentValue("--confirm") !== "RECONCILE_SETUP_STATE"
  ) {
    throw new Error("setup_reconcile_confirmation_required");
  }
  result = await reconcileSetup(config, backupReference);
} else if (command === "migration" && action === "status") {
  result = await getMigrationStatus(config);
} else if (command === "migration" && action === "apply") {
  if (argumentValue("--confirm") !== "APPLY_DATABASE_MIGRATIONS") {
    throw new Error("migration_apply_confirmation_required");
  }
  result = await applyMigrations(config);
} else {
  throw new Error(
    "usage: cli setup-secret issue|rotate | setup status|reconcile | migration status|apply | totp-key rotate",
  );
}

process.stdout.write(`${JSON.stringify(result)}\n`);
