import {
  faCircleExclamation,
  faSatelliteDish,
} from "@fortawesome/free-solid-svg-icons";
import { Icon } from "@remote-control-hub/ui";
import type { AgentStatus } from "../types.js";

type AgentHeaderProps = {
  status?: AgentStatus;
  statusError: boolean;
};

export const AgentHeader = ({ status, statusError }: AgentHeaderProps) => {
  const connected = status?.connected === true;
  const stateLabel = statusError
    ? "服务不可用"
    : status === undefined
      ? "正在读取状态"
      : connected
        ? "远程服务已连接"
        : status.registered
          ? "等待远程连接"
          : "设备尚未绑定";

  return (
    <header className="agent-header">
      <span className="agent-logo">
        <Icon icon={faSatelliteDish} label="Remote Control Hub Agent" />
      </span>
      <div className="min-w-0 flex-1">
        <h1 className="truncate text-lg font-semibold">
          Remote Control Hub Agent
        </h1>
        <p className="text-sm text-slate-500">Windows 设备会话</p>
      </div>
      <span
        className={`status-pill ${connected ? "status-pill-connected" : "status-pill-idle"}`}
      >
        <Icon icon={connected ? faSatelliteDish : faCircleExclamation} />
        {stateLabel}
      </span>
    </header>
  );
};
