import { faSatelliteDish } from "@fortawesome/free-solid-svg-icons";
import { Icon } from "@remote-control-hub/ui";

export function AppLoadingPage() {
  return (
    <main className="grid min-h-screen place-items-center px-4" role="status">
      <div className="text-center">
        <span className="mx-auto grid size-12 place-items-center rounded-xl bg-teal-700 text-white shadow-sm">
          <Icon icon={faSatelliteDish} label="Remote Control Hub" />
        </span>
        <p className="mt-4 font-medium">正在检查服务状态…</p>
        <p className="text-muted mt-1 text-sm">正在安全加载控制中心</p>
      </div>
    </main>
  );
}
