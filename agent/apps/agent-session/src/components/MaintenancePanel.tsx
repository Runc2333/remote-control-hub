import {
  faClock,
  faCodeBranch,
  faList,
  faRotate,
} from "@fortawesome/free-solid-svg-icons";
import { Icon } from "@remote-control-hub/ui";
import type { UpdaterController } from "../hooks/useUpdater.js";

type MaintenancePanelProps = {
  updater: UpdaterController;
};

const localTime = (seconds?: number): string =>
  seconds === undefined
    ? "尚未检查"
    : new Date(seconds * 1_000).toLocaleString();

const UPDATE_STATUS_LABELS: Record<
  NonNullable<UpdaterController["updateCheck"]>["status"],
  string
> = {
  disabled: "已关闭",
  not_checked: "尚未检查",
  skipped: "已跳过当前版本",
  up_to_date: "已是最新版本",
  update_available: "有可用更新",
};

export const MaintenancePanel = ({ updater }: MaintenancePanelProps) => (
  <div className="space-y-4">
    <section className="panel-card">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="section-eyebrow">客户端</p>
          <h2 className="mt-1 text-xl font-semibold">版本与更新</h2>
          <p className="mt-1 text-sm text-slate-500">
            当前版本 {updater.appInfo?.version ?? "未知"}
          </p>
        </div>
        <button
          className="control-button"
          disabled={updater.pending || !updater.appInfo?.repositoryConfigured}
          onClick={() => void updater.checkForUpdates(true)}
          type="button"
        >
          <Icon icon={faRotate} />
          {updater.pending ? "检查中…" : "立即检查"}
        </button>
      </div>
      <dl className="detail-grid mt-5">
        <div className="detail-item">
          <dt>
            <Icon icon={faCodeBranch} /> 提交
          </dt>
          <dd className="font-mono text-xs">
            {updater.appInfo?.commit ?? "未知"}
          </dd>
        </div>
        <div className="detail-item">
          <dt>
            <Icon icon={faClock} /> 构建时间
          </dt>
          <dd className="text-xs">{updater.appInfo?.buildTime ?? "未知"}</dd>
        </div>
        <div className="detail-item">
          <dt>最近检查</dt>
          <dd>{localTime(updater.updateCheck?.checkedAt)}</dd>
        </div>
        <div className="detail-item">
          <dt>检查结果</dt>
          <dd>
            {updater.updateCheck === undefined
              ? "尚未检查"
              : UPDATE_STATUS_LABELS[updater.updateCheck.status]}
          </dd>
        </div>
      </dl>
      <label className="mt-4 flex min-h-11 items-center gap-3 text-sm">
        <input
          checked={updater.updateSettings?.automaticChecksEnabled ?? false}
          disabled={
            updater.updateSettings === undefined ||
            !updater.appInfo?.repositoryConfigured
          }
          onChange={() => void updater.toggleAutomaticChecks()}
          type="checkbox"
        />
        每天自动检查一次最新稳定版本
      </label>
      {!updater.appInfo?.repositoryConfigured ? (
        <p className="mt-2 text-sm text-amber-700">
          此构建未配置公开 GitHub 仓库，更新检查保持关闭。
        </p>
      ) : null}
      {updater.error === undefined ? null : (
        <p className="mt-2 text-sm text-red-700" role="alert">
          更新操作失败：{updater.error}
        </p>
      )}
    </section>

    <section className="panel-card">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="section-eyebrow">故障排查</p>
          <h2 className="mt-1 text-xl font-semibold">脱敏诊断日志</h2>
          <p className="mt-1 text-sm text-slate-500">
            仅显示时间和错误码，不记录令牌或设备密钥。
          </p>
        </div>
        <button
          className="control-button shrink-0"
          onClick={() => void updater.loadLogs()}
          type="button"
        >
          <Icon icon={faList} />
          {updater.logs === undefined ? "查看" : "刷新"}
        </button>
      </div>
      {updater.logs === undefined ? null : updater.logs.length === 0 ? (
        <p className="mt-4 text-sm text-slate-500">暂无诊断事件。</p>
      ) : (
        <ul className="mt-4 max-h-40 space-y-2 overflow-auto font-mono text-xs">
          {updater.logs.map((entry, index) => (
            <li
              className="rounded-lg bg-slate-50 p-2.5"
              key={`${entry.occurredAt}-${index}`}
            >
              {localTime(entry.occurredAt)} · {entry.code}
            </li>
          ))}
        </ul>
      )}
    </section>
  </div>
);
