import {
  faLink,
  faSatelliteDish,
  faSliders,
  faWrench,
} from "@fortawesome/free-solid-svg-icons";
import { Icon } from "@remote-control-hub/ui";
import { useState } from "react";
import "./App.css";
import { AgentHeader } from "./components/AgentHeader.js";
import { ConnectionPanel } from "./components/ConnectionPanel.js";
import { LocalControlsPanel } from "./components/LocalControlsPanel.js";
import { MaintenancePanel } from "./components/MaintenancePanel.js";
import { UpdateNotice } from "./components/UpdateNotice.js";
import { useAgentStatus } from "./hooks/useAgentStatus.js";
import { useUpdater } from "./hooks/useUpdater.js";

type AgentView = "connection" | "controls" | "maintenance";

const NAVIGATION_ITEMS = [
  { icon: faLink, id: "connection", label: "连接" },
  { icon: faSliders, id: "controls", label: "本机控制" },
  { icon: faWrench, id: "maintenance", label: "维护" },
] as const;

function App() {
  const [activeView, setActiveView] = useState<AgentView>("connection");
  const agent = useAgentStatus();
  const updater = useUpdater();

  return (
    <main className="app-shell min-h-screen p-4 sm:p-6">
      <div className="mx-auto max-w-3xl">
        <AgentHeader status={agent.status} statusError={agent.statusError} />

        <nav aria-label="Agent 功能" className="app-navigation">
          {NAVIGATION_ITEMS.map((item) => (
            <button
              aria-current={activeView === item.id ? "page" : undefined}
              className="navigation-button"
              key={item.id}
              onClick={() => setActiveView(item.id)}
              type="button"
            >
              <Icon icon={item.icon} />
              {item.label}
              {item.id === "maintenance" &&
              updater.updateCheck?.status === "update_available" ? (
                <span className="update-dot" aria-label="有可用更新" />
              ) : null}
            </button>
          ))}
        </nav>

        <UpdateNotice
          onOpenRelease={updater.openRelease}
          onSkip={updater.skipCurrentUpdate}
          updateCheck={updater.updateCheck}
        />

        <div className="mt-4">
          {activeView === "connection" ? (
            <ConnectionPanel
              error={agent.mutationError}
              mutation={agent.mutation}
              onRefresh={agent.refreshStatus}
              onRegister={agent.register}
              onUnregister={agent.unregister}
              status={agent.status}
              statusError={agent.statusError}
            />
          ) : null}
          {activeView === "controls" ? <LocalControlsPanel /> : null}
          {activeView === "maintenance" ? (
            <MaintenancePanel updater={updater} />
          ) : null}
        </div>

        <p className="mt-4 text-center text-xs text-slate-500">
          <Icon icon={faSatelliteDish} /> 关闭窗口后 Agent 将继续在系统托盘运行
        </p>
      </div>
    </main>
  );
}

export default App;
