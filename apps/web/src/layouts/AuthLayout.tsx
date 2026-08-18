import { faSatelliteDish } from "@fortawesome/free-solid-svg-icons";
import { Icon } from "@remote-control-hub/ui";
import { Outlet } from "react-router";

export function AuthLayout() {
  return (
    <main className="grid min-h-screen place-items-center px-4 py-8">
      <div className="w-full max-w-md space-y-4">
        <div className="flex items-center justify-center gap-3">
          <span className="grid size-11 place-items-center rounded-xl bg-teal-700 text-white">
            <Icon icon={faSatelliteDish} label="Remote Control Hub" />
          </span>
          <div>
            <h1 className="font-semibold">Remote Control Hub</h1>
            <p className="text-muted text-xs">安全设备控制中心</p>
          </div>
        </div>
        <Outlet />
      </div>
    </main>
  );
}
