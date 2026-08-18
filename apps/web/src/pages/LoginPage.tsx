import type { RegistrationMode } from "@remote-control-hub/contracts";
import {
  Link,
  Navigate,
  useLoaderData,
  useRevalidator,
  useRouteLoaderData,
} from "react-router";
import type { BootstrapData } from "../app/bootstrap.js";
import { currentSession } from "../app/bootstrap.js";
import { LoginPanel } from "../components/LoginPanel.js";
import { API_CLIENT } from "../lib/api-client.js";

export function LoginPage() {
  const bootstrap = useRouteLoaderData("root") as BootstrapData;
  const registration = useLoaderData() as { mode: RegistrationMode };
  const revalidator = useRevalidator();
  if (!bootstrap.setup.installed) {
    return <Navigate replace to="/setup" />;
  }
  if (currentSession(bootstrap) !== undefined) {
    return <Navigate replace to="/devices" />;
  }
  return (
    <>
      <LoginPanel
        apiClient={API_CLIENT}
        onLoggedIn={() => void revalidator.revalidate()}
      />
      <p className="text-muted text-center text-sm">
        {registration.mode === "open" ? (
          <>
            尚无账号？{" "}
            <Link className="text-link" to="/register">
              申请注册
            </Link>
          </>
        ) : (
          "平台当前未开放自助注册，请联系管理员。"
        )}
      </p>
    </>
  );
}
