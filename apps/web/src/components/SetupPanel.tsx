import { faDatabase, faKey, faServer } from "@fortawesome/free-solid-svg-icons";
import type { ApiClient } from "@remote-control-hub/api-client";
import type {
  DeploymentMode,
  MysqlConnection,
  RedisConnection,
} from "@remote-control-hub/contracts";
import { Icon } from "@remote-control-hub/ui";
import { useState } from "react";
import { getAdministratorValidationError } from "../setup/administrator-validation.js";

type TestState = "idle" | "testing" | "success" | "failed";

type SetupPanelProps = {
  apiClient: ApiClient;
  deploymentMode: DeploymentMode;
  onComplete: () => void;
};

const INPUT_CLASS = "input-field";

export function SetupPanel({
  apiClient,
  deploymentMode,
  onComplete,
}: SetupPanelProps) {
  const [setupSecret, setSetupSecret] = useState("");
  const [mysql, setMysql] = useState<MysqlConnection>({
    database: "",
    host: "",
    password: "",
    port: 3306,
    tls: true,
    username: "",
  });
  const [redis, setRedis] = useState<RedisConnection>({
    database: 0,
    host: "",
    password: "",
    port: 6379,
    tls: true,
  });
  const [mysqlState, setMysqlState] = useState<TestState>("idle");
  const [redisState, setRedisState] = useState<TestState>("idle");
  const [administratorIdentifier, setAdministratorIdentifier] = useState("");
  const [administratorIdentifierType, setAdministratorIdentifierType] =
    useState<"email" | "phone">("email");
  const [administratorPassword, setAdministratorPassword] = useState("");
  const [passwordConfirmation, setPasswordConfirmation] = useState("");
  const [completionState, setCompletionState] = useState<TestState>("idle");
  const [completionError, setCompletionError] = useState<string>();

  const testMysql = async (): Promise<void> => {
    setMysqlState("testing");
    try {
      const result = await apiClient.testDataService({
        ...(deploymentMode === "standalone" ? { connection: mysql } : {}),
        service: "mysql",
        setupSecret,
      });
      setMysqlState(result.ok ? "success" : "failed");
    } catch {
      setMysqlState("failed");
    }
  };

  const testRedis = async (): Promise<void> => {
    setRedisState("testing");
    try {
      const result = await apiClient.testDataService({
        ...(deploymentMode === "standalone" ? { connection: redis } : {}),
        service: "redis",
        setupSecret,
      });
      setRedisState(result.ok ? "success" : "failed");
    } catch {
      setRedisState("failed");
    }
  };

  const completeSetup = async (): Promise<void> => {
    const validationError = getAdministratorValidationError(
      administratorIdentifier,
      administratorPassword,
      passwordConfirmation,
    );
    if (validationError !== undefined) {
      setCompletionError(validationError);
      setCompletionState("failed");
      return;
    }
    setCompletionError(undefined);
    setCompletionState("testing");
    try {
      const result = await apiClient.completeSetup({
        administrator: {
          identifier: administratorIdentifier.trim(),
          identifierType: administratorIdentifierType,
          password: administratorPassword,
        },
        ...(deploymentMode === "standalone"
          ? { connections: { mysql, redis } }
          : {}),
        idempotencyKey: crypto.randomUUID(),
        setupSecret,
      });
      setCompletionState(result.installed ? "success" : "failed");
      if (result.installed) {
        onComplete();
      } else {
        setCompletionError("安装未完成，请检查连接与管理员信息后重试。");
      }
    } catch {
      setCompletionState("failed");
      setCompletionError("安装未完成，请检查连接与管理员信息后重试。");
    }
  };

  return (
    <section className="surface-card p-4 shadow-sm">
      <div className="flex items-center gap-3">
        <Icon icon={faServer} label="数据服务" />
        <div>
          <h2 className="font-semibold">数据服务检测</h2>
          <p className="text-muted text-sm">
            {deploymentMode === "compose"
              ? "使用 Compose 内部 MySQL 与 Redis，目标不可由浏览器修改。"
              : "分别验证 MySQL 与 Redis，两项成功后才能继续安装。"}
          </p>
        </div>
      </div>
      <label className="mt-4 block text-sm font-medium">
        <span className="mb-1 flex items-center gap-2">
          <Icon icon={faKey} />
          一次性引导秘密
        </span>
        <input
          autoComplete="off"
          className={INPUT_CLASS}
          onChange={(event) => {
            setSetupSecret(event.target.value);
            setMysqlState("idle");
            setRedisState("idle");
          }}
          type="password"
          value={setupSecret}
        />
      </label>
      {deploymentMode === "standalone" && (
        <div className="mt-4 grid gap-4 lg:grid-cols-2">
          <fieldset className="grid gap-3 rounded-lg border border-slate-200 p-3 dark:border-slate-700">
            <legend className="px-1 text-sm font-semibold">MySQL</legend>
            {(["host", "database", "username", "password"] as const).map(
              (field) => (
                <label className="text-xs font-medium" key={field}>
                  {field}
                  <input
                    className={INPUT_CLASS}
                    onChange={(event) => {
                      setMysql({ ...mysql, [field]: event.target.value });
                      setMysqlState("idle");
                    }}
                    type={field === "password" ? "password" : "text"}
                    value={mysql[field]}
                  />
                </label>
              ),
            )}
          </fieldset>
          <fieldset className="grid gap-3 rounded-lg border border-slate-200 p-3 dark:border-slate-700">
            <legend className="px-1 text-sm font-semibold">Redis</legend>
            {(["host", "username", "password"] as const).map((field) => (
              <label className="text-xs font-medium" key={field}>
                {field}
                <input
                  className={INPUT_CLASS}
                  onChange={(event) => {
                    setRedis({ ...redis, [field]: event.target.value });
                    setRedisState("idle");
                  }}
                  type={field === "password" ? "password" : "text"}
                  value={redis[field] ?? ""}
                />
              </label>
            ))}
          </fieldset>
        </div>
      )}
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <button
          className="button-secondary"
          disabled={setupSecret.length < 16 || mysqlState === "testing"}
          onClick={() => void testMysql()}
          type="button"
        >
          <Icon icon={faDatabase} />
          MySQL：{mysqlState}
        </button>
        <button
          className="button-secondary"
          disabled={setupSecret.length < 16 || redisState === "testing"}
          onClick={() => void testRedis()}
          type="button"
        >
          <Icon icon={faDatabase} />
          Redis：{redisState}
        </button>
      </div>
      {mysqlState === "success" && redisState === "success" && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void completeSetup();
          }}
        >
          <fieldset
            className="mt-5 grid gap-3 rounded-lg border border-slate-200 p-3 dark:border-slate-700"
            disabled={completionState === "testing"}
          >
            <legend className="px-1 text-sm font-semibold">
              首个平台管理员
            </legend>
            <div className="grid gap-3 sm:grid-cols-[9rem_1fr]">
              <label className="text-xs font-medium">
                标识类型
                <select
                  className={INPUT_CLASS}
                  onChange={(event) =>
                    setAdministratorIdentifierType(
                      event.target.value === "phone" ? "phone" : "email",
                    )
                  }
                  value={administratorIdentifierType}
                >
                  <option value="email">邮箱</option>
                  <option value="phone">国际手机号</option>
                </select>
              </label>
              <label className="text-xs font-medium">
                登录标识
                <input
                  className={INPUT_CLASS}
                  minLength={3}
                  onChange={(event) => {
                    setAdministratorIdentifier(event.target.value);
                    setCompletionError(undefined);
                    setCompletionState("idle");
                  }}
                  required
                  type={
                    administratorIdentifierType === "email" ? "email" : "tel"
                  }
                  value={administratorIdentifier}
                />
              </label>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="text-xs font-medium">
                正式密码
                <input
                  aria-describedby="administrator-password-requirements"
                  autoComplete="new-password"
                  className={INPUT_CLASS}
                  minLength={12}
                  onChange={(event) => {
                    setAdministratorPassword(event.target.value);
                    setCompletionError(undefined);
                    setCompletionState("idle");
                  }}
                  required
                  type="password"
                  value={administratorPassword}
                />
              </label>
              <label className="text-xs font-medium">
                确认密码
                <input
                  aria-describedby="administrator-password-requirements"
                  autoComplete="new-password"
                  className={INPUT_CLASS}
                  minLength={12}
                  onChange={(event) => {
                    setPasswordConfirmation(event.target.value);
                    setCompletionError(undefined);
                    setCompletionState("idle");
                  }}
                  required
                  type="password"
                  value={passwordConfirmation}
                />
              </label>
            </div>
            <p
              className="text-muted text-xs"
              id="administrator-password-requirements"
            >
              密码至少 12 个字符，并且两次输入必须完全一致。
            </p>
            <button
              className="min-h-11 rounded-lg bg-teal-700 px-4 font-medium text-white disabled:opacity-50"
              disabled={completionState === "testing"}
              type="submit"
            >
              {completionState === "testing" ? "正在完成安装…" : "完成安装"}
            </button>
            {completionState === "failed" && completionError !== undefined && (
              <p className="status-error" role="alert">
                {completionError}
              </p>
            )}
          </fieldset>
        </form>
      )}
    </section>
  );
}
