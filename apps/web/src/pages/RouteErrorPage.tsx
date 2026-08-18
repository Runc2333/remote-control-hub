import { isRouteErrorResponse, Link, useRouteError } from "react-router";

export function RouteErrorPage() {
  const error = useRouteError();
  const notFound = isRouteErrorResponse(error) && error.status === 404;
  return (
    <main className="grid min-h-screen place-items-center px-4">
      <section className="surface-card max-w-md p-6 text-center shadow-sm">
        <p className="text-sm font-semibold text-teal-700 dark:text-teal-300">
          {notFound ? "404" : "暂时无法加载"}
        </p>
        <h1 className="mt-2 text-2xl font-semibold">
          {notFound ? "资源不存在" : "页面加载失败"}
        </h1>
        <p className="text-muted mt-2 text-sm">
          {notFound
            ? "请求的设备或记录可能已被删除。"
            : "请检查服务连接后重试；当前操作不会被自动重复提交。"}
        </p>
        <div className="mt-5 flex justify-center gap-2">
          <button
            className="button-primary"
            onClick={() => window.location.reload()}
            type="button"
          >
            重新加载
          </button>
          <Link className="button-secondary" to="/">
            返回首页
          </Link>
        </div>
      </section>
    </main>
  );
}
