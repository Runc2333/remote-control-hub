import { Outlet, ScrollRestoration } from "react-router";
import { AppUpdateStatus } from "../components/AppUpdateStatus.js";
import { useTheme } from "../hooks/use-theme.js";

export function RootLayout() {
  useTheme();
  return (
    <>
      <Outlet />
      <ScrollRestoration />
      <AppUpdateStatus />
    </>
  );
}
