import {
  faBolt,
  faComputer,
  faGear,
  faRotate,
  faSatelliteDish,
  faShieldHalved,
} from "@fortawesome/free-solid-svg-icons";
import { ApiClient, ApiError } from "@remote-control-hub/api-client";
import type {
  Device,
  Session,
  SetupStatusResponse,
} from "@remote-control-hub/contracts";
import { Icon } from "@remote-control-hub/ui";
import { useCallback, useEffect, useState } from "react";
import { DeviceDashboard } from "./components/DeviceDashboard.js";
import { LoginPanel } from "./components/LoginPanel.js";
import { SetupPanel } from "./components/SetupPanel.js";
import {
  activateWorkerUpdate,
  cancelAppUpdate,
  confirmCandidateStartup,
  dismissAppUpdateFailure,
  retryAppUpdate,
} from "./pwa/register.js";

const API_CLIENT = new ApiClient();

type ConnectionState =
  | { kind: "loading" }
  | { kind: "ready"; setup: SetupStatusResponse }
  | { kind: "failed"; message: string };

type UpdateState =
  | { kind: "idle" }
  | {
      downloadedBytes: number;
      kind: "downloading";
      resourceCount: number;
      resourceIndex: number;
      totalBytes: number;
      version: string;
    }
  | { kind: "validating"; version: string }
  | { code: string; kind: "failed" };

type WorkspaceState =
  | { kind: "idle" | "loading" | "signed-out" }
  | { kind: "ready"; devices: Device[]; sessions: Session[] }
  | { kind: "failed"; message: string };

function App() {
  const [connection, setConnection] = useState<ConnectionState>({
    kind: "loading",
  });
  const [update, setUpdate] = useState<UpdateState>({ kind: "idle" });
  const [workerUpdateVersion, setWorkerUpdateVersion] = useState<string>();
  const [workspace, setWorkspace] = useState<WorkspaceState>({ kind: "idle" });

  const refreshWorkspace = useCallback(async (): Promise<void> => {
    setWorkspace((current) =>
      current.kind === "ready" ? current : { kind: "loading" },
    );
    try {
      const [deviceResponse, sessionResponse] = await Promise.all([
        API_CLIENT.getDevices(),
        API_CLIENT.getSessions(),
      ]);
      setWorkspace({
        devices: deviceResponse.devices,
        kind: "ready",
        sessions: sessionResponse.sessions,
      });
    } catch (error: unknown) {
      if (error instanceof ApiError && error.status === 401) {
        setWorkspace({ kind: "signed-out" });
      } else {
        setWorkspace({
          kind: "failed",
          message: error instanceof Error ? error.message : "工作区加载失败",
        });
      }
    }
  }, []);

  useEffect(() => {
    let active = true;
    void Promise.all([API_CLIENT.getHealth(), API_CLIENT.getSetupStatus()])
      .then(([, setup]) => {
        if (active) {
          setConnection({ kind: "ready", setup });
          if (setup.installed) {
            void refreshWorkspace();
          }
        }
      })
      .catch((error: unknown) => {
        if (active) {
          setConnection({
            kind: "failed",
            message: error instanceof Error ? error.message : "连接失败",
          });
        }
      });
    return () => {
      active = false;
    };
  }, [refreshWorkspace]);

  useEffect(() => {
    if (connection.kind === "ready") {
      confirmCandidateStartup();
    }
  }, [connection]);

  useEffect(() => {
    const listener = (event: Event): void => {
      if (!(event instanceof CustomEvent) || typeof event.detail !== "object") {
        return;
      }
      const detail = event.detail as Record<string, unknown>;
      if (
        detail.type === "UPDATE_PROGRESS" &&
        typeof detail.downloadedBytes === "number" &&
        typeof detail.totalBytes === "number" &&
        typeof detail.resourceCount === "number" &&
        typeof detail.resourceIndex === "number" &&
        typeof detail.version === "string"
      ) {
        setUpdate({
          downloadedBytes: detail.downloadedBytes,
          kind: "downloading",
          resourceCount: detail.resourceCount,
          resourceIndex: detail.resourceIndex,
          totalBytes: detail.totalBytes,
          version: detail.version,
        });
      } else if (
        detail.type === "UPDATE_READY" &&
        typeof detail.version === "string"
      ) {
        setUpdate({ kind: "validating", version: detail.version });
      } else if (detail.type === "UPDATE_FAILED") {
        setUpdate({
          code: typeof detail.code === "string" ? detail.code : "update_failed",
          kind: "failed",
        });
      } else if (detail.type === "UPDATE_ACTIVATED") {
        window.location.reload();
      } else if (
        detail.type === "WORKER_UPDATE_READY" &&
        typeof detail.workerVersion === "string"
      ) {
        setWorkerUpdateVersion(detail.workerVersion);
      } else if (
        detail.type === "UPDATE_CANCELLED" ||
        detail.type === "UPDATE_CURRENT"
      ) {
        setUpdate({ kind: "idle" });
      }
    };
    window.addEventListener("rch-update", listener);
    return () => window.removeEventListener("rch-update", listener);
  }, []);

  return (
    <div className="min-h-screen pb-[max(5rem,env(safe-area-inset-bottom))] md:pb-8">
      <header className="border-b border-slate-200 bg-white/95 px-4 py-3 dark:border-slate-800 dark:bg-slate-950/95">
        <div className="mx-auto flex max-w-6xl items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="grid size-10 place-items-center rounded-xl bg-teal-700 text-white">
              <Icon icon={faSatelliteDish} label="Remote Control Hub" />
            </span>
            <div>
              <h1 className="text-base font-semibold">Remote Control Hub</h1>
              <p className="text-xs text-slate-500">安全设备控制中心</p>
            </div>
          </div>
          <button
            className="grid size-11 place-items-center rounded-lg border border-slate-200 text-slate-600 dark:border-slate-700 dark:text-slate-300"
            type="button"
          >
            <Icon icon={faGear} label="设置" />
          </button>
        </div>
      </header>
      <main
        className={`mx-auto grid max-w-6xl gap-4 px-4 py-5 ${
          connection.kind === "ready" && connection.setup.installed
            ? ""
            : "md:grid-cols-[1fr_18rem]"
        }`}
      >
        <section className="space-y-4">
          <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-xs font-medium uppercase tracking-wide text-teal-700 dark:text-teal-400">
                  系统状态
                </p>
                <h2 className="mt-1 text-xl font-semibold">
                  {connection.kind === "ready" && connection.setup.installed
                    ? "设备控制台已就绪"
                    : "首次安装准备中"}
                </h2>
              </div>
              <span className="grid size-10 place-items-center rounded-lg bg-teal-50 text-teal-700 dark:bg-teal-950 dark:text-teal-300">
                <Icon icon={faShieldHalved} label="安全状态" />
              </span>
            </div>
            <div className="mt-4 rounded-lg bg-slate-50 p-3 text-sm dark:bg-slate-950">
              {connection.kind === "loading" && "正在检查服务状态…"}
              {connection.kind === "failed" &&
                `无法连接服务：${connection.message}`}
              {connection.kind === "ready" && (
                <span>
                  部署模式：{connection.setup.deploymentMode} · 当前步骤：
                  {connection.setup.step}
                </span>
              )}
            </div>
          </div>
          {connection.kind === "ready" && !connection.setup.installed && (
            <SetupPanel
              apiClient={API_CLIENT}
              deploymentMode={connection.setup.deploymentMode}
              onComplete={() => window.location.reload()}
            />
          )}
          {connection.kind === "ready" &&
            connection.setup.installed &&
            workspace.kind === "loading" && (
              <p className="rounded-xl border border-slate-200 bg-white p-4 text-sm dark:border-slate-800 dark:bg-slate-900">
                正在加载设备与会话…
              </p>
            )}
          {connection.kind === "ready" &&
            connection.setup.installed &&
            workspace.kind === "signed-out" && (
              <LoginPanel
                apiClient={API_CLIENT}
                onLoggedIn={() => void refreshWorkspace()}
              />
            )}
          {connection.kind === "ready" &&
            connection.setup.installed &&
            workspace.kind === "ready" && (
              <DeviceDashboard
                apiClient={API_CLIENT}
                devices={workspace.devices}
                onLoggedOut={() => setWorkspace({ kind: "signed-out" })}
                onRefresh={() => void refreshWorkspace()}
                sessions={workspace.sessions}
              />
            )}
          {connection.kind === "ready" &&
            connection.setup.installed &&
            workspace.kind === "failed" && (
              <p
                className="rounded-xl bg-red-50 p-4 text-sm text-red-800"
                role="alert"
              >
                无法加载工作区：{workspace.message}
              </p>
            )}
          {connection.kind === "ready" && !connection.setup.installed && (
            <div className="grid gap-3 sm:grid-cols-2">
              <article className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
                <div className="flex items-center gap-3">
                  <Icon icon={faComputer} label="设备" />
                  <h3 className="font-semibold">我的设备</h3>
                </div>
                <p className="mt-3 text-3xl font-semibold">0</p>
                <p className="text-sm text-slate-500">
                  完成安装后可注册 Windows 设备
                </p>
              </article>
              <article className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
                <div className="flex items-center gap-3">
                  <Icon icon={faBolt} label="命令" />
                  <h3 className="font-semibold">进行中命令</h3>
                </div>
                <p className="mt-3 text-3xl font-semibold">0</p>
                <p className="text-sm text-slate-500">
                  命令结果以 Agent 执行回执为准
                </p>
              </article>
            </div>
          )}
        </section>
        {connection.kind === "ready" && !connection.setup.installed && (
          <aside className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
            <h2 className="font-semibold">快速开始</h2>
            <ol className="mt-3 space-y-3 text-sm text-slate-600 dark:text-slate-300">
              <li>1. 完成数据服务检测</li>
              <li>2. 创建首个平台管理员</li>
              <li>3. 登录并生成设备注册码</li>
              <li>4. 在 Windows Agent 中完成绑定</li>
            </ol>
            <button
              className="mt-5 flex w-full items-center justify-center gap-2 rounded-lg bg-teal-700 px-4 py-2.5 font-medium text-white disabled:opacity-50"
              disabled={connection.kind !== "ready"}
              type="button"
            >
              <Icon icon={faRotate} />
              继续安装
            </button>
          </aside>
        )}
      </main>
      <nav className="fixed inset-x-0 bottom-0 border-t border-slate-200 bg-white px-3 pb-[env(safe-area-inset-bottom)] md:hidden dark:border-slate-800 dark:bg-slate-950">
        <div className="mx-auto grid max-w-md grid-cols-3">
          <button
            className="flex min-h-14 flex-col items-center justify-center gap-1 text-xs text-teal-700"
            type="button"
          >
            <Icon icon={faComputer} />
            设备
          </button>
          <button
            className="flex min-h-14 flex-col items-center justify-center gap-1 text-xs text-slate-500"
            type="button"
          >
            <Icon icon={faBolt} />
            命令
          </button>
          <button
            className="flex min-h-14 flex-col items-center justify-center gap-1 text-xs text-slate-500"
            type="button"
          >
            <Icon icon={faGear} />
            设置
          </button>
        </div>
      </nav>
      {workerUpdateVersion !== undefined && (
        <section
          aria-live="polite"
          className="fixed bottom-[max(5rem,env(safe-area-inset-bottom))] left-4 right-4 z-40 mx-auto max-w-lg rounded-xl border border-slate-200 bg-white p-4 shadow-xl md:bottom-4 dark:border-slate-700 dark:bg-slate-900"
        >
          <h2 className="font-semibold">离线核心可更新</h2>
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">
            Worker {workerUpdateVersion} 已通过兼容预检。激活后应用会安全重载。
          </p>
          <div className="mt-3 grid grid-cols-2 gap-2">
            <button
              className="rounded-lg bg-teal-700 px-4 font-medium text-white"
              onClick={() => {
                activateWorkerUpdate();
                setWorkerUpdateVersion(undefined);
              }}
              type="button"
            >
              立即更新
            </button>
            <button
              className="rounded-lg border border-slate-300 px-4 font-medium dark:border-slate-600"
              onClick={() => setWorkerUpdateVersion(undefined)}
              type="button"
            >
              稍后
            </button>
          </div>
        </section>
      )}
      {update.kind !== "idle" && (
        <div
          aria-labelledby="update-title"
          aria-modal="true"
          className="fixed inset-0 z-50 grid place-items-center bg-slate-950/70 p-4"
          role="alertdialog"
        >
          <section className="w-full max-w-md rounded-xl bg-white p-5 text-slate-900 shadow-xl">
            <h2 className="text-lg font-semibold" id="update-title">
              {update.kind === "failed" ? "更新失败" : "正在更新应用"}
            </h2>
            {update.kind === "downloading" && (
              <>
                <p className="mt-2 text-sm text-slate-600">
                  正在安全下载版本 {update.version} 的资源…
                </p>
                <progress
                  className="mt-4 h-2 w-full accent-teal-700"
                  max={Math.max(update.totalBytes, 1)}
                  value={update.downloadedBytes}
                />
                <p className="mt-2 text-xs text-slate-500">
                  {update.downloadedBytes.toLocaleString()} /{" "}
                  {update.totalBytes.toLocaleString()} 字节 · 资源{" "}
                  {update.resourceIndex}/{update.resourceCount}
                </p>
                <button
                  className="mt-4 min-h-11 w-full rounded-lg border border-slate-300 px-4 font-medium"
                  onClick={() => {
                    cancelAppUpdate();
                    setUpdate({ kind: "idle" });
                  }}
                  type="button"
                >
                  取消并继续使用当前版本
                </button>
              </>
            )}
            {update.kind === "validating" && (
              <p className="mt-2 text-sm text-slate-600">
                版本 {update.version} 资源已校验，正在确认候选启动…
              </p>
            )}
            {update.kind === "failed" && (
              <>
                <p className="mt-2 text-sm text-slate-600">
                  当前继续使用上次可用版本。错误代码：{update.code}
                </p>
                <div className="mt-4 grid gap-2 sm:grid-cols-2">
                  <button
                    className="min-h-11 rounded-lg bg-teal-700 px-4 font-medium text-white"
                    onClick={() => {
                      setUpdate({
                        downloadedBytes: 0,
                        kind: "downloading",
                        resourceCount: 1,
                        resourceIndex: 0,
                        totalBytes: 1,
                        version: "检查中",
                      });
                      retryAppUpdate();
                    }}
                    type="button"
                  >
                    立即重试
                  </button>
                  <button
                    className="min-h-11 rounded-lg border border-slate-300 px-4 font-medium"
                    onClick={() => {
                      dismissAppUpdateFailure();
                      setUpdate({ kind: "idle" });
                    }}
                    type="button"
                  >
                    关闭
                  </button>
                </div>
              </>
            )}
          </section>
        </div>
      )}
    </div>
  );
}

export default App;
