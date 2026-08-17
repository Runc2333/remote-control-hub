import {
  faArrowRightFromBracket,
  faBackwardStep,
  faCopy,
  faForwardStep,
  faKey,
  faPause,
  faPowerOff,
  faStop,
  faVolumeHigh,
  faVolumeLow,
  faVolumeXmark,
} from "@fortawesome/free-solid-svg-icons";
import type { IconDefinition } from "@fortawesome/fontawesome-svg-core";
import type { ApiClient } from "@remote-control-hub/api-client";
import type {
  CommandBatchResponse,
  Device,
  DeviceCapability,
  Session,
} from "@remote-control-hub/contracts";
import { Icon } from "@remote-control-hub/ui";
import { useEffect, useState } from "react";
import { SecurityPanel } from "./SecurityPanel.js";
import { AdminPanel } from "./AdminPanel.js";
import { AuditPanel } from "./AuditPanel.js";

type DeviceDashboardProps = {
  apiClient: ApiClient;
  devices: Device[];
  onLoggedOut: () => void;
  onRefresh: () => void;
  sessions: Session[];
};

const CONTROLS: readonly {
  capability: DeviceCapability;
  icon: IconDefinition;
  label: string;
}[] = [
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

const formatDateTime = (value: string): string =>
  new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));

export function DeviceDashboard({
  apiClient,
  devices,
  onLoggedOut,
  onRefresh,
  sessions,
}: DeviceDashboardProps) {
  const [enrollment, setEnrollment] = useState<
    { expiresAt: string; token: string } | undefined
  >();
  const [commands, setCommands] = useState<
    ReadonlyMap<string, CommandBatchResponse>
  >(new Map());
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    const events = new EventSource("/api/v1/events", { withCredentials: true });
    events.addEventListener("device.status", onRefresh);
    return () => events.close();
  }, [onRefresh]);

  const createEnrollment = async (): Promise<void> => {
    try {
      setEnrollment(await apiClient.createEnrollmentToken());
      setError(undefined);
    } catch {
      setError("无法创建注册码，请稍后重试。");
    }
  };

  const sendCommand = async (
    device: Device,
    commandType: DeviceCapability,
  ): Promise<void> => {
    if (
      commandType === "display.turn_off" &&
      !window.confirm(`确认向 ${device.computerName} 发送关闭显示器命令？`)
    ) {
      return;
    }
    try {
      const result = await apiClient.createCommand({
        commandType,
        deviceIds: [device.id],
        idempotencyKey: crypto.randomUUID(),
      });
      setCommands((current) => new Map(current).set(device.id, result));
      setError(undefined);
    } catch {
      setError("命令未能提交，请检查设备状态后重试。");
    }
  };

  return (
    <div className="space-y-4">
      <section className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
        <div>
          <h2 className="font-semibold">我的设备</h2>
          <p className="text-sm text-slate-500">
            {devices.filter((device) => device.online).length} 台在线 /{" "}
            {devices.length} 台已注册
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            className="flex min-h-11 items-center gap-2 rounded-lg bg-teal-700 px-4 font-medium text-white"
            onClick={() => void createEnrollment()}
            type="button"
          >
            <Icon icon={faKey} />
            创建设备注册码
          </button>
          <button
            className="grid size-11 place-items-center rounded-lg border border-slate-300 dark:border-slate-700"
            onClick={() =>
              void apiClient
                .logout()
                .then(onLoggedOut)
                .catch(() => undefined)
            }
            type="button"
          >
            <Icon icon={faArrowRightFromBracket} label="退出登录" />
          </button>
        </div>
      </section>
      {enrollment !== undefined && (
        <section className="rounded-xl border border-teal-200 bg-teal-50 p-4 text-teal-950 dark:border-teal-900 dark:bg-teal-950 dark:text-teal-100">
          <h3 className="font-semibold">一次性设备注册码</h3>
          <div className="mt-2 flex items-center gap-2">
            <code className="min-w-0 flex-1 overflow-x-auto rounded bg-white px-3 py-2 text-sm dark:bg-slate-900">
              {enrollment.token}
            </code>
            <button
              className="grid size-11 shrink-0 place-items-center rounded-lg border border-teal-300 dark:border-teal-800"
              onClick={() =>
                void navigator.clipboard.writeText(enrollment.token)
              }
              type="button"
            >
              <Icon icon={faCopy} label="复制注册码" />
            </button>
          </div>
          <p className="mt-2 text-xs">
            有效期至 {formatDateTime(enrollment.expiresAt)}，使用后立即失效。
          </p>
        </section>
      )}
      {error !== undefined && (
        <p
          className="rounded-lg bg-red-50 p-3 text-sm text-red-800"
          role="alert"
        >
          {error}
        </p>
      )}
      <div className="grid gap-3 lg:grid-cols-2">
        {devices.map((device) => {
          const latest = commands.get(device.id)?.results[0];
          return (
            <article
              className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900"
              key={device.id}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h3 className="truncate font-semibold">
                    {device.computerName}
                  </h3>
                  <p className="mt-1 text-xs text-slate-500">
                    {device.id.slice(0, 8)} · Service {device.serviceVersion} ·
                    Session {device.sessionVersion}
                  </p>
                </div>
                <span
                  className={`rounded-full px-2 py-1 text-xs font-medium ${
                    device.online
                      ? "bg-emerald-100 text-emerald-800"
                      : "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300"
                  }`}
                >
                  {device.online ? "在线" : "离线"}
                </span>
              </div>
              <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
                {CONTROLS.filter((control) =>
                  device.capabilities.includes(control.capability),
                ).map((control) => (
                  <button
                    className="flex min-h-11 items-center justify-center gap-2 rounded-lg border border-slate-300 px-2 text-xs font-medium disabled:opacity-40 dark:border-slate-700"
                    disabled={!device.online}
                    key={control.capability}
                    onClick={() => void sendCommand(device, control.capability)}
                    type="button"
                  >
                    <Icon icon={control.icon} />
                    {control.label}
                  </button>
                ))}
              </div>
              {latest !== undefined && (
                <p className="mt-3 text-xs text-slate-500" role="status">
                  最近提交：{latest.status}
                  {latest.errorCode === undefined
                    ? ""
                    : ` · ${latest.errorCode}`}
                </p>
              )}
            </article>
          );
        })}
      </div>
      {devices.length === 0 && (
        <section className="rounded-xl border border-dashed border-slate-300 bg-white p-6 text-center dark:border-slate-700 dark:bg-slate-900">
          <h3 className="font-semibold">尚未注册设备</h3>
          <p className="mt-1 text-sm text-slate-500">
            创建设备注册码，然后在 Windows Agent 注册向导中输入。
          </p>
        </section>
      )}
      <section className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="font-semibold">活跃会话</h2>
            <p className="text-xs text-slate-500">
              IP、位置和设备信息均为推测结果
            </p>
          </div>
          <button
            className="min-h-11 rounded-lg border border-slate-300 px-3 text-sm font-medium dark:border-slate-700"
            onClick={() => void apiClient.revokeOtherSessions().then(onRefresh)}
            type="button"
          >
            退出其他会话
          </button>
        </div>
        <ul className="mt-3 divide-y divide-slate-200 text-sm dark:divide-slate-800">
          {sessions.map((session) => (
            <li
              className="grid gap-1 py-3 sm:grid-cols-[1fr_auto]"
              key={session.id}
            >
              <span>
                {session.browser} · {session.operatingSystem} ·{" "}
                {session.deviceType}
                {session.current ? "（当前）" : ""}
              </span>
              <span className="text-xs text-slate-500">
                {session.ipAddress} · {session.location} ·{" "}
                {formatDateTime(session.lastActiveAt)}
              </span>
            </li>
          ))}
        </ul>
      </section>
      <SecurityPanel apiClient={apiClient} />
      <AuditPanel apiClient={apiClient} />
      {sessions.find((session) => session.current)?.role === "admin" && (
        <AdminPanel apiClient={apiClient} />
      )}
    </div>
  );
}
