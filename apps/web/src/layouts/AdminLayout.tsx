import { Navigate, Outlet } from "react-router";
import { useCurrentSession } from "../hooks/use-current-session.js";
import { useSessionAutoRenewal } from "../hooks/use-session-auto-renewal.js";

export function AdminLayout() {
  const session = useCurrentSession();

  // Enable automatic session renewal
  useSessionAutoRenewal();

  if (session.role !== "admin") {
    return <Navigate replace to="/devices" />;
  }

  return <Outlet context={session} />;
}
