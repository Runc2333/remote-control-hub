import { describe, expect, it } from "vitest";
import { resolveTheme } from "./theme.js";

describe("主题解析", () => {
  it("允许显式主题覆盖系统偏好", () => {
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
  });

  it("跟随系统深浅色偏好", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
  });
});
