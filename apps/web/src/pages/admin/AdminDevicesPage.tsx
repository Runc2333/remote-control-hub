import type {
  AdminDevice,
  AdminDeviceListResponse,
} from "@remote-control-hub/contracts";
import { useState } from "react";
import { useLoaderData, useRevalidator } from "react-router";
import { PageHeader } from "../../components/PageHeader.js";
import { StepUpPanel } from "../../components/StepUpPanel.js";
import { API_CLIENT } from "../../lib/api-client.js";
import { formatDateTime } from "../../lib/date-time.js";

export function AdminDevicesPage() {
  const { devices } = useLoaderData() as AdminDeviceListResponse;
  const [message, setMessage] = useState<string>();
  const [pending, setPending] = useState<string>();
  const revalidator = useRevalidator();

  const confirmation = async (
    action: string,
    device: AdminDevice,
    prompt: string,
  ): Promise<string | undefined> => {
    if (!window.confirm(prompt)) return undefined;
    try {
      return (
        await API_CLIENT.issueActionConfirmation({
          action,
          payload: {},
          targetId: device.id,
        })
      ).token;
    } catch {
      setMessage("需要先完成增强身份验证，然后再次确认操作。");
      return undefined;
    }
  };

  const updateState = async (device: AdminDevice): Promise<void> => {
    setPending(device.id);
    try {
      await API_CLIENT.updateAdminDevice(device.id, {
        disabled: !device.disabled,
      });
      await revalidator.revalidate();
    } catch {
      setMessage("设备状态修改失败。");
    } finally {
      setPending(undefined);
    }
  };

  const destructiveAction = async (device: AdminDevice): Promise<void> => {
    const revoke = device.credentialStatus === "active";
    const token = await confirmation(
      revoke ? "admin.device.credentials_revoke" : "admin.device.delete",
      device,
      revoke
        ? `确认永久撤销设备 ${device.computerName} 的凭据？`
        : `确认删除设备 ${device.computerName} 的墓碑信息？`,
    );
    if (token === undefined) return;
    setPending(device.id);
    try {
      if (revoke)
        await API_CLIENT.revokeAdminDeviceCredentials(device.id, {
          confirmationToken: token,
        });
      else
        await API_CLIENT.deleteAdminDevice(device.id, {
          confirmationToken: token,
        });
      await revalidator.revalidate();
    } catch {
      setMessage(
        revoke ? "设备凭据撤销失败。" : "只有已撤销凭据的设备可以删除。",
      );
    } finally {
      setPending(undefined);
    }
  };

  return (
    <>
      <PageHeader
        description="管理员只能治理设备状态和凭据，不能跨用户控制设备。"
        title="全局设备治理"
      />
      <StepUpPanel apiClient={API_CLIENT} />
      {message === undefined ? null : (
        <p className="status-warning my-4" role="status">
          {message}
        </p>
      )}
      {devices.length === 0 ? (
        <section className="surface-card mt-4 p-6 text-center">
          <p className="text-muted">暂无注册设备。</p>
        </section>
      ) : (
        <div className="mt-4 space-y-3">
          {devices.map((device) => (
            <article className="surface-card p-4" key={device.id}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h2 className="font-semibold">{device.computerName}</h2>
                  <p className="text-muted mt-1 text-sm">
                    所有者：{device.ownerDisplayIdentifier}
                  </p>
                  <p className="text-muted mt-1 text-xs">
                    {device.online ? "在线" : "离线"} ·{" "}
                    {device.disabled ? "已禁用" : "可用"} · 凭据
                    {device.credentialStatus === "active" ? "有效" : "已撤销"} ·
                    最近活动{" "}
                    {device.lastActiveAt === undefined
                      ? "暂无"
                      : formatDateTime(device.lastActiveAt)}
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
              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  className="button-secondary"
                  disabled={pending === device.id}
                  onClick={() => void updateState(device)}
                  type="button"
                >
                  {device.disabled ? "恢复设备" : "禁用设备"}
                </button>
                <button
                  className="button-danger"
                  disabled={pending === device.id}
                  onClick={() => void destructiveAction(device)}
                  type="button"
                >
                  {device.credentialStatus === "active"
                    ? "撤销凭据"
                    : "删除墓碑信息"}
                </button>
              </div>
            </article>
          ))}
        </div>
      )}
    </>
  );
}
