import { useEffect } from "react";
import { API_CLIENT } from "../lib/api-client.js";

const SESSION_RENEWAL_INTERVAL = 60 * 60 * 1000; // 1 hour

export const useSessionAutoRenewal = (): void => {
  useEffect(() => {
    const renewSession = async (): Promise<void> => {
      try {
        await API_CLIENT.getSessions();
      } catch {
        // Ignore errors, authentication will be handled by other components
      }
    };

    const intervalId = setInterval(renewSession, SESSION_RENEWAL_INTERVAL);
    
    // Initial renewal on mount
    void renewSession();

    return () => clearInterval(intervalId);
  }, []);
};