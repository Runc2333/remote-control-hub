import type {
  AdminUser,
  AdminUserListResponse,
  IdentifierType,
  RegistrationMode,
} from "@remote-control-hub/contracts";
import { useState } from "react";
import { useLoaderData, useRevalidator } from "react-router";
import { PageHeader } from "../../components/PageHeader.js";
import { StepUpPanel } from "../../components/StepUpPanel.js";
import { API_CLIENT } from "../../lib/api-client.js";
import { formatDateTime } from "../../lib/date-time.js";

type AdminUsersData = AdminUserListResponse & {
  registrationMode: RegistrationMode;
};

export function AdminUsersPage() {
  const data = useLoaderData() as AdminUsersData;
  const [identifierType, setIdentifierType] = useState<IdentifierType>("email");
  const [identifier, setIdentifier] = useState("");
  const [message, setMessage] = useState<string>();
  const [pending, setPending] = useState(false);
  const revalidator = useRevalidator();

  const confirmation = async (
    action: string,
    targetId: string,
    payload: Record<string, unknown>,
    prompt: string,
  ): Promise<string | undefined> => {
    if (!window.confirm(prompt)) return undefined;
    try {
      return (
        await API_CLIENT.issueActionConfirmation({ action, payload, targetId })
      ).token;
    } catch {
      setMessage("需要先完成增强身份验证，然后再次确认操作。");
      return undefined;
    }
  };

  const createUser = async (): Promise<void> => {
    setPending(true);
    try {
      const created = await API_CLIENT.createAdminUser({
        identifier,
        identifierType,
      });
      setIdentifier("");
      setMessage(
        `临时密码（仅显示一次）：${created.temporaryPassword}；有效期至 ${formatDateTime(created.temporaryPasswordExpiresAt)}`,
      );
      await revalidator.revalidate();
    } catch {
      setMessage("用户创建失败，请检查标识是否有效或已存在。");
    } finally {
      setPending(false);
    }
  };

  const updateUser = async (
    user: AdminUser,
    update: { role?: "admin" | "user"; status?: "active" | "disabled" },
  ): Promise<void> => {
    const token = await confirmation(
      "admin.user.update",
      user.id,
      update,
      `确认修改用户 ${user.displayIdentifier}？`,
    );
    if (token === undefined) return;
    try {
      await API_CLIENT.updateAdminUser(user.id, {
        confirmationToken: token,
        ...update,
      });
      await revalidator.revalidate();
    } catch {
      setMessage("用户修改失败；最后一个可用管理员不能被禁用或降级。");
    }
  };

  const verifiedAction = async (
    user: AdminUser,
    kind: "delete" | "password" | "authentication",
  ): Promise<void> => {
    const reference = window.prompt("请输入线下身份核验记录编号");
    if (reference === null || reference.trim().length === 0) return;
    const payload = { identityVerificationReference: reference.trim() };
    const action =
      kind === "delete"
        ? "admin.user.delete"
        : kind === "password"
          ? "admin.user.reset_password"
          : "admin.user.reset_authentication";
    const prompt =
      kind === "delete"
        ? `确认不可逆删除 ${user.displayIdentifier}？`
        : kind === "password"
          ? `确认重置 ${user.displayIdentifier} 的密码并撤销其会话？`
          : `确认删除 ${user.displayIdentifier} 的全部增强认证凭据？`;
    const token = await confirmation(action, user.id, payload, prompt);
    if (token === undefined) return;
    try {
      if (kind === "delete") {
        await API_CLIENT.deleteAdminUser(user.id, {
          confirmationToken: token,
          ...payload,
        });
      } else if (kind === "password") {
        const result = await API_CLIENT.resetAdminUserPassword(user.id, {
          confirmationToken: token,
          ...payload,
        });
        setMessage(
          `临时密码（仅显示一次）：${result.temporaryPassword}；有效期至 ${formatDateTime(result.temporaryPasswordExpiresAt)}`,
        );
      } else {
        await API_CLIENT.resetAdminUserAuthentication(user.id, {
          confirmationToken: token,
          ...payload,
        });
        setMessage("增强认证已重置，用户的全部会话已撤销。");
      }
      await revalidator.revalidate();
    } catch {
      setMessage("操作失败；请确认身份验证状态和管理员安全约束。");
    }
  };

  const updateRegistration = async (): Promise<void> => {
    const mode: RegistrationMode =
      data.registrationMode === "open" ? "closed" : "open";
    const token = await confirmation(
      "admin.registration.update",
      "registration",
      { mode },
      `确认将开放注册切换为“${mode === "open" ? "开放" : "关闭"}”？`,
    );
    if (token === undefined) return;
    try {
      await API_CLIENT.updateRegistrationMode(mode, token);
      await revalidator.revalidate();
    } catch {
      setMessage("注册策略修改失败。");
    }
  };

  return (
    <>
      <PageHeader
        actions={
          <button
            className="button-secondary"
            onClick={() => void updateRegistration()}
            type="button"
          >
            开放注册：{data.registrationMode === "open" ? "已开启" : "已关闭"}
          </button>
        }
        description="管理账号、角色、状态和恢复操作。"
        title="用户治理"
      />
      <StepUpPanel apiClient={API_CLIENT} />
      {message === undefined ? null : (
        <p className="status-warning my-4" role="status">
          {message}
        </p>
      )}
      <section className="surface-card mt-4 p-4">
        <h2 className="font-semibold">创建用户</h2>
        <div className="mt-3 grid gap-2 sm:grid-cols-[10rem_1fr_auto]">
          <select
            className="input-field"
            onChange={(event) =>
              setIdentifierType(event.target.value as IdentifierType)
            }
            value={identifierType}
          >
            <option value="email">邮箱</option>
            <option value="phone">国际手机号</option>
          </select>
          <input
            className="input-field"
            onChange={(event) => setIdentifier(event.target.value)}
            placeholder={
              identifierType === "email" ? "user@example.com" : "+8613800000000"
            }
            value={identifier}
          />
          <button
            className="button-primary"
            disabled={pending || identifier.trim().length === 0}
            onClick={() => void createUser()}
            type="button"
          >
            {pending ? "创建中…" : "创建用户"}
          </button>
        </div>
      </section>
      <section className="surface-card mt-4 overflow-hidden">
        <ul className="divide-y divide-slate-200 dark:divide-slate-800">
          {data.users.map((user) => (
            <li className="p-4" key={user.id}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <strong>{user.displayIdentifier}</strong>
                  <p className="text-muted mt-1 text-xs">
                    {user.role} · {user.status} ·{" "}
                    {user.mustChangePassword ? "必须修改密码" : "密码有效"}
                  </p>
                </div>
                <span className="status-badge-neutral">
                  {user.identifierType}
                </span>
              </div>
              {user.status !== "deleted" && (
                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    className="button-secondary"
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
                    className="button-secondary"
                    onClick={() =>
                      void updateUser(user, {
                        role: user.role === "admin" ? "user" : "admin",
                      })
                    }
                    type="button"
                  >
                    设为 {user.role === "admin" ? "用户" : "管理员"}
                  </button>
                  <button
                    className="button-secondary"
                    onClick={() => void verifiedAction(user, "password")}
                    type="button"
                  >
                    重置密码
                  </button>
                  <button
                    className="button-secondary"
                    onClick={() => void verifiedAction(user, "authentication")}
                    type="button"
                  >
                    重置增强认证
                  </button>
                  <button
                    className="button-danger"
                    onClick={() => void verifiedAction(user, "delete")}
                    type="button"
                  >
                    删除用户
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}
