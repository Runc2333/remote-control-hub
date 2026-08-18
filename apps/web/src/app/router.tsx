import { createBrowserRouter } from "react-router";
import { registrationAction } from "./actions.js";
import {
  administratorLoader,
  authenticatedLoader,
  bootstrapLoader,
} from "./bootstrap.js";
import {
  adminAuditLoader,
  adminDevicesLoader,
  adminOverviewLoader,
  adminUsersLoader,
  auditLoader,
  commandsLoader,
  deviceDetailLoader,
  devicesLoader,
  registrationModeLoader,
  sessionsLoader,
} from "./loaders.js";
import { AdminLayout } from "../layouts/AdminLayout.js";
import { AppLayout } from "../layouts/AppLayout.js";
import { AuthLayout } from "../layouts/AuthLayout.js";
import { RootLayout } from "../layouts/RootLayout.js";
import { SetupLayout } from "../layouts/SetupLayout.js";
import { AdminAuditPage } from "../pages/admin/AdminAuditPage.js";
import { AdminDevicesPage } from "../pages/admin/AdminDevicesPage.js";
import { AdminOverviewPage } from "../pages/admin/AdminOverviewPage.js";
import { AdminUsersPage } from "../pages/admin/AdminUsersPage.js";
import { AuditPage } from "../pages/AuditPage.js";
import { AppLoadingPage } from "../pages/AppLoadingPage.js";
import { CommandsPage } from "../pages/CommandsPage.js";
import { DeviceDetailPage } from "../pages/DeviceDetailPage.js";
import { DeviceEnrollmentPage } from "../pages/DeviceEnrollmentPage.js";
import { DevicesPage } from "../pages/DevicesPage.js";
import { IndexPage } from "../pages/IndexPage.js";
import { LoginPage } from "../pages/LoginPage.js";
import { NotFoundPage } from "../pages/NotFoundPage.js";
import { PageRouteError } from "../pages/PageRouteError.js";
import { RegisterPage } from "../pages/RegisterPage.js";
import { RouteErrorPage } from "../pages/RouteErrorPage.js";
import { SecurityPage } from "../pages/SecurityPage.js";
import { SessionsPage } from "../pages/SessionsPage.js";
import { SettingsPage } from "../pages/SettingsPage.js";
import { SetupPage } from "../pages/SetupPage.js";

export const APP_ROUTES = [
  {
    Component: RootLayout,
    ErrorBoundary: RouteErrorPage,
    HydrateFallback: AppLoadingPage,
    children: [
      { Component: IndexPage, index: true },
      {
        Component: SetupLayout,
        children: [{ Component: SetupPage, path: "setup" }],
      },
      {
        Component: AuthLayout,
        children: [
          {
            Component: LoginPage,
            ErrorBoundary: PageRouteError,
            loader: registrationModeLoader,
            path: "login",
          },
          {
            action: registrationAction,
            Component: RegisterPage,
            ErrorBoundary: PageRouteError,
            loader: registrationModeLoader,
            path: "register",
          },
        ],
      },
      {
        Component: AppLayout,
        children: [
          {
            Component: DevicesPage,
            ErrorBoundary: PageRouteError,
            loader: authenticatedLoader(devicesLoader),
            path: "devices",
          },
          { Component: DeviceEnrollmentPage, path: "devices/enroll" },
          {
            Component: DeviceDetailPage,
            ErrorBoundary: PageRouteError,
            loader: authenticatedLoader(deviceDetailLoader),
            path: "devices/:deviceId",
          },
          {
            Component: CommandsPage,
            ErrorBoundary: PageRouteError,
            loader: authenticatedLoader(commandsLoader),
            path: "commands",
          },
          {
            Component: SessionsPage,
            ErrorBoundary: PageRouteError,
            loader: authenticatedLoader(sessionsLoader),
            path: "sessions",
          },
          {
            Component: AuditPage,
            ErrorBoundary: PageRouteError,
            loader: authenticatedLoader(auditLoader),
            path: "audit",
          },
          { Component: SettingsPage, path: "settings" },
          { Component: SecurityPage, path: "settings/security" },
          {
            Component: AdminLayout,
            children: [
              {
                Component: AdminOverviewPage,
                ErrorBoundary: PageRouteError,
                loader: administratorLoader(adminOverviewLoader),
                path: "admin",
              },
              {
                Component: AdminUsersPage,
                ErrorBoundary: PageRouteError,
                loader: administratorLoader(adminUsersLoader),
                path: "admin/users",
              },
              {
                Component: AdminDevicesPage,
                ErrorBoundary: PageRouteError,
                loader: administratorLoader(adminDevicesLoader),
                path: "admin/devices",
              },
              {
                Component: AdminAuditPage,
                ErrorBoundary: PageRouteError,
                loader: administratorLoader(adminAuditLoader),
                path: "admin/audit",
              },
            ],
          },
        ],
      },
      { Component: NotFoundPage, path: "*" },
    ],
    id: "root",
    loader: bootstrapLoader,
    path: "/",
  },
] satisfies Parameters<typeof createBrowserRouter>[0];

export const createAppRouter = () => createBrowserRouter(APP_ROUTES);
