import { ApiError } from "@remote-control-hub/api-client";
import type { Session } from "@remote-control-hub/contracts";
import type { LoaderFunctionArgs } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { API_CLIENT } from "../lib/api-client.js";
import { administratorLoader, authenticatedLoader } from "./bootstrap.js";
import { registrationModeLoader } from "./loaders.js";

const SESSION: Session = {
  authStrength: "password",
  browser: "Chrome",
  createdAt: "2026-08-17T10:00:00.000+08:00",
  current: true,
  deviceType: "desktop",
  expiresAt: "2026-09-16T10:00:00.000+08:00",
  id: "11111111-1111-4111-8111-111111111111",
  ipAddress: "127.0.0.1",
  lastActiveAt: "2026-08-17T10:00:00.000+08:00",
  location: "本地",
  operatingSystem: "Windows",
  role: "user",
};

const LOADER_ARGS = {
  params: {},
  request: new Request("https://hub.example.com/devices"),
} as LoaderFunctionArgs;

afterEach(() => vi.restoreAllMocks());

describe("路由权限守卫", () => {
  it("允许已登录会话加载普通页面", async () => {
    vi.spyOn(API_CLIENT, "getSessions").mockResolvedValue({
      sessions: [SESSION],
    });

    await expect(
      authenticatedLoader(async () => "loaded")(LOADER_ARGS),
    ).resolves.toBe("loaded");
  });

  it("阻止普通用户加载管理员数据", async () => {
    vi.spyOn(API_CLIENT, "getSessions").mockResolvedValue({
      sessions: [SESSION],
    });

    await expect(
      administratorLoader(async () => "admin-data")(LOADER_ARGS),
    ).rejects.toMatchObject({ status: 302 });
  });

  it("将失效会话重定向到登录页", async () => {
    vi.spyOn(API_CLIENT, "getSessions").mockRejectedValue(new ApiError(401));

    await expect(
      authenticatedLoader(async () => "loaded")(LOADER_ARGS),
    ).rejects.toMatchObject({ status: 302 });
  });
});

describe("注册策略兼容", () => {
  it("旧版服务缺少公开端点时安全降级为关闭注册", async () => {
    vi.spyOn(API_CLIENT, "getPublicRegistrationMode").mockRejectedValue(
      new ApiError(404),
    );

    await expect(registrationModeLoader()).resolves.toEqual({ mode: "closed" });
  });

  it("不隐藏公开注册端点的服务错误", async () => {
    vi.spyOn(API_CLIENT, "getPublicRegistrationMode").mockRejectedValue(
      new ApiError(503),
    );

    await expect(registrationModeLoader()).rejects.toMatchObject({
      status: 503,
    });
  });
});
