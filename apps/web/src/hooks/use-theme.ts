import { useEffect, useState } from "react";
import {
  applyThemePreference,
  readThemePreference,
  saveThemePreference,
  THEME_CHANGE_EVENT,
  THEME_STORAGE_KEY,
  type ThemePreference,
} from "../lib/theme.js";

export const useTheme = () => {
  const [preference, setPreference] =
    useState<ThemePreference>(readThemePreference);

  useEffect(() => {
    applyThemePreference(preference);
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const update = (): void => {
      if (preference === "system") {
        applyThemePreference(preference);
      }
    };
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, [preference]);

  useEffect(() => {
    const syncPreference = (event: Event): void => {
      if (
        event instanceof CustomEvent &&
        (event.detail === "light" ||
          event.detail === "dark" ||
          event.detail === "system")
      ) {
        setPreference(event.detail);
      }
    };
    const syncStorage = (event: StorageEvent): void => {
      if (event.key === null || event.key === THEME_STORAGE_KEY) {
        setPreference(readThemePreference());
      }
    };
    window.addEventListener(THEME_CHANGE_EVENT, syncPreference);
    window.addEventListener("storage", syncStorage);
    return () => {
      window.removeEventListener(THEME_CHANGE_EVENT, syncPreference);
      window.removeEventListener("storage", syncStorage);
    };
  }, []);

  const updatePreference = (next: ThemePreference): void => {
    saveThemePreference(next);
    setPreference(next);
  };

  return { preference, updatePreference };
};
