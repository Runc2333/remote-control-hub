import {
  faChevronRight,
  faClockRotateLeft,
  faComputer,
  faGauge,
  faMoon,
  faShieldHalved,
  faSun,
  faUserGroup,
} from "@fortawesome/free-solid-svg-icons";
import { Icon } from "@remote-control-hub/ui";
import { Link } from "react-router";
import { PageHeader } from "../components/PageHeader.js";
import { useCurrentSession } from "../hooks/use-current-session.js";
import { useTheme } from "../hooks/use-theme.js";
import type { ThemePreference } from "../lib/theme.js";

const THEMES: readonly {
  icon: Parameters<typeof Icon>[0]["icon"];
  label: string;
  value: ThemePreference;
}[] = [
  { icon: faComputer, label: "跟随系统", value: "system" },
  { icon: faSun, label: "浅色", value: "light" },
  { icon: faMoon, label: "深色", value: "dark" },
];

export function SettingsPage() {
  const { preference, updatePreference } = useTheme();
  const session = useCurrentSession();
  return (
    <>
      <PageHeader description="外观偏好仅保存在当前设备。" title="设置" />
      <section className="surface-card p-4">
        <h2 className="font-semibold">外观</h2>
        <div className="mt-3 grid gap-2 sm:grid-cols-3">
          {THEMES.map((theme) => (
            <label
              className={`flex min-h-14 cursor-pointer items-center gap-3 rounded-lg border px-3 ${preference === theme.value ? "border-teal-600 bg-teal-50 text-teal-950 dark:border-teal-400 dark:bg-teal-950 dark:text-teal-50" : "border-slate-300 dark:border-slate-700"}`}
              key={theme.value}
            >
              <input
                checked={preference === theme.value}
                className="accent-teal-700"
                name="theme"
                onChange={() => updatePreference(theme.value)}
                type="radio"
              />
              <Icon icon={theme.icon} />
              <span className="text-sm font-medium">{theme.label}</span>
            </label>
          ))}
        </div>
      </section>
      <section className="surface-card mt-4 divide-y divide-slate-200 overflow-hidden dark:divide-slate-800">
        <Link
          className="flex min-h-14 items-center gap-3 px-4 hover:bg-slate-50 dark:hover:bg-slate-800"
          to="/settings/security"
        >
          <Icon icon={faShieldHalved} />
          <span className="flex-1 font-medium">Passkey 与双重验证</span>
          <Icon icon={faChevronRight} />
        </Link>
        <Link
          className="flex min-h-14 items-center gap-3 px-4 hover:bg-slate-50 dark:hover:bg-slate-800"
          to="/sessions"
        >
          <Icon icon={faComputer} />
          <span className="flex-1 font-medium">活跃会话</span>
          <Icon icon={faChevronRight} />
        </Link>
        <Link
          className="flex min-h-14 items-center gap-3 px-4 hover:bg-slate-50 dark:hover:bg-slate-800"
          to="/audit"
        >
          <Icon icon={faClockRotateLeft} />
          <span className="flex-1 font-medium">我的安全审计</span>
          <Icon icon={faChevronRight} />
        </Link>
      </section>
      {session.role === "admin" && (
        <section className="surface-card mt-4 divide-y divide-slate-200 overflow-hidden dark:divide-slate-800">
          <Link
            className="flex min-h-14 items-center gap-3 px-4 hover:bg-slate-50 dark:hover:bg-slate-800"
            to="/admin"
          >
            <Icon icon={faGauge} />
            <span className="flex-1 font-medium">系统概览</span>
            <Icon icon={faChevronRight} />
          </Link>
          <Link
            className="flex min-h-14 items-center gap-3 px-4 hover:bg-slate-50 dark:hover:bg-slate-800"
            to="/admin/users"
          >
            <Icon icon={faUserGroup} />
            <span className="flex-1 font-medium">用户治理</span>
            <Icon icon={faChevronRight} />
          </Link>
          <Link
            className="flex min-h-14 items-center gap-3 px-4 hover:bg-slate-50 dark:hover:bg-slate-800"
            to="/admin/devices"
          >
            <Icon icon={faComputer} />
            <span className="flex-1 font-medium">设备治理</span>
            <Icon icon={faChevronRight} />
          </Link>
          <Link
            className="flex min-h-14 items-center gap-3 px-4 hover:bg-slate-50 dark:hover:bg-slate-800"
            to="/admin/audit"
          >
            <Icon icon={faShieldHalved} />
            <span className="flex-1 font-medium">系统安全审计</span>
            <Icon icon={faChevronRight} />
          </Link>
        </section>
      )}
    </>
  );
}
