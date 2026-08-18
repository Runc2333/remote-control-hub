export const THEME_STORAGE_KEY = "rch-theme";
export const THEME_CHANGE_EVENT = "rch-theme-change";

export type ThemePreference = "dark" | "light" | "system";

export const resolveTheme = (
  preference: ThemePreference,
  systemDark: boolean,
): "dark" | "light" =>
  preference === "dark" || (preference === "system" && systemDark)
    ? "dark"
    : "light";

const isThemePreference = (value: string | null): value is ThemePreference =>
  value === "dark" || value === "light" || value === "system";

export const readThemePreference = (): ThemePreference => {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    return isThemePreference(stored) ? stored : "system";
  } catch {
    return "system";
  }
};

export const applyThemePreference = (preference: ThemePreference): void => {
  const dark =
    resolveTheme(
      preference,
      window.matchMedia("(prefers-color-scheme: dark)").matches,
    ) === "dark";
  document.documentElement.classList.toggle("dark", dark);
  document.documentElement.dataset.theme = preference;
  document.documentElement.style.colorScheme = dark ? "dark" : "light";
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", dark ? "#0f172a" : "#0f766e");
};

export const saveThemePreference = (preference: ThemePreference): void => {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, preference);
  } catch {
    applyThemePreference(preference);
    window.dispatchEvent(
      new CustomEvent(THEME_CHANGE_EVENT, { detail: preference }),
    );
    return;
  }
  applyThemePreference(preference);
  window.dispatchEvent(
    new CustomEvent(THEME_CHANGE_EVENT, { detail: preference }),
  );
};
