import type { AuditEventListResponse } from "@remote-control-hub/contracts";
import { useLoaderData } from "react-router";
import { PageHeader } from "../components/PageHeader.js";
import { formatDateTime } from "../lib/date-time.js";

export function AuditPage() {
  const { events } = useLoaderData() as AuditEventListResponse;
  return (
    <>
      <PageHeader
        description="仅显示与当前账号及自有设备相关的脱敏事件。"
        title="我的安全审计"
      />
      {events.length === 0 ? (
        <section className="surface-card p-6 text-center">
          <p className="text-muted text-sm">暂无审计记录。</p>
        </section>
      ) : (
        <section className="surface-card overflow-hidden">
          <ul className="divide-y divide-slate-200 dark:divide-slate-800">
            {events.map((event) => (
              <li
                className="grid gap-2 p-4 text-sm sm:grid-cols-[1fr_auto]"
                key={event.id}
              >
                <div>
                  <strong>{event.action}</strong>
                  <p className="text-muted mt-1 text-xs">
                    {event.subjectType} · {event.sourceAddressClass}
                  </p>
                </div>
                <div className="sm:text-right">
                  <span
                    className={
                      event.result === "success"
                        ? "status-badge-success"
                        : "status-badge-danger"
                    }
                  >
                    {event.result}
                  </span>
                  <p className="text-muted mt-1 text-xs">
                    {formatDateTime(event.occurredAt)}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}
