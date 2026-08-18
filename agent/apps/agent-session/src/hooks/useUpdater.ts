import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useState } from "react";
import type {
  AppInfo,
  DiagnosticLog,
  UpdateCheck,
  UpdateSettings,
} from "../types.js";

export type UpdaterController = {
  appInfo?: AppInfo;
  checkForUpdates: (force: boolean) => Promise<void>;
  error?: string;
  loadLogs: () => Promise<void>;
  logs?: DiagnosticLog[];
  openRelease: () => Promise<void>;
  pending: boolean;
  skipCurrentUpdate: () => Promise<void>;
  toggleAutomaticChecks: () => Promise<void>;
  updateCheck?: UpdateCheck;
  updateSettings?: UpdateSettings;
};

export const useUpdater = (): UpdaterController => {
  const [appInfo, setAppInfo] = useState<AppInfo>();
  const [updateSettings, setUpdateSettings] = useState<UpdateSettings>();
  const [updateCheck, setUpdateCheck] = useState<UpdateCheck>();
  const [pending, setPending] = useState(false);
  const [logs, setLogs] = useState<DiagnosticLog[]>();
  const [error, setError] = useState<string>();

  const checkForUpdates = useCallback(async (force: boolean): Promise<void> => {
    setPending(true);
    if (force) {
      setError(undefined);
    }
    try {
      setUpdateCheck(await invoke<UpdateCheck>("check_for_updates", { force }));
    } catch (reason: unknown) {
      if (force) {
        setError(String(reason));
      }
    } finally {
      setPending(false);
    }
  }, []);

  useEffect(() => {
    const initial = window.setTimeout(() => {
      void invoke<AppInfo>("get_app_info").then(setAppInfo);
      void invoke<UpdateSettings>("get_update_settings").then(
        setUpdateSettings,
      );
      void checkForUpdates(false);
    }, 0);
    return () => window.clearTimeout(initial);
  }, [checkForUpdates]);

  const toggleAutomaticChecks = async (): Promise<void> => {
    if (updateSettings === undefined) {
      return;
    }
    setError(undefined);
    try {
      setUpdateSettings(
        await invoke<UpdateSettings>("set_automatic_update_checks", {
          enabled: !updateSettings.automaticChecksEnabled,
        }),
      );
    } catch (reason: unknown) {
      setError(String(reason));
    }
  };

  const skipCurrentUpdate = async (): Promise<void> => {
    if (updateCheck?.tag === undefined) {
      return;
    }
    setError(undefined);
    try {
      setUpdateSettings(
        await invoke<UpdateSettings>("skip_update", { tag: updateCheck.tag }),
      );
      setUpdateCheck({ ...updateCheck, status: "skipped" });
    } catch (reason: unknown) {
      setError(String(reason));
    }
  };

  const openRelease = async (): Promise<void> => {
    if (updateCheck?.tag === undefined) {
      return;
    }
    try {
      await invoke("open_release_page", { tag: updateCheck.tag });
    } catch (reason: unknown) {
      setError(String(reason));
    }
  };

  const loadLogs = async (): Promise<void> => {
    setLogs(await invoke<DiagnosticLog[]>("get_diagnostic_logs"));
  };

  return {
    appInfo,
    checkForUpdates,
    error,
    loadLogs,
    logs,
    openRelease,
    pending,
    skipCurrentUpdate,
    toggleAutomaticChecks,
    updateCheck,
    updateSettings,
  };
};
