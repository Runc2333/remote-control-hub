import { describe, expect, it } from "vitest";
import { getAdministratorValidationError } from "../setup/administrator-validation.js";

describe("getAdministratorValidationError", () => {
  it("explains incomplete administrator fields", () => {
    expect(getAdministratorValidationError("", "password", "password")).toBe(
      "请输入有效的管理员登录标识。",
    );
    expect(
      getAdministratorValidationError(
        "admin@example.com",
        "password",
        "password",
      ),
    ).toBe("管理员密码至少需要 12 个字符。");
    expect(
      getAdministratorValidationError(
        "admin@example.com",
        "long-enough-password",
        "different-password",
      ),
    ).toBe("两次输入的管理员密码不一致。");
  });

  it("accepts matching administrator credentials", () => {
    expect(
      getAdministratorValidationError(
        " admin@example.com ",
        "long-enough-password",
        "long-enough-password",
      ),
    ).toBeUndefined();
  });
});
