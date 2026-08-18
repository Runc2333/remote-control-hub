import { Navigate, useRevalidator, useRouteLoaderData } from "react-router";
import type { BootstrapData } from "../app/bootstrap.js";
import { PageHeader } from "../components/PageHeader.js";
import { SetupPanel } from "../components/SetupPanel.js";
import { API_CLIENT } from "../lib/api-client.js";

export function SetupPage() {
  const bootstrap = useRouteLoaderData("root") as BootstrapData;
  const revalidator = useRevalidator();
  if (bootstrap.setup.installed) {
    return <Navigate replace to="/" />;
  }
  return (
    <>
      <PageHeader
        description="依次完成数据服务检测和首个平台管理员创建。"
        title="首次安装"
      />
      <SetupPanel
        apiClient={API_CLIENT}
        deploymentMode={bootstrap.setup.deploymentMode}
        onComplete={() => void revalidator.revalidate()}
      />
    </>
  );
}
