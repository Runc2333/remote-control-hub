import {
  faBan,
  faKey,
  faRotate,
  faShieldHalved,
  faTrash,
  faUserPlus,
} from "@fortawesome/free-solid-svg-icons";
import type { ApiClient } from "@remote-control-hub/api-client";
import type {
  AdminDevice,
  AdminSystemSummaryResponse,
  AdminUser,
  AuditEvent,
  IdentifierType,
  RegistrationMode,
} from "@remote-control-hub/contracts";
import { Icon } from "@remote-control-hub/ui";
import { useCallback, useEffect, useState } from "react";
import { StepUpPanel } from "./StepUpPanel.js";

type AdminPanelProps = {
  apiClient: ApiClient;
};

const INPUT_CLASS =
  "min-h-11 rounded-lg border border-slate-300 bg-white px-3 text-sm dark:border-slate-700 dark:bg-slate-950";

const formatDateTime = (value: string): string =>
  new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));

export function AdminPanel({ apiClient }: AdminPanelProps) {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [devices, setDevices] = useState<AdminDevice[]>([]);
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [systemSummary, setSystemSummary] =
    useState<AdminSystemSummaryResponse>();
  const [registrationMode, setRegistrationMode] =
    useState<RegistrationMode>("closed");
  const [identifierType, setIdentifierType] = useState<IdentifierType>("email");
  const [identifier, setIdentifier] = useState("");
  const [message, setMessage] = useState<string | undefined>();

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const [
        userResponse,
        deviceResponse,
        auditResponse,
        registration,
        summary,
      ] = await Promise.all([
        apiClient.getAdminUsers(),
        apiClient.getAdminDevices(),
        apiClient.getAdminAuditEvents({ limit: 30 }),
        apiClient.getRegistrationMode(),
        apiClient.getAdminSystemSummary(),
      ]);
      setUsers(userResponse.users);
      setDevices(deviceResponse.devices);
      setEvents(auditResponse.events);
      setRegistrationMode(registration.mode);
      setSystemSummary(summary);
      setMessage(undefined);
    } catch {
      setMessage("管理员数据加载失败，请确认会话仍有效。");
    }
  }, [apiClient]);

  useEffect(() => {
    const timeout = window.setTimeout(() => void refresh(), 0);
    return () => window.clearTimeout(timeout);
  }, [refresh]);

  const confirmationToken = async (
    action: string,
    targetId: string,
    payload: Record<string, unknown>,
    prompt: string,
  ): Promise<string | undefined> => {
    if (!window.confirm(prompt)) {
      return undefined;
    }
    try {
      return (
        await apiClient.issueActionConfirmation({ action, payload, targetId })
      ).token;
    } catch {
      setMessage("需要先重新验证身份，然后再次确认操作。");
      return undefined;
    }
  };

  const createUser = async (): Promise<void> => {
    try {
      const created = await apiClient.createAdminUser({
        identifier,
        identifierType,
      });
      setIdentifier("");
      setMessage(
        `临时密码（仅显示一次）：${created.temporaryPassword}；有效期至 ${formatDateTime(created.temporaryPasswordExpiresAt)}`,
      );
      await refresh();
    } catch {
      setMessage("用户创建失败，请检查标识是否有效或已存在。");
    }
  };

  const updateUser = async (
    user: AdminUser,
    update: { role?: "admin" | "user"; status?: "active" | "disabled" },
  ): Promise<void> => {
    const token = await confirmationToken(
      "admin.user.update",
      user.id,
      update,
      `确认修改用户 ${user.displayIdentifier}？`,
    );
    if (token === undefined) {
      return;
    }
    try {
      await apiClient.updateAdminUser(user.id, {
        confirmationToken: token,
        ...update,
      });
      await refresh();
    } catch {
      setMessage("用户修改失败；最后一个可用管理员不能被禁用或降级。");
    }
  };

  const resetPassword = async (user: AdminUser): Promise<void> => {
    const reference = window.prompt("请输入线下身份核验记录编号");
    if (reference === null || reference.trim().length === 0) {
      return;
    }
    const payload = { identityVerificationReference: reference.trim() };
    const token = await confirmationToken(
      "admin.user.reset_password",
      user.id,
      payload,
      `确认强制重置 ${user.displayIdentifier} 的密码并撤销其会话？`,
    );
    if (token === undefined) {
      return;
    }
    try {
      const result = await apiClient.resetAdminUserPassword(user.id, {
        confirmationToken: token,
        ...payload,
      });
      setMessage(
        `临时密码（仅显示一次）：${result.temporaryPassword}；有效期至 ${formatDateTime(result.temporaryPasswordExpiresAt)}`,
      );
      await refresh();
    } catch {
      setMessage("密码重置失败。");
    }
  };

  const resetAuthentication = async (user: AdminUser): Promise<void> => {
    const reference = window.prompt("请输入线下身份核验记录编号");
    if (reference === null || reference.trim().length === 0) {
      return;
    }
    const payload = { identityVerificationReference: reference.trim() };
    const token = await confirmationToken(
      "admin.user.reset_authentication",
      user.id,
      payload,
      `确认删除 ${user.displayIdentifier} 的全部 Passkey、TOTP 和恢复码？`,
    );
    if (token === undefined) {
      return;
    }
    try {
      await apiClient.resetAdminUserAuthentication(user.id, {
        confirmationToken: token,
        ...payload,
      });
      setMessage("增强认证已重置，用户的全部会话已撤销。");
      await refresh();
    } catch {
      setMessage("增强认证重置失败。");
    }
  };

  const deleteUser = async (user: AdminUser): Promise<void> => {
    const reference = window.prompt("请输入线下身份核验记录编号");
    if (reference === null || reference.trim().length === 0) {
      return;
    }
    const payload = { identityVerificationReference: reference.trim() };
    const token = await confirmationToken(
      "admin.user.delete",
      user.id,
      payload,
      `确认不可逆删除 ${user.displayIdentifier}？其会话、设备凭据和未完成命令将失效。`,
    );
    if (token === undefined) {
      return;
    }
    try {
      await apiClient.deleteAdminUser(user.id, {
        confirmationToken: token,
        ...payload,
      });
      await refresh();
    } catch {
      setMessage("用户删除失败；最后一个可用管理员不能被删除。");
    }
  };

  const updateRegistration = async (): Promise<void> => {
    const mode = registrationMode === "open" ? "closed" : "open";
    const token = await confirmationToken(
      "admin.registration.update",
      "registration",
      { mode },
      `确认将开放注册切换为“${mode === "open" ? "开放" : "关闭"}”？`,
    );
    if (token === undefined) {
      return;
    }
    try {
      const result = await apiClient.updateRegistrationMode(mode, token);
      setRegistrationMode(result.mode);
      await refresh();
    } catch {
      setMessage("注册策略修改失败。");
    }
  };

  const revokeDevice = async (device: AdminDevice): Promise<void> => {
    const token = await confirmationToken(
      "admin.device.credentials_revoke",
      device.id,
      {},
      `确认永久撤销设备 ${device.computerName} 的凭据？设备必须重新注册。`,
    );
    if (token === undefined) {
      return;
    }
    try {
      await apiClient.revokeAdminDeviceCredentials(device.id, {
        confirmationToken: token,
      });
      await refresh();
    } catch {
      setMessage("设备凭据撤销失败。");
    }
  };

  const deleteDevice = async (device: AdminDevice): Promise<void> => {
    const token = await confirmationToken(
      "admin.device.delete",
      device.id,
      {},
      `确认删除已撤销设备 ${device.computerName} 的可识别信息？`,
    );
    if (token === undefined) {
      return;
    }
    try {
      await apiClient.deleteAdminDevice(device.id, {
        confirmationToken: token,
      });
      await refresh();
    } catch {
      setMessage("只有已撤销凭据的设备可以删除。");
    }
  };

  return (
    <div className="space-y-4">
      <StepUpPanel apiClient={apiClient} />
      {message !== undefined && (
        <p
          className="rounded-lg bg-amber-50 p-3 text-sm text-amber-950 dark:bg-amber-950 dark:text-amber-100"
          role="status"
        >
          {message}
        </p>
      )}
      {systemSummary === undefined ? null : (
        <section className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
          <h2 className="font-semibold">系统容量与 Agent 版本</h2>
          <dl className="mt-3 grid grid-cols-3 gap-3 text-sm">
            <div>
              <dt className="text-slate-500">注册设备</dt>
              <dd className="text-lg font-semibold">
                {systemSummary.registeredDevices}
              </dd>
            </div>
            <div>
              <dt className="text-slate-500">在线 Agent</dt>
              <dd className="text-lg font-semibold">
                {systemSummary.onlineAgents}
              </dd>
            </div>
            <div>
              <dt className="text-slate-500">浏览器会话</dt>
              <dd className="text-lg font-semibold">
                {systemSummary.activeBrowserSessions}
              </dd>
            </div>
          </dl>
          {systemSummary.capacityWarnings.length === 0 ? (
            <p className="mt-3 text-xs text-emerald-700">容量未达到预警线。</p>
          ) : (
            <p className="mt-3 text-xs text-amber-700" role="status">
              容量预警：{systemSummary.capacityWarnings.join("、")}
            </p>
          )}
          <ul className="mt-3 text-xs text-slate-500">
            {systemSummary.agentVersions.map((version) => (
              <li key={`${version.serviceVersion}-${version.sessionVersion}`}>
                Service {version.serviceVersion} / Session{" "}
                {version.sessionVersion}：{version.online}/{version.registered}{" "}
                在线
              </li>
            ))}
          </ul>
        </section>
      )}
      <section className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="flex items-center gap-2 font-semibold">
              <Icon icon={faShieldHalved} />
              注册策略与用户治理
            </h2>
            <p className="text-xs text-slate-500">
              当前开放注册：{registrationMode === "open" ? "开放" : "关闭"}
            </p>
          </div>
          <button
            className="min-h-11 rounded-lg border border-slate-300 px-3 text-sm font-medium dark:border-slate-700"
            onClick={() => void updateRegistration()}
            type="button"
          >
            切换注册策略
          </button>
        </div>
        <div className="mt-3 grid gap-2 sm:grid-cols-[9rem_1fr_auto]">
          <select
            className={INPUT_CLASS}
            onChange={(event) =>
              setIdentifierType(event.target.value as IdentifierType)
            }
            value={identifierType}
          >
            <option value="email">邮箱</option>
            <option value="phone">国际手机号</option>
          </select>
          <input
            className={INPUT_CLASS}
            onChange={(event) => setIdentifier(event.target.value)}
            placeholder={
              identifierType === "email" ? "user@example.com" : "+8613800000000"
            }
            value={identifier}
          />
          <button
            className="flex min-h-11 items-center justify-center gap-2 rounded-lg bg-teal-700 px-4 text-sm font-medium text-white disabled:opacity-50"
            disabled={identifier.trim().length < 3}
            onClick={() => void createUser()}
            type="button"
          >
            <Icon icon={faUserPlus} />
            创建用户
          </button>
        </div>
        <ul className="mt-3 divide-y divide-slate-200 text-sm dark:divide-slate-800">
          {users.map((user) => (
            <li
              className="grid gap-2 py-3 lg:grid-cols-[1fr_auto]"
              key={user.id}
            >
              <span>
                <strong>{user.displayIdentifier}</strong>
                <span className="ml-2 text-xs text-slate-500">
                  {user.role} · {user.status}
                  {user.mustChangePassword ? " · 待修改临时密码" : ""}
                </span>
              </span>
              {user.status !== "deleted" && (
                <span className="flex flex-wrap gap-2">
                  <button
                    className="min-h-11 rounded-lg border border-slate-300 px-3 dark:border-slate-700"
                    onClick={() =>
                      void updateUser(user, {
                        role: user.role === "admin" ? "user" : "admin",
                      })
                    }
                    type="button"
                  >
                    {user.role === "admin" ? "降为用户" : "提升管理员"}
                  </button>
                  <button
                    className="min-h-11 rounded-lg border border-slate-300 px-3 dark:border-slate-700"
                    onClick={() =>
                      void updateUser(user, {
                        status:
                          user.status === "active" ? "disabled" : "active",
                      })
                    }
                    type="button"
                  >
                    {user.status === "active" ? "禁用" : "恢复"}
                  </button>
                  <button
                    className="min-h-11 rounded-lg border border-slate-300 px-3 dark:border-slate-700"
                    onClick={() => void resetPassword(user)}
                    type="button"
                  >
                    重置密码
                  </button>
                  <button
                    className="min-h-11 rounded-lg border border-slate-300 px-3 dark:border-slate-700"
                    onClick={() => void resetAuthentication(user)}
                    type="button"
                  >
                    重置增强认证
                  </button>
                  <button
                    className="flex min-h-11 items-center gap-2 rounded-lg border border-red-300 px-3 text-red-700 dark:border-red-900"
                    onClick={() => void deleteUser(user)}
                    type="button"
                  >
                    <Icon icon={faTrash} />
                    删除用户
                  </button>
                </span>
              )}
            </li>
          ))}
        </ul>
      </section>
      <section className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
        <h2 className="font-semibold">全局设备治理</h2>
        <ul className="mt-3 divide-y divide-slate-200 text-sm dark:divide-slate-800">
          {devices.map((device) => (
            <li
              className="grid gap-2 py-3 lg:grid-cols-[1fr_auto]"
              key={device.id}
            >
              <span>
                <strong>{device.computerName}</strong>
                <span className="ml-2 text-xs text-slate-500">
                  {device.ownerDisplayIdentifier} ·{" "}
                  {device.online ? "在线" : "离线"} ·{" "}
                  {device.disabled ? "已禁用" : "可用"} · 凭据
                  {device.credentialStatus === "active" ? "有效" : "已撤销"}
                </span>
              </span>
              <span className="flex flex-wrap gap-2">
                <button
                  className="flex min-h-11 items-center gap-2 rounded-lg border border-slate-300 px-3 dark:border-slate-700"
                  onClick={() =>
                    void apiClient
                      .updateAdminDevice(device.id, {
                        disabled: !device.disabled,
                      })
                      .then(refresh)
                      .catch(() => setMessage("设备状态修改失败。"))
                  }
                  type="button"
                >
                  <Icon icon={device.disabled ? faRotate : faBan} />
                  {device.disabled ? "恢复" : "禁用"}
                </button>
                {device.credentialStatus === "active" ? (
                  <button
                    className="flex min-h-11 items-center gap-2 rounded-lg border border-red-300 px-3 text-red-700 dark:border-red-900"
                    onClick={() => void revokeDevice(device)}
                    type="button"
                  >
                    <Icon icon={faKey} />
                    撤销凭据
                  </button>
                ) : (
                  <button
                    className="flex min-h-11 items-center gap-2 rounded-lg border border-red-300 px-3 text-red-700 dark:border-red-900"
                    onClick={() => void deleteDevice(device)}
                    type="button"
                  >
                    <Icon icon={faTrash} />
                    删除墓碑信息
                  </button>
                )}
              </span>
            </li>
          ))}
        </ul>
      </section>
      <section className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
        <h2 className="font-semibold">系统安全审计</h2>
        <ul className="mt-3 divide-y divide-slate-200 text-sm dark:divide-slate-800">
          {events.map((event) => (
            <li
              className="grid gap-1 py-2 sm:grid-cols-[1fr_auto]"
              key={event.id}
            >
              <span>
                <strong>{event.action}</strong> · {event.result} ·{" "}
                {event.subjectType}:{event.subjectId}
              </span>
              <span className="text-xs text-slate-500">
                {formatDateTime(event.occurredAt)} · {event.sourceAddressClass}
              </span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
