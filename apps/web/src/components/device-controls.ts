import {
  faBackwardStep,
  faForwardStep,
  faPause,
  faPowerOff,
  faStop,
  faVolumeHigh,
  faVolumeLow,
  faVolumeXmark,
} from "@fortawesome/free-solid-svg-icons";
import type { IconDefinition } from "@fortawesome/fontawesome-svg-core";
import type { DeviceCapability } from "@remote-control-hub/contracts";

export type DeviceControl = {
  capability: DeviceCapability;
  icon: IconDefinition;
  label: string;
};

export const DEVICE_CONTROLS: readonly DeviceControl[] = [
  { capability: "display.turn_off", icon: faPowerOff, label: "关闭显示器" },
  { capability: "media.volume_up", icon: faVolumeHigh, label: "提高音量" },
  { capability: "media.volume_down", icon: faVolumeLow, label: "降低音量" },
  {
    capability: "media.volume_mute_toggle",
    icon: faVolumeXmark,
    label: "切换静音",
  },
  { capability: "media.play_pause", icon: faPause, label: "播放/暂停" },
  { capability: "media.previous_track", icon: faBackwardStep, label: "上一首" },
  { capability: "media.next_track", icon: faForwardStep, label: "下一首" },
  { capability: "media.stop", icon: faStop, label: "停止" },
];

export const getDeviceControl = (
  capability: DeviceCapability,
): DeviceControl => {
  const control = DEVICE_CONTROLS.find(
    (candidate) => candidate.capability === capability,
  );
  if (control === undefined) {
    throw new Error("device_control_missing");
  }
  return control;
};
