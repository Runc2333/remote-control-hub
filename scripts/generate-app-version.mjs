import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";

const REPOSITORY_ROOT = resolve(import.meta.dirname, "..");
const DISTRIBUTION_DIRECTORY = resolve(REPOSITORY_ROOT, "apps/web/dist");
const MAX_RESOURCES = 256;
const MAX_RESOURCE_BYTES = 8 * 1024 * 1024;
const MAX_RELEASE_BYTES = 32 * 1024 * 1024;

const collectFiles = async (directory) => {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(path)));
    } else if (entry.name !== "app-version.json" && entry.name !== "sw.js") {
      files.push(path);
    }
  }
  return files;
};

const resources = [];
for (const path of (await collectFiles(DISTRIBUTION_DIRECTORY)).sort()) {
  const body = await readFile(path);
  if (body.byteLength === 0 || body.byteLength > MAX_RESOURCE_BYTES) {
    throw new Error(`Invalid release resource size: ${path}`);
  }
  resources.push({
    bytes: body.byteLength,
    sha256: createHash("sha256").update(body).digest("hex"),
    url: `/${relative(DISTRIBUTION_DIRECTORY, path).split(sep).join("/")}`,
  });
}
if (resources.length === 0 || resources.length > MAX_RESOURCES) {
  throw new Error(`Invalid release resource count: ${resources.length}`);
}
const totalBytes = resources.reduce(
  (total, resource) => total + resource.bytes,
  0,
);
if (totalBytes > MAX_RELEASE_BYTES) {
  throw new Error(`Release exceeds ${MAX_RELEASE_BYTES} bytes`);
}
const releaseId = createHash("sha256")
  .update(
    resources
      .map((resource) => `${resource.url}:${resource.sha256}`)
      .join("\n"),
  )
  .digest("hex");
const manifest = {
  apiCompatibility: { maximum: "v1", minimum: "v1" },
  builtAt: new Date().toISOString(),
  releaseId,
  resources,
  totalBytes,
  version: process.env.npm_package_version ?? "0.1.0",
  workerCompatibility: { maximum: 1, minimum: 1 },
};

await writeFile(
  resolve(DISTRIBUTION_DIRECTORY, "app-version.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
  "utf8",
);
