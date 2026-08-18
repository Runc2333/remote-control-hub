import {
  faArrowRightFromBracket,
  faBolt,
  faClockRotateLeft,
  faComputer,
  faGauge,
  faGear,
  faSatelliteDish,
  faShieldHalved,
  faUserGroup,
} from "@fortawesome/free-solid-svg-icons";
import { Icon } from "@remote-control-hub/ui";
import {
  Link,
  NavLink,
  Navigate,
  Outlet,
  useNavigation,
  useRevalidator,
  useRouteLoaderData,
} from "react-router";
import type { BootstrapData } from "../app/bootstrap.js";
import { currentSession } from "../app/bootstrap.js";
import { API_CLIENT } from "../lib/api-client.js";

type NavigationItem = {
  end?: boolean;
  icon: Parameters<typeof Icon>[0]["icon"];
  label: string;
  to: string;
};

const PRIMARY_NAVIGATION: readonly NavigationItem[] = [
  { icon: faComputer, label: "设备", to: "/devices" },
  { icon: faBolt, label: "命令", to: "/commands" },
  { icon: faClockRotateLeft, label: "审计", to: "/audit" },
  { icon: faGear, label: "设置", to: "/settings" },
];

const ADMIN_NAVIGATION: readonly NavigationItem[] = [
  { end: true, icon: faGauge, label: "系统概览", to: "/admin" },
  { icon: faUserGroup, label: "用户治理", to: "/admin/users" },
  { icon: faComputer, label: "设备治理", to: "/admin/devices" },
  { icon: faShieldHalved, label: "系统审计", to: "/admin/audit" },
];

const navClass = ({ isActive }: { isActive: boolean }): string =>
  `flex min-h-11 items-center gap-3 rounded-lg px-3 text-sm font-medium transition-colors ${
    isActive
      ? "bg-teal-100 text-teal-900 dark:bg-teal-950 dark:text-teal-100"
      : "text-muted hover:bg-slate-100 hover:text-slate-950 dark:hover:bg-slate-800 dark:hover:text-white"
  }`;

export function AppLayout() {
  const bootstrap = useRouteLoaderData("root") as BootstrapData;
  const session = currentSession(bootstrap);
  const navigation = useNavigation();
  const revalidator = useRevalidator();

  if (!bootstrap.setup.installed) {
    return <Navigate replace to="/setup" />;
  }
  if (session === undefined) {
    return <Navigate replace to="/login" />;
  }

  const logout = async (): Promise<void> => {
    await API_CLIENT.logout().catch(() => undefined);
    await revalidator.revalidate();
  };

  return (
    <div className="min-h-screen pb-[max(5rem,env(safe-area-inset-bottom))] md:pb-0">
      {navigation.state === "idle" ? null : (
        <div
          aria-label="正在加载页面"
          className="fixed inset-x-0 top-0 z-50 h-1 animate-pulse bg-teal-500"
          role="progressbar"
        />
      )}
      <header className="surface-header sticky top-0 z-30 border-b px-4 py-3 backdrop-blur">
        <div className="mx-auto flex max-w-7xl items-center justify-between">
          <Link className="flex min-h-11 items-center gap-3" to="/devices">
            <span className="grid size-10 place-items-center rounded-xl bg-teal-700 text-white">
              <Icon icon={faSatelliteDish} label="Remote Control Hub" />
            </span>
            <div>
              <p className="text-sm font-semibold">Remote Control Hub</p>
              <p className="text-muted text-xs">安全设备控制中心</p>
            </div>
          </Link>
          <div className="flex items-center gap-2">
            <Link className="button-icon" to="/settings">
              <Icon icon={faGear} label="设置" />
            </Link>
            <button
              className="button-icon"
              onClick={() => void logout()}
              type="button"
            >
              <Icon icon={faArrowRightFromBracket} label="退出登录" />
            </button>
          </div>
        </div>
      </header>
      <div className="mx-auto grid max-w-7xl gap-6 px-4 py-5 md:grid-cols-[13rem_minmax(0,1fr)]">
        <aside className="hidden md:block">
          <nav aria-label="主导航" className="space-y-1">
            {PRIMARY_NAVIGATION.map((item) => (
              <NavLink
                className={navClass}
                key={item.to}
                to={item.to}
                {...(item.end === undefined ? {} : { end: item.end })}
              >
                <Icon icon={item.icon} />
                {item.label}
              </NavLink>
            ))}
          </nav>
          {session.role === "admin" && (
            <div className="mt-6 border-t border-slate-200 pt-4 dark:border-slate-800">
              <p className="text-muted mb-2 px-3 text-xs font-semibold uppercase tracking-wide">
                平台管理
              </p>
              <nav aria-label="平台管理" className="space-y-1">
                {ADMIN_NAVIGATION.map((item) => (
                  <NavLink
                    className={navClass}
                    key={item.to}
                    to={item.to}
                    {...(item.end === undefined ? {} : { end: item.end })}
                  >
                    <Icon icon={item.icon} />
                    {item.label}
                  </NavLink>
                ))}
              </nav>
            </div>
          )}
        </aside>
        <main className="min-w-0">
          <Outlet context={session} />
        </main>
      </div>
      <nav
        aria-label="移动端主导航"
        className="surface-header fixed inset-x-0 bottom-0 z-30 border-t px-3 pb-[env(safe-area-inset-bottom)] md:hidden"
      >
        <div className="mx-auto grid max-w-md grid-cols-3">
          {[
            PRIMARY_NAVIGATION[0],
            PRIMARY_NAVIGATION[1],
            PRIMARY_NAVIGATION[3],
          ].map((item) =>
            item === undefined ? null : (
              <NavLink
                className={({ isActive }) =>
                  `flex min-h-14 flex-col items-center justify-center gap-1 text-xs ${isActive ? "text-teal-700 dark:text-teal-300" : "text-muted"}`
                }
                key={item.to}
                to={item.to}
              >
                <Icon icon={item.icon} />
                {item.label}
              </NavLink>
            ),
          )}
        </div>
      </nav>
    </div>
  );
}
