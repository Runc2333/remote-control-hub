import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useState } from "react";
import type { AgentMutation, AgentStatus } from "../types.js";

type AgentStatusController = {
  mutation: AgentMutation | undefined;
  mutationError: string | undefined;
  refreshStatus: () => Promise<void>;
  register: (
    serviceOrigin: string,
    enrollmentToken: string,
  ) => Promise<boolean>;
  status: AgentStatus | undefined;
  statusError: boolean;
  unregister: () => Promise<void>;
};

export const useAgentStatus = (): AgentStatusController => {
  const [status, setStatus] = useState<AgentStatus>();
  const [statusError, setStatusError] = useState(false);
  const [mutation, setMutation] = useState<AgentMutation>();
  const [mutationError, setMutationError] = useState<string>();

  const refreshStatus = useCallback(async (): Promise<void> => {
    try {
      setStatus(await invoke<AgentStatus>("get_agent_status"));
      setStatusError(false);
    } catch {
      setStatus(undefined);
      setStatusError(true);
    }
  }, []);

  useEffect(() => {
    const initial = window.setTimeout(() => void refreshStatus(), 0);
    const timer = window.setInterval(() => void refreshStatus(), 5_000);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(timer);
    };
  }, [refreshStatus]);

  const register = async (
    serviceOrigin: string,
    enrollmentToken: string,
  ): Promise<boolean> => {
    setMutation("register");
    setMutationError(undefined);
    try {
      await invoke<string>("register_agent", {
        enrollmentToken,
        serviceOrigin,
      });
      await refreshStatus();
      return true;
    } catch (reason: unknown) {
      setMutationError(String(reason));
      return false;
    } finally {
      setMutation(undefined);
    }
  };

  const unregister = async (): Promise<void> => {
    setMutation("unregister");
    setMutationError(undefined);
    try {
      await invoke("unregister_agent");
      await refreshStatus();
    } catch (reason: unknown) {
      setMutationError(String(reason));
    } finally {
      setMutation(undefined);
    }
  };

  return {
    mutation,
    mutationError,
    refreshStatus,
    register,
    status,
    statusError,
    unregister,
  };
};
