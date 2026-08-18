import { faFingerprint, faKey } from "@fortawesome/free-solid-svg-icons";
import { startAuthentication } from "@simplewebauthn/browser";
import type { ApiClient } from "@remote-control-hub/api-client";
import type { WebauthnAuthenticationResponse } from "@remote-control-hub/contracts";
import { Icon } from "@remote-control-hub/ui";
import { useState } from "react";

type StepUpPanelProps = {
  apiClient: ApiClient;
  onComplete?: () => void;
};

const INPUT_CLASS = "input-field";

export function StepUpPanel({ apiClient, onComplete }: StepUpPanelProps) {
  const [password, setPassword] = useState("");
  const [totpCode, setTotpCode] = useState("");
  const [message, setMessage] = useState<string | undefined>();

  const completePassword = async (): Promise<void> => {
    try {
      await apiClient.stepUpPassword({
        password,
        ...(totpCode.length === 0 ? {} : { totpCode }),
      });
      setPassword("");
      setTotpCode("");
      setMessage("身份已重新验证，有效期为 10 分钟。");
      onComplete?.();
    } catch {
      setMessage("验证失败。若账号启用了 TOTP，请同时填写当前验证码。");
    }
  };

  const completePasskey = async (): Promise<void> => {
    try {
      const { options } = await apiClient.beginPasskeyStepUp();
      const response = await startAuthentication({
        optionsJSON: options as unknown as Parameters<
          typeof startAuthentication
        >[0]["optionsJSON"],
      });
      await apiClient.completePasskeyStepUp(
        response as unknown as WebauthnAuthenticationResponse,
      );
      setMessage("身份已通过 Passkey 重新验证，有效期为 10 分钟。");
      onComplete?.();
    } catch {
      setMessage("Passkey 验证未完成。");
    }
  };

  return (
    <section className="status-warning">
      <h2 className="flex items-center gap-2 font-semibold">
        <Icon icon={faKey} />
        重新验证身份
      </h2>
      <p className="mt-1 text-xs text-slate-600 dark:text-slate-300">
        高风险操作要求最近 10 分钟内完成密码验证；已启用 TOTP
        时还需验证码。也可以使用 Passkey。
      </p>
      <div className="mt-3 grid gap-2 sm:grid-cols-[1fr_10rem_auto]">
        <label className="text-sm font-medium">
          当前密码
          <input
            autoComplete="current-password"
            className={INPUT_CLASS}
            onChange={(event) => setPassword(event.target.value)}
            type="password"
            value={password}
          />
        </label>
        <label className="text-sm font-medium">
          TOTP（如已启用）
          <input
            autoComplete="one-time-code"
            className={INPUT_CLASS}
            inputMode="numeric"
            maxLength={6}
            onChange={(event) => setTotpCode(event.target.value)}
            value={totpCode}
          />
        </label>
        <button
          className="min-h-11 self-end rounded-lg bg-amber-900 px-4 text-sm font-medium text-white disabled:opacity-50"
          disabled={password.length === 0}
          onClick={() => void completePassword()}
          type="button"
        >
          验证
        </button>
      </div>
      <button
        className="mt-2 flex min-h-11 items-center gap-2 rounded-lg border border-amber-400 px-4 text-sm font-medium dark:border-amber-800"
        onClick={() => void completePasskey()}
        type="button"
      >
        <Icon icon={faFingerprint} />
        使用 Passkey 验证
      </button>
      {message !== undefined && (
        <p className="mt-2 text-sm" role="status">
          {message}
        </p>
      )}
    </section>
  );
}
