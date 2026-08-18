import {
  faFingerprint,
  faKey,
  faRightToBracket,
} from "@fortawesome/free-solid-svg-icons";
import { startAuthentication } from "@simplewebauthn/browser";
import type { ApiClient } from "@remote-control-hub/api-client";
import type { WebauthnAuthenticationResponse } from "@remote-control-hub/contracts";
import { Icon } from "@remote-control-hub/ui";
import { useState } from "react";

type LoginPanelProps = {
  apiClient: ApiClient;
  onLoggedIn: () => void;
};

const INPUT_CLASS = "input-field";

export function LoginPanel({ apiClient, onLoggedIn }: LoginPanelProps) {
  const [identifierType, setIdentifierType] = useState<"email" | "phone">(
    "email",
  );
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [secondFactorCode, setSecondFactorCode] = useState("");
  const [useRecoveryCode, setUseRecoveryCode] = useState(false);
  const [stage, setStage] = useState<
    "login" | "password-change" | "totp" | "submitting" | "failed"
  >("login");

  const login = async (): Promise<void> => {
    setStage("submitting");
    try {
      const response = await apiClient.login({
        identifier,
        identifierType,
        password,
      });
      if (response.requiresPasswordChange) {
        setStage("password-change");
      } else if (response.requiresTotp) {
        setStage("totp");
      } else {
        onLoggedIn();
      }
    } catch {
      setStage("failed");
    }
  };

  const completePasswordChange = async (): Promise<void> => {
    setStage("submitting");
    try {
      await apiClient.completeTemporaryPassword(newPassword);
      onLoggedIn();
    } catch {
      setStage("password-change");
    }
  };

  const completeSecondFactor = async (): Promise<void> => {
    setStage("submitting");
    try {
      await apiClient.completeSecondFactor(
        useRecoveryCode
          ? { recoveryCode: secondFactorCode, type: "recovery_code" }
          : { code: secondFactorCode, type: "totp" },
      );
      onLoggedIn();
    } catch {
      setStage("totp");
    }
  };

  const loginWithPasskey = async (): Promise<void> => {
    setStage("submitting");
    try {
      const { options } = await apiClient.beginPasskeyAuthentication();
      const response = await startAuthentication({
        optionsJSON: options as unknown as Parameters<
          typeof startAuthentication
        >[0]["optionsJSON"],
      });
      await apiClient.completePasskeyAuthentication(
        response as unknown as WebauthnAuthenticationResponse,
      );
      onLoggedIn();
    } catch {
      setStage("failed");
    }
  };

  return (
    <section className="surface-card mx-auto w-full max-w-md p-5 shadow-sm">
      <div className="flex items-center gap-3">
        <span className="grid size-10 place-items-center rounded-lg bg-teal-50 text-teal-700 dark:bg-teal-950 dark:text-teal-300">
          <Icon icon={faRightToBracket} label="登录" />
        </span>
        <div>
          <h2 className="font-semibold">登录控制中心</h2>
          <p className="text-muted text-sm">使用邮箱或国际手机号</p>
        </div>
      </div>
      {stage === "password-change" ? (
        <div className="mt-5 space-y-4">
          <p className="text-sm text-amber-700 dark:text-amber-300">
            临时密码已验证。设置正式密码后才会创建会话。
          </p>
          <label className="block text-sm font-medium">
            新密码
            <input
              autoComplete="new-password"
              className={INPUT_CLASS}
              onChange={(event) => setNewPassword(event.target.value)}
              type="password"
              value={newPassword}
            />
          </label>
          <button
            className="min-h-11 w-full rounded-lg bg-teal-700 px-4 font-medium text-white disabled:opacity-50"
            disabled={newPassword.length < 12}
            onClick={() => void completePasswordChange()}
            type="button"
          >
            设置密码并登录
          </button>
        </div>
      ) : stage === "totp" ? (
        <div className="mt-5 space-y-4">
          <p className="text-sm text-slate-600 dark:text-slate-300">
            输入身份验证器中的 6 位验证码，或使用一枚一次性恢复码。
          </p>
          <label className="block text-sm font-medium">
            {useRecoveryCode ? "恢复码" : "验证码"}
            <input
              autoComplete="one-time-code"
              className={INPUT_CLASS}
              inputMode={useRecoveryCode ? "text" : "numeric"}
              maxLength={useRecoveryCode ? 64 : 6}
              onChange={(event) => setSecondFactorCode(event.target.value)}
              value={secondFactorCode}
            />
          </label>
          <button
            className="min-h-11 w-full rounded-lg bg-teal-700 px-4 font-medium text-white disabled:opacity-50"
            disabled={
              useRecoveryCode
                ? secondFactorCode.length < 16
                : !/^\d{6}$/u.test(secondFactorCode)
            }
            onClick={() => void completeSecondFactor()}
            type="button"
          >
            完成登录
          </button>
          <button
            className="button-secondary w-full"
            onClick={() => {
              setSecondFactorCode("");
              setUseRecoveryCode((current) => !current);
            }}
            type="button"
          >
            {useRecoveryCode ? "改用身份验证器" : "改用恢复码"}
          </button>
        </div>
      ) : (
        <div className="mt-5 space-y-4">
          <div className="grid grid-cols-[8rem_1fr] gap-3">
            <label className="text-sm font-medium">
              类型
              <select
                className={INPUT_CLASS}
                onChange={(event) =>
                  setIdentifierType(
                    event.target.value === "phone" ? "phone" : "email",
                  )
                }
                value={identifierType}
              >
                <option value="email">邮箱</option>
                <option value="phone">手机号</option>
              </select>
            </label>
            <label className="text-sm font-medium">
              登录标识
              <input
                autoComplete="username"
                className={INPUT_CLASS}
                onChange={(event) => setIdentifier(event.target.value)}
                type={identifierType === "email" ? "email" : "tel"}
                value={identifier}
              />
            </label>
          </div>
          <label className="block text-sm font-medium">
            <span className="flex items-center gap-2">
              <Icon icon={faKey} />
              密码
            </span>
            <input
              autoComplete="current-password"
              className={INPUT_CLASS}
              onChange={(event) => setPassword(event.target.value)}
              type="password"
              value={password}
            />
          </label>
          <button
            className="min-h-11 w-full rounded-lg bg-teal-700 px-4 font-medium text-white disabled:opacity-50"
            disabled={
              identifier.length < 3 ||
              password.length === 0 ||
              stage === "submitting"
            }
            onClick={() => void login()}
            type="button"
          >
            {stage === "submitting" ? "正在验证…" : "登录"}
          </button>
          <button
            className="button-secondary w-full"
            disabled={stage === "submitting"}
            onClick={() => void loginWithPasskey()}
            type="button"
          >
            <Icon icon={faFingerprint} />
            使用 Passkey 登录
          </button>
          {stage === "failed" && (
            <p className="status-error" role="alert">
              登录失败，请检查登录标识和密码。
            </p>
          )}
        </div>
      )}
    </section>
  );
}
