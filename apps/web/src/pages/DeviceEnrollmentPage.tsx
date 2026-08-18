import { faCopy, faKey } from "@fortawesome/free-solid-svg-icons";
import type { CreateEnrollmentTokenResponse } from "@remote-control-hub/contracts";
import { Icon } from "@remote-control-hub/ui";
import { useState } from "react";
import { Link } from "react-router";
import { PageHeader } from "../components/PageHeader.js";
import { API_CLIENT } from "../lib/api-client.js";
import { formatDateTime } from "../lib/date-time.js";

export function DeviceEnrollmentPage() {
  const [enrollment, setEnrollment] = useState<CreateEnrollmentTokenResponse>();
  const [failed, setFailed] = useState(false);
  const [pending, setPending] = useState(false);

  const createEnrollment = async (): Promise<void> => {
    setFailed(false);
    setPending(true);
    try {
      setEnrollment(await API_CLIENT.createEnrollmentToken());
    } catch {
      setFailed(true);
    } finally {
      setPending(false);
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
        description="注册码短时有效、仅可使用一次，并绑定当前账号。"
        title="注册新设备"
      />
      <section className="surface-card p-5">
        <div className="flex items-center gap-3">
          <span className="grid size-10 place-items-center rounded-lg bg-teal-100 text-teal-800 dark:bg-teal-950 dark:text-teal-200">
            <Icon icon={faKey} />
          </span>
          <h2 className="font-semibold">一次性设备注册码</h2>
        </div>
        {failed ? (
          <p className="status-error mt-4" role="alert">
            无法创建注册码，请稍后重试。
          </p>
        ) : null}
        {enrollment === undefined ? (
          <div className="mt-4">
            <p className="text-muted text-sm">
              仅在准备立即注册 Agent 时生成，避免产生未使用的有效令牌。
            </p>
            <button
              className="button-primary mt-4"
              disabled={pending}
              onClick={() => void createEnrollment()}
              type="button"
            >
              {pending ? "正在安全生成…" : "生成一次性注册码"}
            </button>
          </div>
        ) : (
          <div className="mt-4">
            <div className="flex items-center gap-2">
              <code className="surface-muted min-w-0 flex-1 overflow-x-auto px-3 py-3 text-sm">
                {enrollment.token}
              </code>
              <button
                className="button-icon"
                onClick={() =>
                  void navigator.clipboard.writeText(enrollment.token)
                }
                type="button"
              >
                <Icon icon={faCopy} label="复制注册码" />
              </button>
            </div>
            <p className="text-muted mt-2 text-xs">
              有效期至 {formatDateTime(enrollment.expiresAt)}，使用后立即失效。
            </p>
            <button
              className="button-secondary mt-4"
              disabled={pending}
              onClick={() => void createEnrollment()}
              type="button"
            >
              {pending ? "正在重新生成…" : "重新生成"}
            </button>
          </div>
        )}
      </section>
    </>
  );
}
