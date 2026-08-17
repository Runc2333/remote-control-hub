import { createHash } from "node:crypto";

const origin = process.argv[2];
if (origin === undefined) {
  throw new Error("Application origin is required");
}
const manifestUrl = new URL("/app-version.json", origin);
const manifestResponse = await fetch(manifestUrl, {
  cache: "no-store",
  redirect: "error",
});
if (
  manifestResponse.status !== 200 ||
  manifestResponse.redirected ||
  !manifestResponse.headers.get("content-type")?.includes("json")
) {
  throw new Error("Application release manifest is unavailable");
}
const manifest = await manifestResponse.json();
if (
  typeof manifest !== "object" ||
  manifest === null ||
  !Array.isArray(manifest.resources) ||
  manifest.resources.length === 0 ||
  manifest.resources.length > 256 ||
  !/^[a-f0-9]{64}$/u.test(manifest.releaseId)
) {
  throw new Error("Application release manifest is invalid");
}
let totalBytes = 0;
const urls = new Set();
for (const resource of manifest.resources) {
  if (
    typeof resource.url !== "string" ||
    typeof resource.bytes !== "number" ||
    !Number.isSafeInteger(resource.bytes) ||
    resource.bytes < 1 ||
    resource.bytes > 8 * 1024 * 1024 ||
    typeof resource.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(resource.sha256)
  ) {
    throw new Error("Application release resource is invalid");
  }
  const url = new URL(resource.url, origin);
  if (
    url.origin !== new URL(origin).origin ||
    url.search.length > 0 ||
    url.hash.length > 0 ||
    urls.has(url.href)
  ) {
    throw new Error("Application release resource URL is invalid");
  }
  urls.add(url.href);
  const response = await fetch(url, { cache: "no-store", redirect: "error" });
  if (response.status !== 200 || response.redirected) {
    throw new Error(
      `Application release resource is unavailable: ${url.pathname}`,
    );
  }
  const body = Buffer.from(await response.arrayBuffer());
  if (
    body.byteLength !== resource.bytes ||
    createHash("sha256").update(body).digest("hex") !== resource.sha256
  ) {
    throw new Error(
      `Application release resource failed verification: ${url.pathname}`,
    );
  }
  totalBytes += body.byteLength;
}
if (totalBytes !== manifest.totalBytes || totalBytes > 32 * 1024 * 1024) {
  throw new Error("Application release total size is invalid");
}
process.stdout.write(`${manifest.releaseId}\n`);
