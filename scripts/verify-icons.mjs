import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import sharp from "sharp";

const REPOSITORY_ROOT = resolve(import.meta.dirname, "..");

const verifyPng = async (path, expectedSize) => {
  const absolutePath = resolve(REPOSITORY_ROOT, path);
  const image = sharp(absolutePath);
  const metadata = await image.metadata();
  if (
    metadata.format !== "png" ||
    metadata.width !== expectedSize ||
    metadata.height !== expectedSize
  ) {
    throw new Error(`Invalid PNG icon: ${path}`);
  }
  const { data, info } = await image
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let visiblePixels = 0;
  for (let offset = 3; offset < data.length; offset += info.channels) {
    if (data[offset] > 0) {
      visiblePixels += 1;
    }
  }
  if (visiblePixels < expectedSize * expectedSize * 0.25) {
    throw new Error(`PNG icon is blank or mostly transparent: ${path}`);
  }
  return { data, info };
};

await verifyPng("apps/web/public/icons/192x192.png", 192);
await verifyPng("apps/web/public/icons/512x512.png", 512);
const maskable = await verifyPng(
  "apps/web/public/icons/maskable-512x512.png",
  512,
);
for (let offset = 3; offset < maskable.data.length; offset += 4) {
  if (maskable.data[offset] !== 255) {
    throw new Error("Maskable icon background must cover the full canvas");
  }
}
for (const [path, size] of [
  ["agent/apps/agent-session/src-tauri/icons/32x32.png", 32],
  ["agent/apps/agent-session/src-tauri/icons/64x64.png", 64],
  ["agent/apps/agent-session/src-tauri/icons/128x128.png", 128],
  ["agent/apps/agent-session/src-tauri/icons/128x128@2x.png", 256],
  ["agent/apps/agent-session/src-tauri/icons/icon.png", 512],
]) {
  await verifyPng(path, size);
}
const ico = await readFile(
  resolve(REPOSITORY_ROOT, "agent/apps/agent-session/src-tauri/icons/icon.ico"),
);
if (
  ico.byteLength < 64 ||
  ico[0] !== 0 ||
  ico[1] !== 0 ||
  ico[2] !== 1 ||
  ico[3] !== 0
) {
  throw new Error("Windows ICO icon is invalid");
}
