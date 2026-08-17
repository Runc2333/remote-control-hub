import { execFileSync } from "node:child_process";

const ALLOWED_LICENSES = new Set([
  "(CC-BY-4.0 AND MIT)",
  "0BSD",
  "AGPL-3.0-or-later",
  "Apache-2.0",
  "Apache-2.0 OR MIT",
  "BlueOak-1.0.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "CC-BY-4.0",
  "ISC",
  "MIT",
]);

const packageManager = process.env.npm_execpath;
if (packageManager === undefined) {
  throw new Error("pnpm executable is unavailable");
}
const output = execFileSync(
  process.execPath,
  [packageManager, "licenses", "list", "--prod", "--json"],
  {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    stdio: ["ignore", "pipe", "inherit"],
  },
);
const report = JSON.parse(output);
if (typeof report !== "object" || report === null || Array.isArray(report)) {
  throw new Error("Invalid pnpm license report");
}
const rejected = Object.keys(report).filter(
  (license) => !ALLOWED_LICENSES.has(license),
);
if (rejected.length > 0) {
  throw new Error(`Disallowed production licenses: ${rejected.join(", ")}`);
}
