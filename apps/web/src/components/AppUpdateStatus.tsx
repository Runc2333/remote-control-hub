import { useEffect, useState } from "react";
import {
  activateWorkerUpdate,
  cancelAppUpdate,
  confirmCandidateStartup,
  dismissAppUpdateFailure,
  retryAppUpdate,
} from "../pwa/register.js";
import {
  parseUpdateFailure,
  type UpdateFailureDetail,
  UPDATE_FAILURE_STORAGE_KEY,
} from "../pwa/update-failure.js";

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
  | { details: UpdateFailureDetail; kind: "failed" };

const readInitialState = (): UpdateState => {
  const serialized = sessionStorage.getItem(UPDATE_FAILURE_STORAGE_KEY);
  if (serialized === null) {
    return { kind: "idle" };
  }
  try {
    return {
      details: parseUpdateFailure(JSON.parse(serialized)),
      kind: "failed",
    };
  } catch {
    sessionStorage.removeItem(UPDATE_FAILURE_STORAGE_KEY);
    return { kind: "idle" };
  }
};

export function AppUpdateStatus() {
  const [update, setUpdate] = useState<UpdateState>(readInitialState);
  const [workerVersion, setWorkerVersion] = useState<string>();
  const failureCandidates: readonly (readonly [string, string | undefined])[] =
    update.kind === "failed"
      ? [
          ["目标版本", update.details.version],
          ["Release ID", update.details.releaseId],
          ["资源", update.details.resourceUrl],
          ["页面 URL", update.details.url],
          ["Worker 版本", update.details.workerVersion],
          [
            "错误来源",
            update.details.source === undefined
              ? undefined
              : `${update.details.source}${
                  update.details.line === undefined
                    ? ""
                    : `:${update.details.line}:${update.details.column ?? 0}`
                }`,
          ],
          ["浏览器", update.details.userAgent],
        ]
      : [];
  const failureRows: readonly (readonly [string, string])[] =
    failureCandidates.flatMap(([label, value]) =>
      value === undefined ? [] : [[label, value] as const],
    );

  useEffect(() => confirmCandidateStartup(), []);

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
        setUpdate({ details: parseUpdateFailure(detail), kind: "failed" });
      } else if (detail.type === "UPDATE_ACTIVATED") {
        window.location.reload();
      } else if (
        detail.type === "WORKER_UPDATE_READY" &&
        typeof detail.workerVersion === "string"
      ) {
        setWorkerVersion(detail.workerVersion);
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
    <>
      {workerVersion !== undefined && (
        <section
          aria-live="polite"
          className="surface-card fixed bottom-[max(5rem,env(safe-area-inset-bottom))] left-4 right-4 z-40 mx-auto max-w-lg p-4 shadow-xl md:bottom-4"
        >
          <h2 className="font-semibold">离线核心可更新</h2>
          <p className="text-muted mt-1 text-sm">
            Worker {workerVersion} 已通过兼容预检。激活后应用会安全重载。
          </p>
          <div className="mt-3 grid grid-cols-2 gap-2">
            <button
              className="button-primary"
              onClick={() => {
                activateWorkerUpdate();
                setWorkerVersion(undefined);
              }}
              type="button"
            >
              立即更新
            </button>
            <button
              className="button-secondary"
              onClick={() => setWorkerVersion(undefined)}
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
          className="fixed inset-0 z-50 grid place-items-center bg-slate-950/75 p-4"
          role="alertdialog"
        >
          <section className="surface-card w-full max-w-md p-5 shadow-xl">
            <h2 className="text-lg font-semibold" id="update-title">
              {update.kind === "failed" ? "更新失败" : "正在更新应用"}
            </h2>
            {update.kind === "downloading" && (
              <>
                <p className="text-muted mt-2 text-sm">
                  正在安全下载版本 {update.version} 的资源…
                </p>
                <progress
                  className="mt-4 h-2 w-full accent-teal-700"
                  max={Math.max(update.totalBytes, 1)}
                  value={update.downloadedBytes}
                />
                <p className="text-muted mt-2 text-xs">
                  {update.downloadedBytes.toLocaleString()} /{" "}
                  {update.totalBytes.toLocaleString()} 字节 · 资源{" "}
                  {update.resourceIndex}/{update.resourceCount}
                </p>
                <button
                  className="button-secondary mt-4 w-full"
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
              <p className="text-muted mt-2 text-sm">
                版本 {update.version} 资源已校验，正在确认候选启动…
              </p>
            )}
            {update.kind === "failed" && (
              <>
                <p className="text-muted mt-2 text-sm">
                  当前继续使用上次可用版本。
                </p>
                <dl className="surface-muted mt-3 space-y-2 p-3 text-xs">
                  <div>
                    <dt className="text-muted font-medium">错误代码</dt>
                    <dd className="break-all font-mono">
                      {update.details.code}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-muted font-medium">失败阶段</dt>
                    <dd className="break-all font-mono">
                      {update.details.phase}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-muted font-medium">异常</dt>
                    <dd className="break-words">
                      {update.details.name}: {update.details.message}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-muted font-medium">发生时间</dt>
                    <dd>
                      {new Date(update.details.occurredAt).toLocaleString()}
                    </dd>
                  </div>
                  {failureRows.map(([label, value]) => (
                    <div key={label}>
                      <dt className="text-muted font-medium">{label}</dt>
                      <dd className="break-all font-mono">{value}</dd>
                    </div>
                  ))}
                </dl>
                {update.details.stack === undefined ? null : (
                  <details className="mt-3 text-xs">
                    <summary className="cursor-pointer font-medium">
                      查看调用栈
                    </summary>
                    <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-slate-950 p-3 text-slate-100">
                      {update.details.stack}
                    </pre>
                  </details>
                )}
                <div className="mt-4 grid gap-2 sm:grid-cols-2">
                  <button
                    className="button-primary"
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
                    className="button-secondary"
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
    </>
  );
}
