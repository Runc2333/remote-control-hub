import {
  faLink,
  faRotate,
  faShieldHalved,
  faUnlink,
} from "@fortawesome/free-solid-svg-icons";
import { Icon } from "@remote-control-hub/ui";
import { useState } from "react";
import type { AgentMutation, AgentStatus } from "../types.js";

type ConnectionPanelProps = {
  error?: string | undefined;
  mutation?: AgentMutation | undefined;
  onRefresh: () => Promise<void>;
  onRegister: (
    serviceOrigin: string,
    enrollmentToken: string,
  ) => Promise<boolean>;
  onUnregister: () => Promise<void>;
  status?: AgentStatus | undefined;
  statusError: boolean;
};

const normalizeOrigin = (value: string): string | undefined => {
  try {
    const url = new URL(value.trim());
    if (
      url.protocol !== "https:" ||
      url.username !== "" ||
      url.password !== "" ||
      url.pathname !== "/" ||
      url.search !== "" ||
      url.hash !== ""
    ) {
      return undefined;
    }
    return url.origin;
  } catch {
    return undefined;
  }
};

export const ConnectionPanel = ({
  error,
  mutation,
  onRefresh,
  onRegister,
  onUnregister,
  status,
  statusError,
}: ConnectionPanelProps) => {
  const [origin, setOrigin] = useState("");
  const [enrollmentCode, setEnrollmentCode] = useState("");
  const normalizedOrigin = normalizeOrigin(origin);
  const canSubmit =
    normalizedOrigin !== undefined &&
    enrollmentCode.trim().length >= 8 &&
    mutation === undefined;

  const register = async (): Promise<void> => {
    if (!canSubmit || normalizedOrigin === undefined) {
      return;
    }
    if (!window.confirm(`确认将此设备绑定到 ${normalizedOrigin}？`)) {
      return;
    }
    if (await onRegister(normalizedOrigin, enrollmentCode.trim())) {
      setEnrollmentCode("");
    }
  };

  const unregister = async (): Promise<void> => {
    if (
      !window.confirm(
        "确认解绑此设备？本机保存的设备身份将被清除，远程连接会立即断开。",
      )
    ) {
      return;
    }
    await onUnregister();
  };

  if (status === undefined) {
    return (
      <section className="panel-card text-center">
        <span className="mx-auto grid size-12 place-items-center rounded-full bg-amber-50 text-amber-700">
          <Icon icon={faRotate} />
        </span>
        <h2 className="mt-3 font-semibold">
          {statusError ? "无法连接本机 Agent 服务" : "正在读取设备状态"}
        </h2>
        <p className="mt-1 text-sm text-slate-500">
          {statusError
            ? "请确认 Remote Control Hub Agent 服务正在运行。"
            : "这通常只需要几秒钟。"}
        </p>
        {statusError ? (
          <button
            className="control-button mx-auto mt-4"
            onClick={() => void onRefresh()}
            type="button"
          >
            <Icon icon={faRotate} />
            重试
          </button>
        ) : null}
      </section>
    );
  }

  return (
    <section className="panel-card">
      <div>
        <p className="section-eyebrow">
          {status.connected
            ? "已连接"
            : status.registered
              ? "等待连接"
              : "开始使用"}
        </p>
        <h2 className="mt-1 text-xl font-semibold">
          {status.registered ? "设备连接" : "绑定到控制中心"}
        </h2>
        <p className="mt-1 text-sm text-slate-500">
          {status.registered
            ? "此设备已保存安全身份，可接收所属控制中心发出的命令。"
            : "输入控制中心地址和一次性设备注册码。"}
        </p>
      </div>

      {status.registered ? (
        <div className="mt-5 space-y-4">
          <dl className="detail-grid">
            <div className="detail-item">
              <dt>服务地址</dt>
              <dd>{status.serviceOrigin ?? "未知"}</dd>
            </div>
            <div className="detail-item">
              <dt>设备 ID</dt>
              <dd className="font-mono text-xs">{status.deviceId ?? "未知"}</dd>
            </div>
          </dl>
          <div className="danger-zone">
            <div>
              <h3 className="font-medium text-red-900">解除本机绑定</h3>
              <p className="mt-1 text-sm text-red-700">
                清除本机设备身份并断开连接，之后可重新绑定其他控制中心。
              </p>
            </div>
            <button
              className="danger-button"
              disabled={mutation !== undefined}
              onClick={() => void unregister()}
              type="button"
            >
              <Icon icon={faUnlink} />
              {mutation === "unregister" ? "正在解绑…" : "解绑设备"}
            </button>
          </div>
        </div>
      ) : (
        <form
          className="mt-5 space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            void register();
          }}
        >
          <label className="field-label" htmlFor="service-origin">
            服务地址
            <input
              autoComplete="url"
              className="input-field"
              id="service-origin"
              onChange={(event) => setOrigin(event.currentTarget.value)}
              placeholder="https://hub.example.com"
              spellCheck={false}
              type="url"
              value={origin}
            />
          </label>
          <label className="field-label" htmlFor="enrollment-code">
            设备注册码
            <input
              autoComplete="one-time-code"
              className="input-field font-mono"
              id="enrollment-code"
              onChange={(event) => setEnrollmentCode(event.currentTarget.value)}
              placeholder="输入 WebUI 生成的短期注册码"
              type="text"
              value={enrollmentCode}
            />
          </label>
          <div className="security-note">
            <Icon icon={faShieldHalved} />
            <span>
              设备私钥只保存在本机系统服务中，绑定前会再次确认服务地址。
            </span>
          </div>
          <button
            className="primary-button"
            disabled={!canSubmit}
            type="submit"
          >
            <Icon icon={faLink} />
            {mutation === "register" ? "正在绑定…" : "检查并绑定"}
          </button>
        </form>
      )}

      {error === undefined ? null : (
        <p className="mt-4 text-sm text-red-700" role="alert">
          操作失败：{error}
        </p>
      )}
    </section>
  );
};
