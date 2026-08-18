import { Navigate, useRouteLoaderData } from "react-router";
import type { BootstrapData } from "../app/bootstrap.js";
import { currentSession } from "../app/bootstrap.js";

export function IndexPage() {
  const bootstrap = useRouteLoaderData("root") as BootstrapData;
  if (!bootstrap.setup.installed) {
    return <Navigate replace to="/setup" />;
  }
  return (
    <Navigate
      replace
      to={currentSession(bootstrap) === undefined ? "/login" : "/devices"}
    />
  );
}
