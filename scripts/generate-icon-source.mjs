import { faSatelliteDish } from "@fortawesome/free-solid-svg-icons";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(SCRIPT_DIRECTORY, "..");
const [, , , , pathData] = faSatelliteDish.icon;

if (typeof pathData !== "string") {
  throw new Error("The selected Font Awesome icon must have a single SVG path");
}

const source = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" role="img" aria-label="Remote Control Hub"><rect width="512" height="512" rx="112" fill="#0f766e"/><path d="${pathData}" fill="#ffffff" transform="translate(64 64) scale(.75)"/></svg>\n`;
const maskableSource = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" role="img" aria-label="Remote Control Hub"><rect width="512" height="512" fill="#0f766e"/><path d="${pathData}" fill="#ffffff" transform="translate(112 112) scale(.5625)"/></svg>\n`;
const sourcePath = resolve(REPOSITORY_ROOT, "assets/app-icon.svg");
const maskableSourcePath = resolve(
  REPOSITORY_ROOT,
  "assets/app-icon-maskable.svg",
);
const webIconDirectory = resolve(REPOSITORY_ROOT, "apps/web/public/icons");

await Promise.all([
  mkdir(dirname(sourcePath), { recursive: true }),
  mkdir(webIconDirectory, { recursive: true }),
]);
await Promise.all([
  writeFile(sourcePath, source, "utf8"),
  writeFile(maskableSourcePath, maskableSource, "utf8"),
  ...[
    [192, source, "192x192.png"],
    [512, source, "512x512.png"],
    [512, maskableSource, "maskable-512x512.png"],
  ].map(async ([size, svg, filename]) => {
    if (
      typeof size !== "number" ||
      typeof svg !== "string" ||
      typeof filename !== "string"
    ) {
      throw new Error("Invalid icon generation target");
    }
    const output = await sharp(Buffer.from(svg))
      .resize(size, size, { fit: "fill" })
      .png({ adaptiveFiltering: false, compressionLevel: 9, palette: false })
      .toBuffer();
    await writeFile(resolve(webIconDirectory, filename), output);
  }),
]);
