import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import App from "./App.js";

describe("Web App", () => {
  it("renders a useful shell before API state resolves", () => {
    const markup = renderToStaticMarkup(<App />);

    expect(markup).toContain("Remote Control Hub");
    expect(markup).toContain("正在检查服务状态");
  });
});
