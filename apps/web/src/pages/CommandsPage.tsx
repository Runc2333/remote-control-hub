import type { CommandStatus } from "@remote-control-hub/contracts";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useLoaderData, useSearchParams } from "react-router";
import type { CommandsLoaderData } from "../app/loaders.js";
import { getDeviceControl } from "../components/device-controls.js";
import { PageHeader } from "../components/PageHeader.js";
import { API_CLIENT } from "../lib/api-client.js";
import { formatDateTime } from "../lib/date-time.js";

const STATUS_LABELS: Readonly<Record<CommandStatus, string>> = {
  accepted: "已接受",
  created: "已创建",
  executing: "执行中",
  expired: "已过期",
  failed: "失败",
  outcome_unknown: "结果未知",
  sent: "已发送",
  succeeded: "Agent 已回执成功",
};

const TERMINAL_STATUSES: readonly CommandStatus[] = [
  "expired",
  "failed",
  "outcome_unknown",
  "succeeded",
];

export function CommandsPage() {
  const loaded = useLoaderData() as CommandsLoaderData;
  const [batchState, setBatchState] = useState({
    base: loaded.batches,
    current: loaded.batches,
  });
  const [failed, setFailed] = useState(!loaded.historyAvailable);
  const [searchParams] = useSearchParams();
  const selectedBatch = searchParams.get("batch");
  const deviceNames = useMemo(
    () =>
      new Map(loaded.devices.map((device) => [device.id, device.computerName])),
    [loaded.devices],
  );
  const batches =
    batchState.base === loaded.batches ? batchState.current : loaded.batches;

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const response = await API_CLIENT.getCommandBatches();
      setBatchState({ base: loaded.batches, current: response.batches });
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, [loaded.batches]);

  useEffect(() => {
    const events = new EventSource("/api/v1/events", { withCredentials: true });
    events.addEventListener("command.status", () => void refresh());
    const interval = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, 5_000);
    return () => {
      events.close();
      window.clearInterval(interval);
    };
  }, [refresh]);

  return (
    <>
      <PageHeader
        actions={
          <button
            className="button-secondary"
            onClick={() => void refresh()}
            type="button"
          >
            刷新状态
          </button>
        }
        description="通过实时事件更新；断线或遗漏事件时自动查询权威状态。"
        title="命令状态"
      />
      {failed ? (
        <p className="status-warning mb-4" role="status">
          命令历史暂不可用；其他页面仍可使用，请稍后重试。
        </p>
      ) : null}
      {failed && batches.length === 0 ? (
        <section className="surface-card p-8 text-center">
          <h2 className="font-semibold">无法读取命令历史</h2>
          <p className="text-muted mt-1 text-sm">
            服务恢复后可在此页重试，不会自动重复提交任何命令。
          </p>
          <button
            className="button-primary mt-4"
            onClick={() => void refresh()}
            type="button"
          >
            重新加载
          </button>
        </section>
      ) : batches.length === 0 ? (
        <section className="surface-card p-8 text-center">
          <h2 className="font-semibold">暂无命令</h2>
          <p className="text-muted mt-1 text-sm">
            从设备列表选择一台或多台设备后发送白名单命令。
          </p>
          <Link className="button-primary mt-4 inline-flex" to="/devices">
            前往设备列表
          </Link>
        </section>
      ) : (
        <div className="space-y-3">
          {batches.map((batch) => {
            const control = getDeviceControl(batch.commandType);
            const complete = batch.results.filter((result) =>
              TERMINAL_STATUSES.includes(result.status),
            ).length;
            return (
              <article
                className={`surface-card p-4 ${selectedBatch === batch.batchId ? "ring-2 ring-teal-500" : ""}`}
                key={batch.batchId}
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h2 className="font-semibold">{control.label}</h2>
                    <p className="text-muted mt-1 text-xs">
                      批次 {batch.batchId.slice(0, 8)} ·{" "}
                      {formatDateTime(batch.createdAt)}
                    </p>
                  </div>
                  <span
                    className={
                      complete === batch.results.length
                        ? "status-badge-success"
                        : "status-badge-warning"
                    }
                  >
                    {complete}/{batch.results.length} 已完成
                  </span>
                </div>
                <ul className="mt-3 divide-y divide-slate-200 text-sm dark:divide-slate-800">
                  {batch.results.map((result) => (
                    <li
                      className="grid gap-1 py-2 sm:grid-cols-[1fr_auto]"
                      key={result.commandId}
                    >
                      <span>
                        {deviceNames.get(result.deviceId) ??
                          result.deviceId.slice(0, 8)}
                      </span>
                      <span className="text-muted text-xs">
                        {STATUS_LABELS[result.status]}
                        {result.errorCode === undefined
                          ? ""
                          : ` · ${result.errorCode}`}
                      </span>
                    </li>
                  ))}
                </ul>
              </article>
            );
          })}
        </div>
      )}
    </>
  );
}
