import { faClockRotateLeft } from "@fortawesome/free-solid-svg-icons";
import type { ApiClient } from "@remote-control-hub/api-client";
import type { AuditEvent } from "@remote-control-hub/contracts";
import { Icon } from "@remote-control-hub/ui";
import { useEffect, useState } from "react";

type AuditPanelProps = {
  apiClient: ApiClient;
};

const formatDateTime = (value: string): string =>
  new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));

export function AuditPanel({ apiClient }: AuditPanelProps) {
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let active = true;
    void apiClient
      .getAuditEvents({ limit: 30 })
      .then((response) => {
        if (active) {
          setEvents(response.events);
        }
      })
      .catch(() => {
        if (active) {
          setFailed(true);
        }
      });
    return () => {
      active = false;
    };
  }, [apiClient]);

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
      <h2 className="flex items-center gap-2 font-semibold">
        <Icon icon={faClockRotateLeft} />
        我的安全审计
      </h2>
      <p className="mt-1 text-xs text-slate-500">
        仅显示与当前账号及自有设备相关的脱敏事件。
      </p>
      {failed ? (
        <p className="mt-3 text-sm text-red-700" role="alert">
          审计记录暂不可用。
        </p>
      ) : events.length === 0 ? (
        <p className="mt-3 text-sm text-slate-500">暂无审计记录。</p>
      ) : (
        <ul className="mt-3 divide-y divide-slate-200 text-sm dark:divide-slate-800">
          {events.map((event) => (
            <li
              className="grid gap-1 py-2 sm:grid-cols-[1fr_auto]"
              key={event.id}
            >
              <span>
                <strong>{event.action}</strong> · {event.result}
              </span>
              <span className="text-xs text-slate-500">
                {formatDateTime(event.occurredAt)} · {event.sourceAddressClass}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
