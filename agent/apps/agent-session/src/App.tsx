import {
  faBackwardStep,
  faBan,
  faCircleExclamation,
  faClock,
  faCodeBranch,
  faExternalLink,
  faForwardStep,
  faLink,
  faList,
  faPlay,
  faPowerOff,
  faRotate,
  faSatelliteDish,
  faShieldHalved,
  faStop,
  faVolumeHigh,
  faVolumeLow,
  faVolumeXmark,
} from "@fortawesome/free-solid-svg-icons";
import { Icon } from "@remote-control-hub/ui";
import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useState } from "react";
import "./App.css";

type AgentStatus = {
  connected: boolean;
  deviceId?: string;
  registered: boolean;
  serviceOrigin?: string;
};

type AppInfo = {
  buildTime: string;
  commit: string;
  repositoryConfigured: boolean;
  version: string;
};

type UpdateSettings = {
  automaticChecksEnabled: boolean;
  skippedTag?: string;
};

type UpdateCheck = {
  checkedAt?: number;
  currentVersion: string;
  releaseName?: string;
  repositoryConfigured: boolean;
  status:
    "disabled" | "not_checked" | "skipped" | "up_to_date" | "update_available";
  tag?: string;
};

type DiagnosticLog = {
  code: string;
  occurredAt: number;
};

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

const normalizeOrigin = (value: string): string | undefined => {
  try {
    const url = new URL(value.trim());
    if (
      url.protocol !== "https:" ||
      url.username !== "" ||
      url.password !== "" ||
      url.pathname !== "/" ||
      url.search !== "" ||
      url.hash !== ""
    ) {
      return undefined;
    }
    return url.origin;
  } catch {
    return undefined;
  }
};

const localTime = (seconds?: number): string =>
  seconds === undefined
    ? "尚未检查"
    : new Date(seconds * 1_000).toLocaleString();

function App() {
  const [origin, setOrigin] = useState("");
  const [enrollmentCode, setEnrollmentCode] = useState("");
  const [pendingCommand, setPendingCommand] = useState<string>();
  const [registrationPending, setRegistrationPending] = useState(false);
  const [status, setStatus] = useState<AgentStatus>();
  const [appInfo, setAppInfo] = useState<AppInfo>();
  const [updateSettings, setUpdateSettings] = useState<UpdateSettings>();
  const [updateCheck, setUpdateCheck] = useState<UpdateCheck>();
  const [updatePending, setUpdatePending] = useState(false);
  const [logs, setLogs] = useState<DiagnosticLog[]>();
  const [error, setError] = useState<string>();
  const [localError, setLocalError] = useState<string>();
  const [updateError, setUpdateError] = useState<string>();
  const normalizedOrigin = normalizeOrigin(origin);
  const canSubmit =
    normalizedOrigin !== undefined &&
    enrollmentCode.trim().length >= 8 &&
    !registrationPending;

  const refreshStatus = useCallback(async (): Promise<void> => {
    try {
      setStatus(await invoke<AgentStatus>("get_agent_status"));
    } catch {
      setStatus(undefined);
    }
  }, []);

  const checkForUpdates = useCallback(async (force: boolean): Promise<void> => {
    setUpdatePending(true);
    if (force) {
      setUpdateError(undefined);
    }
    try {
      setUpdateCheck(await invoke<UpdateCheck>("check_for_updates", { force }));
    } catch (reason: unknown) {
      if (force) {
        setUpdateError(String(reason));
      }
    } finally {
      setUpdatePending(false);
    }
  }, []);

  useEffect(() => {
    const initial = window.setTimeout(() => {
      void refreshStatus();
      void invoke<AppInfo>("get_app_info").then(setAppInfo);
      void invoke<UpdateSettings>("get_update_settings").then(
        setUpdateSettings,
      );
      void checkForUpdates(false);
    }, 0);
    const timer = window.setInterval(() => void refreshStatus(), 5_000);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(timer);
    };
  }, [checkForUpdates, refreshStatus]);

  const runLocalCommand = async (command: string): Promise<void> => {
    setPendingCommand(command);
    setLocalError(undefined);
    try {
      const dispatched = await invoke<boolean>("execute_local_command", {
        command,
      });
      if (!dispatched) {
        setLocalError("windows_command_not_dispatched");
      }
    } catch (reason: unknown) {
      setLocalError(String(reason));
    } finally {
      setPendingCommand(undefined);
    }
  };

  const register = async (): Promise<void> => {
    if (!canSubmit || normalizedOrigin === undefined) {
      return;
    }
    if (!window.confirm(`确认将此设备绑定到 ${normalizedOrigin}？`)) {
      return;
    }
    setError(undefined);
    setRegistrationPending(true);
    try {
      await invoke<string>("register_agent", {
        enrollmentToken: enrollmentCode.trim(),
        serviceOrigin: normalizedOrigin,
      });
      setEnrollmentCode("");
      await refreshStatus();
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setRegistrationPending(false);
    }
  };

  const toggleAutomaticChecks = async (): Promise<void> => {
    if (updateSettings === undefined) {
      return;
    }
    setUpdateSettings(
      await invoke<UpdateSettings>("set_automatic_update_checks", {
        enabled: !updateSettings.automaticChecksEnabled,
      }),
    );
  };

  const skipCurrentUpdate = async (): Promise<void> => {
    if (updateCheck?.tag === undefined) {
      return;
    }
    setUpdateSettings(
      await invoke<UpdateSettings>("skip_update", { tag: updateCheck.tag }),
    );
    setUpdateCheck({ ...updateCheck, status: "skipped" });
  };

  const showLogs = async (): Promise<void> => {
    setLogs(await invoke<DiagnosticLog[]>("get_diagnostic_logs"));
  };

  return (
    <main className="min-h-screen p-4 sm:p-6">
      <div className="mx-auto max-w-2xl space-y-4">
        <header className="flex items-center gap-3">
          <span className="grid size-11 place-items-center rounded-xl bg-teal-700 text-white">
            <Icon icon={faSatelliteDish} label="Remote Control Hub Agent" />
          </span>
          <div>
            <h1 className="font-semibold">Remote Control Hub Agent</h1>
            <p className="text-sm text-slate-500">Windows 设备会话</p>
          </div>
        </header>

        {updateCheck?.status === "update_available" ? (
          <section
            aria-live="polite"
            className="rounded-xl border border-teal-300 bg-teal-50 p-4"
          >
            <div className="flex items-start gap-3">
              <span className="mt-0.5 text-teal-700">
                <Icon icon={faRotate} />
              </span>
              <div className="min-w-0 flex-1">
                <h2 className="font-semibold">发现新版本 {updateCheck.tag}</h2>
                <p className="mt-1 text-sm text-slate-600">
                  客户端不会自动下载或安装。请前往固定的 GitHub Release
                  页面查看并手动升级。
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    className="control-button border-teal-700 bg-teal-700 text-white"
                    onClick={() =>
                      void invoke("open_release_page", { tag: updateCheck.tag })
                    }
                    type="button"
                  >
                    <Icon icon={faExternalLink} />
                    查看发布页面
                  </button>
                  <button
                    className="control-button"
                    onClick={() => void skipCurrentUpdate()}
                    type="button"
                  >
                    <Icon icon={faBan} />
                    跳过此版本
                  </button>
                </div>
              </div>
            </div>
          </section>
        ) : null}

        <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p
                className={`text-xs font-medium uppercase tracking-wide ${status?.connected ? "text-emerald-700" : "text-amber-700"}`}
              >
                {status?.connected
                  ? "已连接"
                  : status?.registered
                    ? "等待连接"
                    : "尚未绑定"}
              </p>
              <h2 className="mt-1 text-lg font-semibold">
                {status?.registered ? "设备服务状态" : "连接到你的控制中心"}
              </h2>
            </div>
            <span
              className={`grid size-10 place-items-center rounded-lg ${status?.connected ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-700"}`}
            >
              <Icon
                icon={status?.connected ? faSatelliteDish : faCircleExclamation}
                label={status?.connected ? "已连接" : "未连接"}
              />
            </span>
          </div>
          {status?.registered ? (
            <dl className="mt-5 grid gap-3 text-sm sm:grid-cols-2">
              <div>
                <dt className="text-slate-500">服务地址</dt>
                <dd className="break-all font-medium">
                  {status.serviceOrigin ?? "未知"}
                </dd>
              </div>
              <div>
                <dt className="text-slate-500">设备 ID</dt>
                <dd className="break-all font-mono text-xs">
                  {status.deviceId ?? "未知"}
                </dd>
              </div>
            </dl>
          ) : (
            <form
              className="mt-5 space-y-4"
              onSubmit={(event) => {
                event.preventDefault();
                void register();
              }}
            >
              <label
                className="block text-sm font-medium"
                htmlFor="service-origin"
              >
                服务地址
                <input
                  autoComplete="url"
                  className="input-field"
                  id="service-origin"
                  onChange={(event) => setOrigin(event.currentTarget.value)}
                  placeholder="https://hub.example.com"
                  spellCheck={false}
                  type="url"
                  value={origin}
                />
              </label>
              <label
                className="block text-sm font-medium"
                htmlFor="enrollment-code"
              >
                设备注册码
                <input
                  autoComplete="one-time-code"
                  className="input-field font-mono"
                  id="enrollment-code"
                  onChange={(event) =>
                    setEnrollmentCode(event.currentTarget.value)
                  }
                  placeholder="输入 WebUI 生成的短期注册码"
                  type="text"
                  value={enrollmentCode}
                />
              </label>
              <div className="rounded-lg bg-slate-50 p-3 text-sm text-slate-600">
                <span className="mr-2 text-teal-700">
                  <Icon icon={faShieldHalved} />
                </span>
                注册前会再次显示规范化服务地址。设备私钥只保存在本机系统服务中。
              </div>
              <button
                className="flex min-h-11 w-full items-center justify-center gap-2 rounded-lg bg-teal-700 px-4 font-medium text-white disabled:cursor-not-allowed disabled:opacity-50"
                disabled={!canSubmit}
                type="submit"
              >
                <Icon icon={faLink} />
                {registrationPending ? "正在绑定…" : "检查并绑定"}
              </button>
              {error === undefined ? null : (
                <p className="text-sm text-red-700" role="alert">
                  绑定失败：{error}
                </p>
              )}
            </form>
          )}
        </section>

        <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <h2 className="font-semibold">本机控制</h2>
          <p className="mt-1 text-sm text-slate-500">
            Windows API
            返回成功只表示命令已派发，不代表外设或播放器状态一定改变。
          </p>
          <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
            <button
              className="control-button col-span-2 sm:col-span-4"
              disabled={pendingCommand !== undefined}
              onClick={() => void runLocalCommand("display.turn_off")}
              type="button"
            >
              <Icon icon={faPowerOff} />
              {pendingCommand === "display.turn_off"
                ? "正在执行…"
                : "关闭显示器"}
            </button>
            {MEDIA_CONTROLS.map((control) => (
              <button
                className="control-button"
                disabled={pendingCommand !== undefined}
                key={control.command}
                onClick={() => void runLocalCommand(control.command)}
                type="button"
              >
                <Icon icon={control.icon} />
                {control.label}
              </button>
            ))}
          </div>
          {localError === undefined ? null : (
            <p className="mt-3 text-sm text-red-700" role="alert">
              本机命令失败：{localError}
            </p>
          )}
        </section>

        <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="font-semibold">版本与更新</h2>
              <p className="mt-1 text-sm text-slate-500">
                当前版本 {appInfo?.version ?? "未知"}
              </p>
            </div>
            <button
              className="control-button"
              disabled={updatePending || !appInfo?.repositoryConfigured}
              onClick={() => void checkForUpdates(true)}
              type="button"
            >
              <Icon icon={faRotate} />
              {updatePending ? "检查中…" : "立即检查"}
            </button>
          </div>
          <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-slate-500">
                <Icon icon={faCodeBranch} /> 提交
              </dt>
              <dd className="mt-1 break-all font-mono text-xs">
                {appInfo?.commit ?? "未知"}
              </dd>
            </div>
            <div>
              <dt className="text-slate-500">
                <Icon icon={faClock} /> 构建时间
              </dt>
              <dd className="mt-1 text-xs">{appInfo?.buildTime ?? "未知"}</dd>
            </div>
            <div>
              <dt className="text-slate-500">最近检查</dt>
              <dd className="mt-1">{localTime(updateCheck?.checkedAt)}</dd>
            </div>
            <div>
              <dt className="text-slate-500">检查结果</dt>
              <dd className="mt-1">{updateCheck?.status ?? "尚未检查"}</dd>
            </div>
          </dl>
          <label className="mt-4 flex min-h-11 items-center gap-3 text-sm">
            <input
              checked={updateSettings?.automaticChecksEnabled ?? false}
              disabled={
                updateSettings === undefined || !appInfo?.repositoryConfigured
              }
              onChange={() => void toggleAutomaticChecks()}
              type="checkbox"
            />
            自动检查 GitHub 最新稳定 Release（每天最多一次）
          </label>
          {!appInfo?.repositoryConfigured ? (
            <p className="mt-2 text-sm text-amber-700">
              此构建未配置公开 GitHub 仓库，更新检查保持关闭。
            </p>
          ) : null}
          {updateError === undefined ? null : (
            <p className="mt-2 text-sm text-red-700" role="alert">
              更新检查失败：{updateError}
            </p>
          )}
        </section>

        <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h2 className="font-semibold">脱敏诊断日志</h2>
              <p className="mt-1 text-sm text-slate-500">
                仅显示时间和错误码，不记录令牌、设备详情或注册密钥。
              </p>
            </div>
            <button
              className="control-button"
              onClick={() => void showLogs()}
              type="button"
            >
              <Icon icon={faList} />
              {logs === undefined ? "查看" : "刷新"}
            </button>
          </div>
          {logs === undefined ? null : logs.length === 0 ? (
            <p className="mt-3 text-sm text-slate-500">暂无诊断事件。</p>
          ) : (
            <ul className="mt-3 max-h-40 space-y-2 overflow-auto font-mono text-xs">
              {logs.map((entry, index) => (
                <li
                  className="rounded bg-slate-50 p-2"
                  key={`${entry.occurredAt}-${index}`}
                >
                  {localTime(entry.occurredAt)} · {entry.code}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </main>
  );
}

export default App;
