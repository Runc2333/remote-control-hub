import { faKey, faRotate } from "@fortawesome/free-solid-svg-icons";
import type {
  DeviceCapability,
  DeviceListResponse,
} from "@remote-control-hub/contracts";
import { Icon } from "@remote-control-hub/ui";
import { useMemo, useState } from "react";
import { Link, useLoaderData, useRevalidator } from "react-router";
import { DEVICE_CONTROLS } from "../components/device-controls.js";
import { PageHeader } from "../components/PageHeader.js";
import { API_CLIENT } from "../lib/api-client.js";
import { formatDateTime } from "../lib/date-time.js";

type PageMessage =
  | { batchId: string; kind: "success"; text: string }
  | { kind: "error"; text: string };

export function DevicesPage() {
  const { devices } = useLoaderData() as DeviceListResponse;
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [commandType, setCommandType] =
    useState<DeviceCapability>("display.turn_off");
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<PageMessage>();
  const revalidator = useRevalidator();
  const selectedDevices = useMemo(
    () => devices.filter((device) => selected.has(device.id)),
    [devices, selected],
  );
  const control = DEVICE_CONTROLS.find(
    (candidate) => candidate.capability === commandType,
  );
  const validTargets = selectedDevices.filter(
    (device) => device.online && device.capabilities.includes(commandType),
  );

  const toggle = (deviceId: string): void => {
    if (!selected.has(deviceId) && selected.size >= 100) {
      setMessage({
        kind: "error",
        text: "单次批量操作最多选择 100 台设备。",
      });
      return;
    }
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(deviceId)) {
        next.delete(deviceId);
      } else {
        next.add(deviceId);
      }
      return next;
    });
  };

  const sendBatch = async (): Promise<void> => {
    if (validTargets.length === 0) {
      setMessage({
        kind: "error",
        text: "请选择至少一台在线且支持该操作的设备。",
      });
      return;
    }
    if (
      commandType === "display.turn_off" &&
      !window.confirm(
        `确认向 ${validTargets.length} 台设备发送关闭显示器命令？`,
      )
    ) {
      return;
    }
    setMessage(undefined);
    setPending(true);
    try {
      const batch = await API_CLIENT.createCommand({
        commandType,
        deviceIds: validTargets.map((device) => device.id),
        idempotencyKey: crypto.randomUUID(),
      });
      setSelected(new Set<string>());
      setMessage({
        batchId: batch.batchId,
        kind: "success",
        text: "命令已提交。",
      });
    } catch {
      setMessage({
        kind: "error",
        text: "命令未能提交，请检查设备状态后重试。",
      });
    } finally {
      setPending(false);
    }
  };

  return (
    <>
      <PageHeader
        actions={
          <div className="flex gap-2">
            <button
              className="button-icon"
              onClick={() => void revalidator.revalidate()}
              type="button"
            >
              <Icon icon={faRotate} label="刷新设备" />
            </button>
            <Link className="button-primary" to="/devices/enroll">
              <Icon icon={faKey} />
              创建设备注册码
            </Link>
          </div>
        }
        description={`${devices.filter((device) => device.online).length} 台在线 / ${devices.length} 台已注册`}
        title="我的设备"
      />
      {devices.length === 0 ? (
        <section className="surface-card border-dashed p-8 text-center">
          <h2 className="font-semibold">尚未注册设备</h2>
          <p className="text-muted mt-1 text-sm">
            生成一次性注册码，然后在 Windows Agent 注册向导中输入。
          </p>
          <Link
            className="button-primary mt-4 inline-flex"
            to="/devices/enroll"
          >
            开始注册设备
          </Link>
        </section>
      ) : (
        <>
          <section className="surface-card mb-4 p-4">
            <div className="grid gap-3 lg:grid-cols-[1fr_auto] lg:items-end">
              <label className="grid gap-1 text-sm font-medium">
                批量操作
                <select
                  className="input-field"
                  onChange={(event) =>
                    setCommandType(event.target.value as DeviceCapability)
                  }
                  value={commandType}
                >
                  {DEVICE_CONTROLS.map((item) => (
                    <option key={item.capability} value={item.capability}>
                      {item.label}
                    </option>
                  ))}
                </select>
              </label>
              <button
                className="button-primary"
                disabled={pending || validTargets.length === 0}
                onClick={() => void sendBatch()}
                type="button"
              >
                {control === undefined ? null : <Icon icon={control.icon} />}
                {pending ? "正在提交…" : `向 ${validTargets.length} 台设备发送`}
              </button>
            </div>
            <p className="text-muted mt-2 text-xs">
              已选择 {selected.size} 台；离线或不支持该操作的设备会自动排除。
            </p>
            {message === undefined ? null : (
              <div
                className={`${message.kind === "success" ? "status-success" : "status-error"} mt-3`}
                role={message.kind === "success" ? "status" : "alert"}
              >
                {message.text}
                {message.kind === "success" ? (
                  <Link
                    className="ml-2 font-semibold underline underline-offset-4"
                    to={`/commands?batch=${encodeURIComponent(message.batchId)}`}
                  >
                    查看命令状态
                  </Link>
                ) : null}
              </div>
            )}
          </section>
          <div className="grid gap-3 lg:grid-cols-2">
            {devices.map((device) => (
              <article className="surface-card p-4" key={device.id}>
                <div className="flex items-start gap-3">
                  <input
                    aria-label={`选择 ${device.computerName}`}
                    checked={selected.has(device.id)}
                    className="mt-1 size-5 accent-teal-700"
                    onChange={() => toggle(device.id)}
                    type="checkbox"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <Link
                          className="truncate font-semibold hover:text-teal-700 dark:hover:text-teal-300"
                          to={`/devices/${device.id}`}
                        >
                          {device.computerName}
                        </Link>
                        <p className="text-muted mt-1 text-xs">
                          {device.id.slice(0, 8)} · Service{" "}
                          {device.serviceVersion} · Session{" "}
                          {device.sessionVersion}
                        </p>
                      </div>
                      <span
                        className={
                          device.online
                            ? "status-badge-success"
                            : "status-badge-neutral"
                        }
                      >
                        {device.online ? "在线" : "离线"}
                      </span>
                    </div>
                    <p className="text-muted mt-3 text-xs">
                      最近活动：
                      {device.lastActiveAt === undefined
                        ? "暂无"
                        : formatDateTime(device.lastActiveAt)}
                    </p>
                  </div>
                </div>
              </article>
            ))}
          </div>
        </>
      )}
    </>
  );
}
