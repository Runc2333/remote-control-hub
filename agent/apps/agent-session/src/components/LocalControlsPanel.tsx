import {
  faBackwardStep,
  faForwardStep,
  faPlay,
  faPowerOff,
  faStop,
  faVolumeHigh,
  faVolumeLow,
  faVolumeXmark,
} from "@fortawesome/free-solid-svg-icons";
import { Icon } from "@remote-control-hub/ui";
import { invoke } from "@tauri-apps/api/core";
import { useState } from "react";

type LocalControl = {
  command: string;
  icon: typeof faPlay;
  label: string;
};

const MEDIA_CONTROLS: LocalControl[] = [
  { command: "media.volume_down", icon: faVolumeLow, label: "降低音量" },
  { command: "media.volume_up", icon: faVolumeHigh, label: "提高音量" },
  {
    command: "media.volume_mute_toggle",
    icon: faVolumeXmark,
    label: "切换静音",
  },
  { command: "media.previous_track", icon: faBackwardStep, label: "上一首" },
  { command: "media.play_pause", icon: faPlay, label: "播放或暂停" },
  { command: "media.next_track", icon: faForwardStep, label: "下一首" },
  { command: "media.stop", icon: faStop, label: "停止播放" },
];

export const LocalControlsPanel = () => {
  const [pendingCommand, setPendingCommand] = useState<string>();
  const [error, setError] = useState<string>();

  const runCommand = async (command: string): Promise<void> => {
    setPendingCommand(command);
    setError(undefined);
    try {
      const dispatched = await invoke<boolean>("execute_local_command", {
        command,
      });
      if (!dispatched) {
        setError("windows_command_not_dispatched");
      }
    } catch (reason: unknown) {
      setError(String(reason));
    } finally {
      setPendingCommand(undefined);
    }
  };

  return (
    <section className="panel-card">
      <p className="section-eyebrow">快捷操作</p>
      <h2 className="mt-1 text-xl font-semibold">本机控制</h2>
      <p className="mt-1 text-sm text-slate-500">
        命令由当前 Windows 会话直接执行，反馈成功表示命令已派发。
      </p>
      <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <button
          className="control-button col-span-2 sm:col-span-4"
          disabled={pendingCommand !== undefined}
          onClick={() => void runCommand("display.turn_off")}
          type="button"
        >
          <Icon icon={faPowerOff} />
          {pendingCommand === "display.turn_off" ? "正在执行…" : "关闭显示器"}
        </button>
        {MEDIA_CONTROLS.map((control) => (
          <button
            className="control-button"
            disabled={pendingCommand !== undefined}
            key={control.command}
            onClick={() => void runCommand(control.command)}
            type="button"
          >
            <Icon icon={control.icon} />
            {control.label}
          </button>
        ))}
      </div>
      {error === undefined ? null : (
        <p className="mt-4 text-sm text-red-700" role="alert">
          本机命令失败：{error}
        </p>
      )}
    </section>
  );
};
