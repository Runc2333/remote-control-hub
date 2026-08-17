import { describe, expect, it } from "vitest";
import { parseDeviceCapabilities } from "./device-capabilities.js";

describe("parseDeviceCapabilities", () => {
  it("accepts arrays returned by mysql2 JSON columns", () => {
    expect(
      parseDeviceCapabilities(["display.turn_off", "media.play_pause"]),
    ).toEqual(["display.turn_off", "media.play_pause"]);
  });

  it("accepts JSON strings when the driver is configured with jsonStrings", () => {
    expect(parseDeviceCapabilities('["media.volume_up"]')).toEqual([
      "media.volume_up",
    ]);
  });

  it("rejects malformed or unsupported capabilities", () => {
    expect(() => parseDeviceCapabilities("not-json")).toThrow(
      "device_capabilities_invalid",
    );
    expect(() => parseDeviceCapabilities(["shell.execute"])).toThrow(
      "device_capabilities_invalid",
    );
  });
});
