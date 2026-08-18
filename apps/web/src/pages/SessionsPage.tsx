import type { SessionListResponse } from "@remote-control-hub/contracts";
import { useState } from "react";
import { useLoaderData, useRevalidator } from "react-router";
import { PageHeader } from "../components/PageHeader.js";
import { API_CLIENT } from "../lib/api-client.js";
import { formatDateTime } from "../lib/date-time.js";

export function SessionsPage() {
  const { sessions } = useLoaderData() as SessionListResponse;
  const [pending, setPending] = useState<string>();
  const [message, setMessage] = useState<string>();
  const revalidator = useRevalidator();

  const revoke = async (sessionId: string): Promise<void> => {
    setPending(sessionId);
    try {
      await API_CLIENT.revokeSession(sessionId);
      await revalidator.revalidate();
    } catch {
      setMessage("会话撤销失败，请刷新后重试。");
    } finally {
      setPending(undefined);
    }
  };

  const revokeOthers = async (): Promise<void> => {
    setPending("others");
    try {
      const result = await API_CLIENT.revokeOtherSessions();
      setMessage(`已撤销 ${result.revokedCount} 个其他会话。`);
      await revalidator.revalidate();
    } catch {
      setMessage("其他会话撤销失败，请稍后重试。");
    } finally {
      setPending(undefined);
    }
  };

  return (
    <>
      <PageHeader
        actions={
          <button
            className="button-secondary"
            disabled={pending !== undefined}
            onClick={() => void revokeOthers()}
            type="button"
          >
            退出其他会话
          </button>
        }
        description="IP、位置和设备信息均为推测结果，不参与认证或授权。"
        title="活跃会话"
      />
      {message === undefined ? null : (
        <p className="status-info mb-4" role="status">
          {message}
        </p>
      )}
      <div className="space-y-3">
        {sessions.map((session) => (
          <article
            className="surface-card grid gap-3 p-4 sm:grid-cols-[1fr_auto] sm:items-center"
            key={session.id}
          >
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="font-semibold">
                  {session.browser} · {session.operatingSystem}
                </h2>
                {session.current ? (
                  <span className="status-badge-success">当前会话</span>
                ) : null}
              </div>
              <p className="text-muted mt-1 text-sm">
                {session.deviceType} · {session.authStrength} ·{" "}
                {session.ipAddress} · {session.location}
              </p>
              <p className="text-muted mt-1 text-xs">
                创建于 {formatDateTime(session.createdAt)} · 最近活动{" "}
                {formatDateTime(session.lastActiveAt)} · 到期{" "}
                {formatDateTime(session.expiresAt)}
              </p>
            </div>
            <button
              className={session.current ? "button-secondary" : "button-danger"}
              disabled={pending !== undefined}
              onClick={() => void revoke(session.id)}
              type="button"
            >
              {pending === session.id
                ? "正在撤销…"
                : session.current
                  ? "退出当前会话"
                  : "撤销会话"}
            </button>
          </article>
        ))}
      </div>
    </>
  );
}
