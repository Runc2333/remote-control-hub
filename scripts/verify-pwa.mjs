import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";

const REPOSITORY_ROOT = resolve(import.meta.dirname, "..");
const DISTRIBUTION_DIRECTORY = resolve(REPOSITORY_ROOT, "apps/web/dist");
const MANIFEST_PATH = resolve(DISTRIBUTION_DIRECTORY, "app-version.json");
const INDEX_PATH = resolve(DISTRIBUTION_DIRECTORY, "index.html");
const WORKER_PATH = resolve(DISTRIBUTION_DIRECTORY, "sw.js");
const CADDY_PATH = resolve(REPOSITORY_ROOT, "deploy/Caddyfile");
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
    } else {
      files.push(path);
    }
  }
  return files;
};

const digest = (body) => createHash("sha256").update(body).digest("hex");

const manifestBody = await readFile(MANIFEST_PATH);
const manifest = JSON.parse(manifestBody.toString("utf8"));
if (
  typeof manifest !== "object" ||
  manifest === null ||
  !/^[a-f0-9]{64}$/u.test(manifest.releaseId) ||
  !Array.isArray(manifest.resources) ||
  manifest.resources.length === 0 ||
  manifest.resources.length > MAX_RESOURCES
) {
  throw new Error("Invalid app-version.json");
}
const expectedFiles = (await collectFiles(DISTRIBUTION_DIRECTORY))
  .filter((path) => path !== MANIFEST_PATH && path !== WORKER_PATH)
  .map(
    (path) => `/${relative(DISTRIBUTION_DIRECTORY, path).split(sep).join("/")}`,
  )
  .sort();
const declaredFiles = manifest.resources.map((resource) => resource.url).sort();
if (JSON.stringify(expectedFiles) !== JSON.stringify(declaredFiles)) {
  throw new Error("Release resource list does not match the build output");
}
let totalBytes = 0;
for (const resource of manifest.resources) {
  if (
    typeof resource.url !== "string" ||
    !resource.url.startsWith("/") ||
    resource.url === "/sw.js" ||
    resource.url === "/app-version.json"
  ) {
    throw new Error(`Invalid release URL: ${String(resource.url)}`);
  }
  const body = await readFile(
    resolve(DISTRIBUTION_DIRECTORY, resource.url.slice(1)),
  );
  if (
    body.byteLength === 0 ||
    body.byteLength > MAX_RESOURCE_BYTES ||
    body.byteLength !== resource.bytes ||
    digest(body) !== resource.sha256
  ) {
    throw new Error(`Release resource validation failed: ${resource.url}`);
  }
  totalBytes += body.byteLength;
}
if (totalBytes !== manifest.totalBytes || totalBytes > MAX_RELEASE_BYTES) {
  throw new Error("Release total byte count is invalid");
}
for (const required of [
  "/index.html",
  "/manifest.webmanifest",
  "/icons/192x192.png",
  "/icons/512x512.png",
  "/icons/maskable-512x512.png",
]) {
  if (!declaredFiles.includes(required)) {
    throw new Error(`Required PWA resource is missing: ${required}`);
  }
}
const workerBody = await readFile(WORKER_PATH);
if (workerBody.includes(Buffer.from(manifest.releaseId))) {
  throw new Error("Service Worker embeds the application release ID");
}
const workerDigest = digest(workerBody);
const indexBody = await readFile(INDEX_PATH);
const indexText = indexBody.toString("utf8");
const inlineScript = /<script>([\s\S]*?)<\/script>/u.exec(indexText)?.[1];
const caddy = await readFile(CADDY_PATH, "utf8");
if (inlineScript === undefined) {
  throw new Error("PWA startup guard is missing");
}
const inlineScriptDigest = createHash("sha256")
  .update(inlineScript)
  .digest("base64");
if (
  !caddy.includes(`'sha256-${inlineScriptDigest}'`) ||
  !caddy.includes("frame-ancestors 'none'") ||
  !caddy.includes("object-src 'none'")
) {
  throw new Error("PWA content security policy is inconsistent");
}
try {
  await writeFile(INDEX_PATH, Buffer.concat([indexBody, Buffer.from("\n")]));
  const changedIndex = await readFile(INDEX_PATH);
  if (digest(changedIndex) === digest(indexBody)) {
    throw new Error("Application release mutation was not observable");
  }
  if (digest(await readFile(WORKER_PATH)) !== workerDigest) {
    throw new Error("Application release mutation changed the Service Worker");
  }
} finally {
  await writeFile(INDEX_PATH, indexBody);
  await writeFile(MANIFEST_PATH, manifestBody);
}
