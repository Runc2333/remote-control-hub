import { isIP } from "node:net";
import { Reader, type ReaderModel } from "@maxmind/geoip2-node";
import { UAParser } from "ua-parser-js";
import type { FastifyRequest } from "fastify";
import type { ServerConfig } from "../config.js";
import type { SessionMetadata } from "./session-store.js";

const MAX_USER_AGENT_LENGTH = 512;

type AddressClass = "loopback" | "private" | "public" | "unknown";

const classifyAddress = (address: string): AddressClass => {
  const normalized = address.replace(/^::ffff:/u, "");
  if (normalized === "::1") {
    return "loopback";
  }
  if (isIP(normalized) === 4) {
    const [first = -1, second = -1] = normalized
      .split(".")
      .map((part) => Number.parseInt(part, 10));
    if (first === 127) {
      return "loopback";
    }
    if (
      first === 10 ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 168) ||
      (first === 169 && second === 254)
    ) {
      return "private";
    }
    return "public";
  }
  if (isIP(normalized) === 6) {
    const firstSegment = Number.parseInt(normalized.split(":")[0] ?? "", 16);
    return (firstSegment >= 0xfc00 && firstSegment <= 0xfdff) ||
      (firstSegment >= 0xfe80 && firstSegment <= 0xfebf)
      ? "private"
      : "public";
  }
  return "unknown";
};

const displayName = (
  name: string | undefined,
  version: string | undefined,
): string => [name, version].filter(Boolean).join(" ") || "unknown";

export class SessionMetadataResolver {
  readonly #reader: Promise<ReaderModel | undefined>;

  public constructor(config: ServerConfig) {
    this.#reader =
      config.geoIpDatabase === undefined
        ? Promise.resolve(undefined)
        : Reader.open(config.geoIpDatabase, {
            watchForUpdates: true,
            watchForUpdatesNonPersistent: true,
          }).catch(() => undefined);
  }

  public async resolve(request: FastifyRequest): Promise<SessionMetadata> {
    const ipAddress = request.ip.replace(/^::ffff:/u, "").slice(0, 64);
    const userAgent =
      request.headers["user-agent"]?.slice(0, MAX_USER_AGENT_LENGTH) ?? "";
    const parsed = new UAParser(userAgent).getResult();
    return {
      browser: displayName(parsed.browser.name, parsed.browser.version).slice(
        0,
        128,
      ),
      deviceType: (parsed.device.type ?? "desktop").slice(0, 64),
      ipAddress,
      location: await this.#location(ipAddress),
      operatingSystem: displayName(parsed.os.name, parsed.os.version).slice(
        0,
        128,
      ),
    };
  }

  async #location(address: string): Promise<string> {
    const addressClass = classifyAddress(address);
    if (addressClass === "loopback") {
      return "本机";
    }
    if (addressClass === "private") {
      return "私有网络";
    }
    if (addressClass === "unknown") {
      return "未知位置";
    }
    try {
      const reader = await this.#reader;
      if (reader === undefined) {
        return "未知位置";
      }
      const result = reader.city(address);
      const country = result.country?.isoCode;
      const city = result.city?.names.en;
      return (
        [country, city].filter(Boolean).join(" · ").slice(0, 128) || "未知位置"
      );
    } catch {
      return "未知位置";
    }
  }
}
