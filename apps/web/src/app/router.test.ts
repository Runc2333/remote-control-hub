import { describe, expect, it } from "vitest";
import { matchRoutes } from "react-router";
import { APP_ROUTES } from "./router.js";

const EXPECTED_PATHS = [
  "/setup",
  "/login",
  "/register",
  "/devices",
  "/devices/enroll",
  "/devices/11111111-1111-4111-8111-111111111111",
  "/commands",
  "/sessions",
  "/audit",
  "/settings",
  "/settings/security",
  "/admin",
  "/admin/users",
  "/admin/devices",
  "/admin/audit",
] as const;

describe("Web App 路由", () => {
  it.each(EXPECTED_PATHS)("匹配深链接 %s", (path) => {
    expect(matchRoutes(APP_ROUTES, path)).not.toBeNull();
  });

  it("由兜底页面处理未知地址", () => {
    const matches = matchRoutes(APP_ROUTES, "/unknown/deep-link");
    expect(matches?.at(-1)?.route.path).toBe("*");
  });

  it.each(["/devices", "/commands", "/sessions", "/admin/users"])(
    "为数据页面隔离加载错误 %s",
    (path) => {
      expect(
        matchRoutes(APP_ROUTES, path)?.at(-1)?.route.ErrorBoundary,
      ).toBeDefined();
    },
  );
});
