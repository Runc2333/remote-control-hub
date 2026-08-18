import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import App from "./App.js";
import { ConnectionPanel } from "./components/ConnectionPanel.js";

describe("Agent App", () => {
  it("renders separate navigation views", () => {
    const markup = renderToStaticMarkup(<App />);

    expect(markup).toContain("Agent 功能");
    expect(markup).toContain("本机控制");
    expect(markup).toContain("维护");
  });

  it("renders enrollment and unregistration states", () => {
    const enrollment = renderToStaticMarkup(
      <ConnectionPanel
        onRefresh={async () => undefined}
        onRegister={async () => true}
        onUnregister={async () => undefined}
        status={{ connected: false, registered: false }}
        statusError={false}
      />,
    );
    const registered = renderToStaticMarkup(
      <ConnectionPanel
        onRefresh={async () => undefined}
        onRegister={async () => true}
        onUnregister={async () => undefined}
        status={{ connected: true, registered: true }}
        statusError={false}
      />,
    );

    expect(enrollment).toContain("服务地址");
    expect(enrollment).toContain("设备注册码");
    expect(enrollment).toContain("disabled");
    expect(registered).toContain("解绑设备");
  });
});
