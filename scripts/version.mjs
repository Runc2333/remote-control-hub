import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const REPOSITORY_ROOT = resolve(import.meta.dirname, "..");
const VERSION_PATH = resolve(REPOSITORY_ROOT, "VERSION");
const CARGO_MANIFEST_PATH = resolve(REPOSITORY_ROOT, "agent/Cargo.toml");
const TAURI_CONFIG_PATH = resolve(
  REPOSITORY_ROOT,
  "agent/apps/agent-session/src-tauri/tauri.conf.json",
);
const TAURI_VERSION_SOURCE = "../../../../package.json";
const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const CARGO_COMMAND = process.platform === "win32" ? "cargo.exe" : "cargo";
const PNPM_EXECUTABLE = process.env.npm_execpath;

const run = (command, commandArguments, options = {}) => {
  const result = spawnSync(command, commandArguments, {
    cwd: REPOSITORY_ROOT,
    encoding: "utf8",
    stdio: options.capture ? "pipe" : "inherit",
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    const detail = options.capture
      ? [result.stdout, result.stderr].filter(Boolean).join("\n").trim()
      : "";
    throw new Error(
      `${command} exited with code ${result.status}${detail ? `:\n${detail}` : ""}`,
    );
  }
  return result.stdout;
};

const runPnpm = (commandArguments, options) => {
  if (!PNPM_EXECUTABLE) {
    throw new Error("Run this script through pnpm.");
  }
  return run(process.execPath, [PNPM_EXECUTABLE, ...commandArguments], options);
};

const readVersion = async () => {
  const version = (await readFile(VERSION_PATH, "utf8")).trim();
  if (!SEMVER_PATTERN.test(version)) {
    throw new Error(`VERSION is not valid SemVer: ${version}`);
  }
  return version;
};

const listPnpmPackages = () =>
  JSON.parse(
    runPnpm(["list", "--recursive", "--depth", "-1", "--json"], {
      capture: true,
    }),
  );

const syncVersions = async (version) => {
  if (listPnpmPackages().some((pkg) => pkg.version !== version)) {
    runPnpm([
      "--recursive",
      "--include-workspace-root",
      "exec",
      "npm",
      "pkg",
      "set",
      `version=${version}`,
    ]);
  }

  const cargoMetadata = JSON.parse(
    run(
      CARGO_COMMAND,
      [
        "metadata",
        "--manifest-path",
        CARGO_MANIFEST_PATH,
        "--no-deps",
        "--format-version",
        "1",
      ],
      { capture: true },
    ),
  );
  if (cargoMetadata.packages.some((pkg) => pkg.version !== version)) {
    run(CARGO_COMMAND, [
      "set-version",
      "--manifest-path",
      CARGO_MANIFEST_PATH,
      "--workspace",
      version,
    ]);
  }
};

const checkVersions = async (version) => {
  const mismatches = [];
  for (const workspacePackage of listPnpmPackages()) {
    if (workspacePackage.version !== version) {
      mismatches.push(
        `${resolve(workspacePackage.path, "package.json")}: ${workspacePackage.version ?? "missing"}`,
      );
    }
  }

  const cargoMetadata = JSON.parse(
    run(
      CARGO_COMMAND,
      [
        "metadata",
        "--manifest-path",
        CARGO_MANIFEST_PATH,
        "--locked",
        "--no-deps",
        "--format-version",
        "1",
      ],
      { capture: true },
    ),
  );
  for (const pkg of cargoMetadata.packages) {
    if (pkg.version !== version) {
      mismatches.push(`${pkg.manifest_path}: ${pkg.version}`);
    }
  }

  const tauriConfig = JSON.parse(await readFile(TAURI_CONFIG_PATH, "utf8"));
  if (tauriConfig.version !== TAURI_VERSION_SOURCE) {
    mismatches.push(
      `${TAURI_CONFIG_PATH}: ${tauriConfig.version ?? "missing"}`,
    );
  }

  if (mismatches.length > 0) {
    throw new Error(
      `Version metadata does not match VERSION (${version}):\n${mismatches.join("\n")}\nRun pnpm version:sync.`,
    );
  }
};

const mode = process.argv[2] ?? "--check";
if (mode !== "--check" && mode !== "--write") {
  throw new Error(`Unknown mode: ${mode}`);
}

const version = await readVersion();
if (mode === "--write") {
  await syncVersions(version);
}
await checkVersions(version);
console.log(`Version metadata is synchronized at ${version}.`);
