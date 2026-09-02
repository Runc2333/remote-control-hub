import { faKey, faRotate } from "@fortawesome/free-solid-svg-icons";
import type {
  Device,
  DeviceCapability,
  DeviceListResponse,
} from "@remote-control-hub/contracts";
import { Icon } from "@remote-control-hub/ui";
import { useEffect, useMemo, useState } from "react";
import { Link, useLoaderData, useRevalidator } from "react-router";
import { DEVICE_CONTROLS, type DeviceControl } from "../components/device-controls.js";
import { PageHeader } from "../components/PageHeader.js";
import { API_CLIENT } from "../lib/api-client.js";
import { formatDateTime } from "../lib/date-time.js";

type PageMessage =
  | { batchId: string; kind: "success"; text: string }
  | { kind: "error"; text: string };

type RemoteButtonProps = {
  control: DeviceControl;
  selectedDevices: readonly Device[];
  pending: boolean;
  onCommand: (capability: DeviceCapability) => void;
};

function RemoteButton({
  control,
  selectedDevices,
  pending,
  onCommand,
}: RemoteButtonProps) {
  const validTargets = selectedDevices.filter(
    (device) => device.online && device.capabilities.includes(control.capability),
  );
  const isDisabled = pending || validTargets.length === 0;

  return (
    <button
      className={`flex aspect-square flex-col items-center justify-center rounded-lg border-2 p-2 transition-all ${
        isDisabled
          ? "border-neutral-200 bg-neutral-50 text-neutral-400 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-500"
          : "border-teal-200 bg-teal-50 text-teal-700 hover:border-teal-400 hover:bg-teal-100 dark:border-teal-800 dark:bg-teal-900/20 dark:text-teal-300 dark:hover:border-teal-600 dark:hover:bg-teal-900/40"
      }`}
      disabled={isDisabled}
      onClick={() => void onCommand(control.capability)}
      type="button"
      title={`${control.label} (${validTargets.length} 台可用)`}
    >
      <Icon icon={control.icon} size="lg" />
      <span className="mt-1 text-[10px] font-medium leading-tight">
        {control.label}
      </span>
    </button>
  );
}

export function DevicesPage() {
  const { devices } = useLoaderData() as DeviceListResponse;
  
  // Initialize selected devices from localStorage or auto-select first device
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => {
    const saved = localStorage.getItem("selectedDevices");
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed) && parsed.length > 0) {
          return new Set(parsed);
        }
      } catch {
        // Ignore invalid JSON
      }
    }
    // Auto-select first device if only one exists
    if (devices.length === 1) {
      const firstDevice = devices[0];
      if (firstDevice) {
        localStorage.setItem("selectedDevices", JSON.stringify([firstDevice.id]));
        return new Set([firstDevice.id]);
      }
    }
    return new Set();
  });
  
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<PageMessage>();
  const revalidator = useRevalidator();

  // Save selection to localStorage whenever it changes
  useEffect(() => {
    localStorage.setItem("selectedDevices", JSON.stringify([...selected]));
  }, [selected]);
  const selectedDevices = useMemo(
    () => devices.filter((device) => selected.has(device.id)),
    [devices, selected],
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

  const sendCommand = async (commandType: DeviceCapability): Promise<void> => {
    const validTargets = selectedDevices.filter(
      (device) => device.online && device.capabilities.includes(commandType),
    );

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
      // Don't clear selection after command
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
            <div className="mb-4">
              <h3 className="font-semibold text-sm">遥控器控制面板</h3>
              <p className="text-muted mt-1 text-xs">
                已选择 {selected.size} 台设备；离线或不支持该操作的设备会自动排除。
              </p>
            </div>

            {/* Remote Control 9-Grid Layout */}
            <div className="mx-auto grid max-w-xs grid-cols-3 gap-2">
              {/* Row 1 */}
              {(() => {
                const control = DEVICE_CONTROLS.at(0);
                return control ? (
                  <RemoteButton
                    control={control} // display.turn_off
                    selectedDevices={selectedDevices}
                    pending={pending}
                    onCommand={sendCommand}
                  />
                ) : null;
              })()}
              {(() => {
                const control = DEVICE_CONTROLS.at(1);
                return control ? (
                  <RemoteButton
                    control={control} // media.volume_up
                    selectedDevices={selectedDevices}
                    pending={pending}
                    onCommand={sendCommand}
                  />
                ) : null;
              })()}
              {(() => {
                const control = DEVICE_CONTROLS.at(3);
                return control ? (
                  <RemoteButton
                    control={control} // media.volume_mute_toggle
                    selectedDevices={selectedDevices}
                    pending={pending}
                    onCommand={sendCommand}
                  />
                ) : null;
              })()}
              
              {/* Row 2 */}
              {(() => {
                const control = DEVICE_CONTROLS.at(5);
                return control ? (
                  <RemoteButton
                    control={control} // media.previous_track
                    selectedDevices={selectedDevices}
                    pending={pending}
                    onCommand={sendCommand}
                  />
                ) : null;
              })()}
              <div className="flex items-center justify-center">
                <span className="text-muted text-xs">🎮</span>
              </div>
              {(() => {
                const control = DEVICE_CONTROLS.at(6);
                return control ? (
                  <RemoteButton
                    control={control} // media.next_track
                    selectedDevices={selectedDevices}
                    pending={pending}
                    onCommand={sendCommand}
                  />
                ) : null;
              })()}
              
              {/* Row 3 */}
              {(() => {
                const control = DEVICE_CONTROLS.at(7);
                return control ? (
                  <RemoteButton
                    control={control} // media.stop
                    selectedDevices={selectedDevices}
                    pending={pending}
                    onCommand={sendCommand}
                  />
                ) : null;
              })()}
              {(() => {
                const control = DEVICE_CONTROLS.at(2);
                return control ? (
                  <RemoteButton
                    control={control} // media.volume_down
                    selectedDevices={selectedDevices}
                    pending={pending}
                    onCommand={sendCommand}
                  />
                ) : null;
              })()}
              {(() => {
                const control = DEVICE_CONTROLS.at(4);
                return control ? (
                  <RemoteButton
                    control={control} // media.play_pause
                    selectedDevices={selectedDevices}
                    pending={pending}
                    onCommand={sendCommand}
                  />
                ) : null;
              })()}
            </div>

            {message === undefined ? null : (
              <div
                className={`${message.kind === "success" ? "status-success" : "status-error"} mt-4`}
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
