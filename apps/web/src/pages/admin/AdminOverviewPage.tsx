import type { AdminSystemSummaryResponse } from "@remote-control-hub/contracts";
import { useLoaderData } from "react-router";
import { PageHeader } from "../../components/PageHeader.js";
import { formatDateTime } from "../../lib/date-time.js";

export function AdminOverviewPage() {
  const summary = useLoaderData() as AdminSystemSummaryResponse;
  return (
    <>
      <PageHeader
        description={`检查时间：${formatDateTime(summary.checkedAt)}`}
        title="系统概览"
      />
      <div className="grid gap-3 sm:grid-cols-3">
        <article className="surface-card p-4">
          <p className="text-muted text-sm">注册设备</p>
          <p className="mt-2 text-3xl font-semibold">
            {summary.registeredDevices}
          </p>
        </article>
        <article className="surface-card p-4">
          <p className="text-muted text-sm">在线 Agent</p>
          <p className="mt-2 text-3xl font-semibold">{summary.onlineAgents}</p>
        </article>
        <article className="surface-card p-4">
          <p className="text-muted text-sm">浏览器会话</p>
          <p className="mt-2 text-3xl font-semibold">
            {summary.activeBrowserSessions}
          </p>
        </article>
      </div>
      {summary.capacityWarnings.length === 0 ? (
        <p className="status-success mt-4">容量未达到预警线。</p>
      ) : (
        <p className="status-warning mt-4" role="status">
          容量预警：{summary.capacityWarnings.join("、")}
        </p>
      )}
      <section className="surface-card mt-4 p-4">
        <h2 className="font-semibold">Agent 版本分布</h2>
        {summary.agentVersions.length === 0 ? (
          <p className="text-muted mt-3 text-sm">暂无已注册 Agent。</p>
        ) : (
          <ul className="mt-3 divide-y divide-slate-200 text-sm dark:divide-slate-800">
            {summary.agentVersions.map((version) => (
              <li
                className="grid gap-1 py-3 sm:grid-cols-[1fr_auto]"
                key={`${version.serviceVersion}-${version.sessionVersion}`}
              >
                <span>
                  Service {version.serviceVersion} · Session{" "}
                  {version.sessionVersion}
                </span>
                <span className="text-muted text-xs">
                  {version.online} 在线 / {version.registered} 注册
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
