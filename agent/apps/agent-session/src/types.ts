export type AgentStatus = {
  connected: boolean;
  deviceId?: string;
  registered: boolean;
  serviceOrigin?: string;
};

export type AppInfo = {
  buildTime: string;
  commit: string;
  repositoryConfigured: boolean;
  version: string;
};

export type UpdateSettings = {
  automaticChecksEnabled: boolean;
  skippedTag?: string;
};

export type UpdateCheck = {
  checkedAt?: number;
  currentVersion: string;
  releaseName?: string;
  repositoryConfigured: boolean;
  status:
    "disabled" | "not_checked" | "skipped" | "up_to_date" | "update_available";
  tag?: string;
};

export type DiagnosticLog = {
  code: string;
  occurredAt: number;
};

export type AgentMutation = "register" | "unregister";
