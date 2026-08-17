import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import App from "./App.js";

describe("Agent App", () => {
  it("renders the secure enrollment form", () => {
    const markup = renderToStaticMarkup(<App />);

    expect(markup).toContain("服务地址");
    expect(markup).toContain("设备注册码");
    expect(markup).toContain("disabled");
  });
});
