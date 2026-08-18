import {
  isRouteErrorResponse,
  useRevalidator,
  useRouteError,
} from "react-router";

export function PageRouteError() {
  const error = useRouteError();
  const revalidator = useRevalidator();
  const missing = isRouteErrorResponse(error) && error.status === 404;
  return (
    <section className="surface-card p-6 text-center" role="alert">
      <h1 className="text-lg font-semibold">
        {missing ? "请求的内容不存在" : "当前页面暂时无法加载"}
      </h1>
      <p className="text-muted mt-2 text-sm">
        {missing
          ? "记录可能已被删除，或当前账号无权访问。"
          : "其他页面不受影响，请检查连接后重试。"}
      </p>
      <button
        className="button-primary mt-4"
        onClick={() => void revalidator.revalidate()}
        type="button"
      >
        重新加载本页
      </button>
    </section>
  );
}
