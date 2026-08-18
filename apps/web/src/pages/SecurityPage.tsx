import { Link } from "react-router";
import { PageHeader } from "../components/PageHeader.js";
import { SecurityPanel } from "../components/SecurityPanel.js";
import { API_CLIENT } from "../lib/api-client.js";

export function SecurityPage() {
  return (
    <>
      <PageHeader
        actions={
          <Link className="button-secondary" to="/settings">
            返回设置
          </Link>
        }
        description="增强认证能力是推荐选项，不启用也不会降低账号现有授权。"
        title="账号安全"
      />
      <SecurityPanel apiClient={API_CLIENT} />
    </>
  );
}
