import {
  faBan,
  faExternalLink,
  faRotate,
} from "@fortawesome/free-solid-svg-icons";
import { Icon } from "@remote-control-hub/ui";
import type { UpdateCheck } from "../types.js";

type UpdateNoticeProps = {
  onOpenRelease: () => Promise<void>;
  onSkip: () => Promise<void>;
  updateCheck?: UpdateCheck;
};

export const UpdateNotice = ({
  onOpenRelease,
  onSkip,
  updateCheck,
}: UpdateNoticeProps) =>
  updateCheck?.status === "update_available" ? (
    <section aria-live="polite" className="update-notice">
      <span className="mt-0.5 text-teal-700">
        <Icon icon={faRotate} />
      </span>
      <div className="min-w-0 flex-1">
        <h2 className="font-semibold">发现新版本 {updateCheck.tag}</h2>
        <p className="mt-1 text-sm text-slate-600">
          Agent 不会自动安装更新，请前往发布页面手动升级。
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        <button
          className="control-button border-teal-700! bg-teal-700! text-white!"
          onClick={() => void onOpenRelease()}
          type="button"
        >
          <Icon icon={faExternalLink} />
          查看版本
        </button>
        <button
          className="control-button"
          onClick={() => void onSkip()}
          type="button"
        >
          <Icon icon={faBan} />
          跳过
        </button>
      </div>
    </section>
  ) : null;
