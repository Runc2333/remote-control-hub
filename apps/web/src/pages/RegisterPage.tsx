import type { RegistrationMode } from "@remote-control-hub/contracts";
import {
  Form,
  Link,
  Navigate,
  useActionData,
  useLoaderData,
  useNavigation,
  useRouteLoaderData,
} from "react-router";
import type { RegistrationActionData } from "../app/actions.js";
import type { BootstrapData } from "../app/bootstrap.js";
import { currentSession } from "../app/bootstrap.js";

export function RegisterPage() {
  const bootstrap = useRouteLoaderData("root") as BootstrapData;
  const registration = useLoaderData() as { mode: RegistrationMode };
  const action = useActionData() as RegistrationActionData | undefined;
  const navigation = useNavigation();
  const pending = navigation.state === "submitting";

  if (!bootstrap.setup.installed) {
    return <Navigate replace to="/setup" />;
  }
  if (currentSession(bootstrap) !== undefined) {
    return <Navigate replace to="/devices" />;
  }
  if (registration.mode === "closed") {
    return (
      <section className="surface-card p-5 text-center shadow-sm">
        <h1 className="text-lg font-semibold">自助注册已关闭</h1>
        <p className="text-muted mt-2 text-sm">请联系平台管理员创建账号。</p>
        <Link className="button-secondary mt-4 inline-flex" to="/login">
          返回登录
        </Link>
      </section>
    );
  }

  return (
    <section className="surface-card p-5 shadow-sm">
      <h1 className="text-lg font-semibold">注册账号</h1>
      <p className="text-muted mt-1 text-sm">注册能力由平台管理员控制。</p>
      {action?.kind === "succeeded" ? (
        <div className="status-success mt-4">
          <p>{action.message}</p>
          <Link className="button-primary mt-4 inline-flex" to="/login">
            前往登录
          </Link>
        </div>
      ) : (
        <Form className="mt-4 space-y-4" method="post">
          <label className="grid gap-1 text-sm font-medium">
            标识类型
            <select className="input-field" name="identifierType">
              <option value="email">邮箱</option>
              <option value="phone">国际手机号</option>
            </select>
          </label>
          <label className="grid gap-1 text-sm font-medium">
            邮箱或国际手机号
            <input
              className="input-field"
              name="identifier"
              required
              type="text"
            />
          </label>
          <label className="grid gap-1 text-sm font-medium">
            密码
            <input
              className="input-field"
              minLength={12}
              name="password"
              required
              type="password"
            />
            <span className="text-muted text-xs">至少 12 个字符。</span>
          </label>
          {action?.kind !== "failed" ? null : (
            <p className="status-error" role="alert">
              {action.message}
            </p>
          )}
          <button
            className="button-primary w-full"
            disabled={pending}
            type="submit"
          >
            {pending ? "正在注册…" : "创建账号"}
          </button>
          <p className="text-muted text-center text-sm">
            已有账号？{" "}
            <Link className="text-link" to="/login">
              返回登录
            </Link>
          </p>
        </Form>
      )}
    </section>
  );
}
