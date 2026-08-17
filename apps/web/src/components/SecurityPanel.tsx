import {
  faCopy,
  faFingerprint,
  faKey,
  faPen,
  faRotate,
  faShieldHalved,
  faTrash,
} from "@fortawesome/free-solid-svg-icons";
import { startRegistration } from "@simplewebauthn/browser";
import type { ApiClient } from "@remote-control-hub/api-client";
import type {
  TotpEnrollmentBeginResponse,
  TotpStatusResponse,
  Passkey,
  WebauthnRegistrationResponse,
} from "@remote-control-hub/contracts";
import { Icon } from "@remote-control-hub/ui";
import { QRCodeSVG } from "qrcode.react";
import { useEffect, useState } from "react";
import { StepUpPanel } from "./StepUpPanel.js";

type SecurityPanelProps = {
  apiClient: ApiClient;
};

const INPUT_CLASS =
  "min-h-11 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm dark:border-slate-700 dark:bg-slate-950";

export function SecurityPanel({ apiClient }: SecurityPanelProps) {
  const [status, setStatus] = useState<TotpStatusResponse | undefined>();
  const [enrollment, setEnrollment] = useState<
    TotpEnrollmentBeginResponse | undefined
  >();
  const [code, setCode] = useState("");
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [passkeys, setPasskeys] = useState<Passkey[]>([]);
  const [passkeyName, setPasskeyName] = useState("此设备");

  useEffect(() => {
    let active = true;
    void Promise.all([apiClient.getTotpStatus(), apiClient.getPasskeys()])
      .then(([value, passkeyResponse]) => {
        if (active) {
          setStatus(value);
          setPasskeys(passkeyResponse.passkeys);
        }
      })
      .catch(() => {
        if (active) {
          setError("无法读取增强认证状态。");
        }
      });
    return () => {
      active = false;
    };
  }, [apiClient]);

  const beginEnrollment = async (): Promise<void> => {
    try {
      setEnrollment(await apiClient.beginTotpEnrollment());
      setRecoveryCodes(undefined);
      setError(undefined);
    } catch {
      setError("无法开始 TOTP 启用流程，请重新登录后再试。");
    }
  };

  const confirmEnrollment = async (): Promise<void> => {
    try {
      const result = await apiClient.confirmTotpEnrollment(code);
      setRecoveryCodes(result.recoveryCodes);
      setEnrollment(undefined);
      setCode("");
      setStatus({
        enabled: true,
        remainingRecoveryCodes: result.recoveryCodes.length,
      });
      setError(undefined);
    } catch {
      setError("验证码无效或启用请求已过期。");
    }
  };

  const registerPasskey = async (): Promise<void> => {
    try {
      const { options } = await apiClient.beginPasskeyRegistration();
      const response = await startRegistration({
        optionsJSON: options as unknown as Parameters<
          typeof startRegistration
        >[0]["optionsJSON"],
      });
      const passkey = await apiClient.completePasskeyRegistration(
        passkeyName,
        response as unknown as WebauthnRegistrationResponse,
      );
      setPasskeys((current) => [passkey, ...current]);
      setError(undefined);
    } catch {
      setError("Passkey 注册未完成，请重新登录后再试。");
    }
  };

  const deletePasskey = async (passkey: Passkey): Promise<void> => {
    if (
      !window.confirm(`确认删除 Passkey“${passkey.name}”？相关会话将失效。`)
    ) {
      return;
    }
    try {
      await apiClient.deletePasskey(passkey.id);
      setPasskeys((current) =>
        current.filter((candidate) => candidate.id !== passkey.id),
      );
      setError(undefined);
    } catch {
      setError("Passkey 删除失败，请重新登录后再试。");
    }
  };

  const renamePasskey = async (passkey: Passkey): Promise<void> => {
    const name = window.prompt("新的 Passkey 名称", passkey.name);
    if (name === null || name.trim().length === 0) {
      return;
    }
    try {
      const renamed = await apiClient.renamePasskey(passkey.id, name);
      setPasskeys((current) =>
        current.map((candidate) =>
          candidate.id === passkey.id ? renamed : candidate,
        ),
      );
      setError(undefined);
    } catch {
      setError("Passkey 重命名失败。");
    }
  };

  const regenerateRecoveryCodes = async (): Promise<void> => {
    if (!window.confirm("确认废止全部旧恢复码并生成一组新恢复码？")) {
      return;
    }
    try {
      const confirmation = await apiClient.issueActionConfirmation({
        action: "auth.totp.recovery_codes_regenerate",
        payload: {},
        targetId: "self",
      });
      const result = await apiClient.regenerateRecoveryCodes({
        confirmationToken: confirmation.token,
      });
      setRecoveryCodes(result.recoveryCodes);
      setStatus((current) =>
        current === undefined
          ? current
          : {
              ...current,
              remainingRecoveryCodes: result.recoveryCodes.length,
            },
      );
      setError(undefined);
    } catch {
      setError("需要先重新验证身份，然后再次生成恢复码。");
    }
  };

  const disableTotp = async (): Promise<void> => {
    if (!window.confirm("确认关闭 TOTP？全部恢复码和现有会话将立即失效。")) {
      return;
    }
    try {
      const confirmation = await apiClient.issueActionConfirmation({
        action: "auth.totp.disable",
        payload: {},
        targetId: "self",
      });
      await apiClient.disableTotp({ confirmationToken: confirmation.token });
      window.location.reload();
    } catch {
      setError("需要先重新验证身份，然后再次关闭 TOTP。");
    }
  };

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 font-semibold">
            <Icon icon={faShieldHalved} />
            增强认证
          </h2>
          <p className="mt-1 text-xs text-slate-500">
            TOTP 是推荐的可选保护，不启用也不会限制现有功能。
          </p>
        </div>
        <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium dark:bg-slate-800">
          {status?.enabled ? "TOTP 已启用" : "TOTP 未启用"}
        </span>
      </div>

      <div className="mt-4 rounded-lg border border-slate-200 p-3 dark:border-slate-800">
        <div className="flex flex-wrap items-end gap-2">
          <label className="min-w-48 flex-1 text-sm font-medium">
            新 Passkey 名称
            <input
              className={INPUT_CLASS}
              maxLength={128}
              onChange={(event) => setPasskeyName(event.target.value)}
              value={passkeyName}
            />
          </label>
          <button
            className="flex min-h-11 items-center gap-2 rounded-lg border border-slate-300 px-4 text-sm font-medium disabled:opacity-50 dark:border-slate-700"
            disabled={passkeyName.trim().length === 0}
            onClick={() => void registerPasskey()}
            type="button"
          >
            <Icon icon={faFingerprint} />
            注册 Passkey
          </button>
        </div>
        {passkeys.length === 0 ? (
          <p className="mt-3 text-xs text-slate-500">尚未注册 Passkey。</p>
        ) : (
          <ul className="mt-3 divide-y divide-slate-200 text-sm dark:divide-slate-800">
            {passkeys.map((passkey) => (
              <li
                className="flex items-center justify-between gap-3 py-2"
                key={passkey.id}
              >
                <span>{passkey.name}</span>
                <span className="flex items-center gap-2">
                  <span className="text-xs text-slate-500">
                    {passkey.deviceType === "multiDevice" ? "可同步" : "单设备"}
                    {passkey.backedUp ? " · 已备份" : ""}
                  </span>
                  <button
                    className="grid size-11 place-items-center rounded-lg border border-slate-300 dark:border-slate-700"
                    onClick={() => void renamePasskey(passkey)}
                    type="button"
                  >
                    <Icon icon={faPen} label={`重命名 ${passkey.name}`} />
                  </button>
                  <button
                    className="grid size-11 place-items-center rounded-lg border border-slate-300 text-red-700 dark:border-slate-700"
                    onClick={() => void deletePasskey(passkey)}
                    type="button"
                  >
                    <Icon icon={faTrash} label={`删除 ${passkey.name}`} />
                  </button>
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {status?.enabled && recoveryCodes === undefined && (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm text-slate-600 dark:text-slate-300">
            剩余一次性恢复码：{status.remainingRecoveryCodes} 枚
          </p>
          <span className="flex flex-wrap gap-2">
            <button
              className="flex min-h-11 items-center gap-2 rounded-lg border border-slate-300 px-3 text-sm font-medium dark:border-slate-700"
              onClick={() => void regenerateRecoveryCodes()}
              type="button"
            >
              <Icon icon={faRotate} />
              重新生成恢复码
            </button>
            <button
              className="min-h-11 rounded-lg border border-red-300 px-3 text-sm font-medium text-red-700 dark:border-red-900"
              onClick={() => void disableTotp()}
              type="button"
            >
              关闭 TOTP
            </button>
          </span>
        </div>
      )}

      {status !== undefined &&
        !status.enabled &&
        enrollment === undefined &&
        recoveryCodes === undefined && (
          <button
            className="mt-4 flex min-h-11 items-center gap-2 rounded-lg bg-teal-700 px-4 font-medium text-white"
            onClick={() => void beginEnrollment()}
            type="button"
          >
            <Icon icon={faKey} />
            启用 TOTP
          </button>
        )}

      {enrollment !== undefined && (
        <div className="mt-4 grid gap-4 sm:grid-cols-[auto_1fr]">
          <div className="w-fit rounded-lg border border-slate-200 bg-white p-2">
            <QRCodeSVG
              level="M"
              marginSize={4}
              size={184}
              title="TOTP 身份验证器二维码"
              value={enrollment.otpauthUri}
            />
          </div>
          <div className="space-y-3">
            <p className="text-sm text-slate-600 dark:text-slate-300">
              用身份验证器扫描二维码，然后输入当前 6
              位验证码。密钥只在本次流程显示。
            </p>
            <code className="block overflow-x-auto rounded bg-slate-100 px-3 py-2 text-xs dark:bg-slate-950">
              {enrollment.secret}
            </code>
            <label className="block text-sm font-medium">
              验证码
              <input
                autoComplete="one-time-code"
                className={INPUT_CLASS}
                inputMode="numeric"
                maxLength={6}
                onChange={(event) => setCode(event.target.value)}
                value={code}
              />
            </label>
            <button
              className="min-h-11 rounded-lg bg-teal-700 px-4 font-medium text-white disabled:opacity-50"
              disabled={!/^\d{6}$/u.test(code)}
              onClick={() => void confirmEnrollment()}
              type="button"
            >
              验证并启用
            </button>
          </div>
        </div>
      )}

      {recoveryCodes !== undefined && (
        <div className="mt-4 rounded-lg border border-amber-300 bg-amber-50 p-4 text-amber-950 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100">
          <h3 className="font-semibold">立即保存恢复码</h3>
          <p className="mt-1 text-sm">
            每枚只能使用一次，离开此处后不会再次完整显示。
          </p>
          <ul className="mt-3 grid grid-cols-2 gap-2 font-mono text-xs sm:grid-cols-3">
            {recoveryCodes.map((recoveryCode) => (
              <li
                className="rounded bg-white/70 px-2 py-1 dark:bg-black/20"
                key={recoveryCode}
              >
                {recoveryCode}
              </li>
            ))}
          </ul>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              className="flex min-h-11 items-center gap-2 rounded-lg border border-amber-400 px-3 text-sm font-medium dark:border-amber-700"
              onClick={() =>
                void navigator.clipboard.writeText(recoveryCodes.join("\n"))
              }
              type="button"
            >
              <Icon icon={faCopy} />
              复制恢复码
            </button>
            <button
              className="min-h-11 rounded-lg bg-amber-900 px-3 text-sm font-medium text-white"
              onClick={() => setRecoveryCodes(undefined)}
              type="button"
            >
              我已安全保存
            </button>
          </div>
        </div>
      )}

      {error !== undefined && (
        <p
          className="mt-3 rounded-lg bg-red-50 p-3 text-sm text-red-800"
          role="alert"
        >
          {error}
        </p>
      )}
      <div className="mt-4">
        <StepUpPanel apiClient={apiClient} />
      </div>
    </section>
  );
}
