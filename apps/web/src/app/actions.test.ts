import { afterEach, describe, expect, it, vi } from "vitest";
import type { ActionFunctionArgs } from "react-router";
import { API_CLIENT } from "../lib/api-client.js";
import { registrationAction } from "./actions.js";

afterEach(() => vi.restoreAllMocks());

describe("注册路由操作", () => {
  it("提交经过类型检查的注册信息", async () => {
    const register = vi.spyOn(API_CLIENT, "register").mockResolvedValue({
      userId: "11111111-1111-4111-8111-111111111111",
    });
    const request = new Request("https://hub.example.com/register", {
      body: new URLSearchParams({
        identifier: "user@example.com",
        identifierType: "email",
        password: "long-password-value",
      }),
      method: "POST",
    });

    await expect(
      registrationAction({ request } as ActionFunctionArgs),
    ).resolves.toMatchObject({ kind: "succeeded" });
    expect(register).toHaveBeenCalledWith({
      identifier: "user@example.com",
      identifierType: "email",
      password: "long-password-value",
    });
  });

  it("拒绝不完整的表单数据", async () => {
    const register = vi.spyOn(API_CLIENT, "register");
    const request = new Request("https://hub.example.com/register", {
      body: new URLSearchParams({ identifierType: "email" }),
      method: "POST",
    });

    await expect(
      registrationAction({ request } as ActionFunctionArgs),
    ).resolves.toMatchObject({ kind: "failed" });
    expect(register).not.toHaveBeenCalled();
  });
});
