import type { Device } from "@remote-control-hub/contracts";
import { Icon } from "@remote-control-hub/ui";
import { useState } from "react";
import { Link, useLoaderData, useNavigate } from "react-router";
import { DEVICE_CONTROLS } from "../components/device-controls.js";
import { PageHeader } from "../components/PageHeader.js";
import { API_CLIENT } from "../lib/api-client.js";
import { formatDateTime } from "../lib/date-time.js";

export function DeviceDetailPage() {
  const device = useLoaderData() as Device;
  const [pending, setPending] = useState<string>();
  const [message, setMessage] = useState<string>();
  const navigate = useNavigate();

  const send = async (
    capability: Device["capabilities"][number],
  ): Promise<void> => {
    if (
      capability === "display.turn_off" &&
      !window.confirm(`确认向 ${device.computerName} 发送关闭显示器命令？`)
    ) {
      return;
    }
    setPending(capability);
    try {
      const batch = await API_CLIENT.createCommand({
        commandType: capability,
        deviceIds: [device.id],
        idempotencyKey: crypto.randomUUID(),
      });
      await navigate(`/commands?batch=${encodeURIComponent(batch.batchId)}`);
    } catch {
      setMessage("命令未能提交，请稍后重试。");
    } finally {
      setPending(undefined);
    }
  };

  return (
    <>
      <PageHeader
        actions={
          <Link className="button-secondary" to="/devices">
            返回设备列表
          </Link>
        }
        description={`${device.id.slice(0, 8)} · ${device.online ? "在线" : "离线"}`}
        title={device.computerName}
      />
      <section className="surface-card p-4">
        <dl className="grid gap-4 text-sm sm:grid-cols-3">
          <div>
            <dt className="text-muted">最近活动</dt>
            <dd className="mt-1 font-medium">
              {device.lastActiveAt === undefined
                ? "暂无"
                : formatDateTime(device.lastActiveAt)}
            </dd>
          </div>
          <div>
            <dt className="text-muted">Service 版本</dt>
            <dd className="mt-1 font-medium">{device.serviceVersion}</dd>
          </div>
          <div>
            <dt className="text-muted">Session 版本</dt>
            <dd className="mt-1 font-medium">{device.sessionVersion}</dd>
          </div>
        </dl>
      </section>
      <section className="surface-card mt-4 p-4">
        <h2 className="font-semibold">远程控制</h2>
        <p className="text-muted mt-1 text-sm">
          仅显示该 Agent 明确声明支持的白名单命令。
        </p>
        <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
          {DEVICE_CONTROLS.filter((control) =>
            device.capabilities.includes(control.capability),
          ).map((control) => (
            <button
              className="button-secondary flex-col gap-2 px-2 text-xs"
              disabled={!device.online || pending !== undefined}
              key={control.capability}
              onClick={() => void send(control.capability)}
              type="button"
            >
              <Icon icon={control.icon} />
              {pending === control.capability ? "正在提交…" : control.label}
            </button>
          ))}
        </div>
        {message === undefined ? null : (
          <p className="status-error mt-4" role="alert">
            {message}
          </p>
        )}
      </section>
    </>
  );
}
