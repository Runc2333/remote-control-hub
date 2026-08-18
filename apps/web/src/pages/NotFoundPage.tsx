import { Link } from "react-router";

export function NotFoundPage() {
  return (
    <main className="grid min-h-screen place-items-center px-4">
      <section className="surface-card max-w-md p-6 text-center shadow-sm">
        <p className="text-sm font-semibold text-teal-700 dark:text-teal-300">
          404
        </p>
        <h1 className="mt-2 text-2xl font-semibold">页面不存在</h1>
        <p className="text-muted mt-2 text-sm">
          该地址可能已失效，或当前账号无权访问。
        </p>
        <Link className="button-primary mt-5 inline-flex" to="/">
          返回控制中心
        </Link>
      </section>
    </main>
  );
}
