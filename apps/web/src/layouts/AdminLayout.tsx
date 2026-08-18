import { Navigate, Outlet } from "react-router";
import { useCurrentSession } from "../hooks/use-current-session.js";

export function AdminLayout() {
  const session = useCurrentSession();
  if (session.role !== "admin") {
    return <Navigate replace to="/devices" />;
  }
  return <Outlet context={session} />;
}
