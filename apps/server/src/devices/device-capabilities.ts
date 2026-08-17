import type { DeviceCapability } from "@remote-control-hub/contracts";

const DEVICE_CAPABILITIES = new Set<DeviceCapability>([
  "display.turn_off",
  "media.volume_up",
  "media.volume_down",
  "media.volume_mute_toggle",
  "media.play_pause",
  "media.previous_track",
  "media.next_track",
  "media.stop",
]);

export const parseDeviceCapabilities = (value: unknown): DeviceCapability[] => {
  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value) as unknown;
    } catch {
      throw new Error("device_capabilities_invalid");
    }
  }
  if (
    !Array.isArray(parsed) ||
    !parsed.every(
      (capability): capability is DeviceCapability =>
        typeof capability === "string" &&
        DEVICE_CAPABILITIES.has(capability as DeviceCapability),
    )
  ) {
    throw new Error("device_capabilities_invalid");
  }
  return parsed;
};
